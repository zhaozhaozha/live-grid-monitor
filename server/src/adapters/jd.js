import { BaseAdapter, AdapterError } from './base.js'
import { config } from '../config.js'

/**
 * 京东直播适配器（experimental）
 *
 * 现状（2026-09-03 真机实测）：
 *  - 京东直播 web 端入口是 lives.jd.com（Vue SPA，hash 路由 #/<liveId>），
 *    分享短链 3.cn / u.jd.com 会 302 跳转到 lives.jd.com?...#/47986537 形态。
 *  - 数据走 api.m.jd.com 网关（appid=h5-live），两个关键 functionId：
 *      getImmediatePlayToM —— 返回正在播/预告的房间与播放地址
 *        { code:'0', data:{ liveId, status, h5VideoUrl(flv), h5VideoUrl(m3u8),
 *                           videoUrl, nowTime, slide:{pre,next} } }
 *        实测匿名可调、无需 eid 指纹、无需登录 Cookie。
 *      liveDetailToM —— 房间详情（标题/主播等），实测匿名返回空，疑似需登录态。
 *  - 在线人数走推送通道（type:"get_statistics_result", body.total_viwer），
 *    非 REST 可轮询，1.0 不实现，onlineCount 返回 null。
 *  - 播放地址单一清晰度（_fhd），平台未提供更低档，取接口返回的唯一档。
 */
const GW = 'https://api.m.jd.com/client.action'
const APPID = 'h5-live'

export class JdAdapter extends BaseAdapter {
  static platform = 'jd'
  static label = '京东直播'
  static stability = 'experimental'
  static urlHints = [
    'https://3.cn/xxxx（App 分享短链，自动展开）',
    'https://lives.jd.com/#/47986537（直播间详情）',
    'https://live.jd.com/<liveId>',
  ]

  matchUrl(url) {
    // 域名边界：lives.jd.com / live.jd.com 用 .jd.com；3.cn / u.jd.com 前面是 // 或 .
    return /(^|[\/.:])jd\.com\b|(^|[\/.:])3\.cn\b|(^|[\/.:])u\.jd\.com\b/.test(url)
  }

  /** 支持：3.cn/u.jd.com 短链 / lives.jd.com hash 路由 / live.jd.com/<id> / live.html?id= */
  parseRoomId(url) {
    if (!url) return null
    // hash 路由：#/47986537?origin=2&appid=jdzb
    const hash = url.match(/#\/(\d{4,})/)
    if (hash) return hash[1]
    // 显式参数：?liveId= / ?id= / ?roomId= / ?room_id=
    const q = url.match(/[?&](?:liveId|id|roomId|room_id)=(\d{4,})/)
    if (q) return q[1]
    // 路径数字：live.jd.com/47986537 / lives.jd.com/47986537
    const p = url.match(/(?:live|lives)\.jd\.com\/(\d{4,})/)
    if (p) return p[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    // 短链只有一跳 302，BaseAdapter.resolveRedirect 足够；u.jd.com 偶尔多跳，多跟几次
    if (/(^|[\/.:])3\.cn\//.test(u)) {
      u = await this.resolveRedirect(u)
    } else if (/u\.jd\.com/.test(u)) {
      for (let i = 0; i < 4; i++) {
        const next = await this.resolveRedirect(u)
        if (next === u) break
        u = next
      }
    }
    return u
  }

  /** 调 api.m.jd.com 网关（POST，参数放 form body + query） */
  async #gateway(functionId, bodyObj, extraQs = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), config.requestTimeoutMs)
    try {
      const qs = new URLSearchParams({
        appid: APPID,
        functionId,
        t: String(Date.now()),
        ...extraQs,
      })
      const res = await fetch(`${GW}?${qs}`, {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          Referer: 'https://lives.jd.com/',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ body: JSON.stringify(bodyObj) }).toString(),
        signal: ac.signal,
      })
      if (!res.ok) {
        throw new AdapterError(`京东接口请求失败 HTTP ${res.status}`, {
          code: 'HTTP_ERROR',
          hint: res.status === 403 ? '疑似触发风控' : '',
        })
      }
      return await res.json()
    } catch (err) {
      if (err instanceof AdapterError) throw err
      if (err.name === 'AbortError') throw new AdapterError('京东接口请求超时', { code: 'TIMEOUT' })
      throw new AdapterError(`网络异常：${err.message}`, { code: 'NETWORK' })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 现行主接口：即时播放信息（流地址 + 直播状态），匿名可调 */
  async #immediatePlay(liveId) {
    const j = await this.#gateway('getImmediatePlayToM', {
      liveId: String(liveId),
      isLookupLiveId: true,
      pageId: 'liveRoom',
    })
    if (j.code !== '0' || !j.data) {
      throw new AdapterError(`京东接口返回异常：code=${j.code} subCode=${j.subCode}`, {
        code: 'API_ERROR',
        retryable: true,
        hint: '可稍后重试；若持续失败，请在浏览器打开直播间抓包用「直链」接入',
      })
    }
    return j.data
  }

  /** 从播放数据里取可播地址：优先 m3u8（H5 播放稳），回退 flv */
  #pickPlayUrl(data) {
    const hls = typeof data.h5VideoUrl === 'string' && data.h5VideoUrl.startsWith('http') ? data.h5VideoUrl : ''
    const flv =
      typeof data.videoUrl === 'string' && data.videoUrl.startsWith('http')
        ? data.videoUrl
        : typeof data.pcVideoUrl === 'string' && data.pcVideoUrl.startsWith('http')
          ? data.pcVideoUrl
          : ''
    if (hls) return { url: hls, format: 'hls' }
    if (flv) return { url: flv, format: 'flv' }
    return null
  }

  async fetchRoomInfo(url, opts = {}) {
    const normalized = await this.normalizeUrl(url)
    const liveId = this.parseRoomId(normalized)
    if (!liveId) {
      throw new AdapterError('无法从该链接解析出京东直播间 liveId', {
        code: 'PARSE_FAILED',
        retryable: false,
        hint: '支持：3.cn / u.jd.com 短链、lives.jd.com/#/<liveId>、live.jd.com/<liveId>',
      })
    }
    let data = null
    try {
      data = await this.#immediatePlay(liveId)
    } catch (err) {
      if (err instanceof AdapterError) {
        // 网关不可达/接口变更：仍保留占位房间，返回可操作错误信息
        return {
          roomId: liveId,
          title: '',
          anchorName: '',
          isLive: false,
          shareUrl: normalized,
          deprecated: true,
          message: err.message,
          hint: err.hint || '请在浏览器打开直播间抓包，用「直链」模式接入播放',
        }
      }
      throw err
    }
    // status: 1=直播中 2=预告/未开播（slide.next 里见过 status 2）
    const isLive = data.status === 1 || data.status === '1'
    const play = this.#pickPlayUrl(data)
    return {
      roomId: String(data.liveId || liveId),
      title: '', // liveDetailToM 需登录态，1.0 不取标题
      anchorName: '',
      isLive,
      shareUrl: normalized,
      raw: { data, play, liveId },
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    let raw
    if (opts.roomInfo?.raw?.data) {
      raw = opts.roomInfo.raw
    } else {
      const info = await this.fetchRoomInfo(
        `https://lives.jd.com/#/${roomId}`,
        opts
      )
      if (info.deprecated) {
        throw new AdapterError(info.message || '京东直播接口暂不可用', {
          code: 'API_DEPRECATED',
          retryable: false,
          hint: info.hint,
        })
      }
      raw = info.raw
    }
    const data = raw.data
    if (data.status !== 1 && data.status !== '1') {
      throw new AdapterError('主播当前未开播（预告状态）', { code: 'NOT_LIVE', retryable: false })
    }
    const play = raw.play || this.#pickPlayUrl(data)
    if (!play) {
      throw new AdapterError('接口未返回可播放的流地址', {
        code: 'NO_STREAM',
        retryable: false,
        hint: '请在浏览器打开该直播间抓包，将 .m3u8/.flv 用「直链」模式接入',
      })
    }
    return {
      url: play.url,
      format: play.format,
      quality: 'fhd', // 平台仅返回单档位，注释说明：服务端只下发该清晰度
      requestedQuality: 'lowest',
      qualities: [],
      expiresAt: Date.now() + 10 * 60 * 1000, // 拉流地址会轮换，短缓存即可
    }
  }

  async fetchMetrics(roomId, opts = {}) {
    // 在线人数走平台内部推送通道，无 REST 可轮询；1.0 仅上报是否在播
    let isLive = false
    try {
      const info = opts.roomInfo || (await this.fetchRoomInfo(`https://lives.jd.com/#/${roomId}`, opts))
      isLive = Boolean(info.isLive)
    } catch {
      /* 取不到就按不在播处理 */
    }
    return { isLive, onlineCount: null, likeCount: null }
  }
}
