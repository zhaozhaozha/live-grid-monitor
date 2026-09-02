import crypto from 'node:crypto'
import { BaseAdapter, AdapterError, pickLowestQuality } from './base.js'
import { config } from '../config.js'

/**
 * 淘宝直播适配器（experimental）
 *
 * 现状（2026-09-03 真机实测）：
 *  - tbzb.taobao.com/live?liveId=<id> 页面现行接口为 mtop.roomstudio.live.detail.get/1.0，
 *    老接口 mtop.mediaplatform.live.livedetail 已被风控（RGV587_ERROR）。
 *  - 关键机制：mtop 需要 _m_h5_tk token 签名；首次请求（空 token）会经 Set-Cookie
 *    下发 cookie2 / _m_h5_tk / _m_h5_tk_enc 三件套，需【完整带回】三者并重试一次，
 *    缺 _m_h5_tk_enc 或 cookie2 会 FAIL_SYS_ILLEGAL_ACCESS。
 *  - 实测匿名（无登录 Cookie）即可拿到直播间详情：流地址（liveUrl/liveUrlList
 *    多档 flv+m3u8）、viewCount/viewCountFormat 在线人数、title、startTime 开播时间、
 *    praiseCount 点赞。status=0 但 streamStatus=1/roomStatus=1 表示直播中，不能只看 status。
 *  - 返回码率：动态分辨率转码（如 720p-crf21）或平台原流，未见比 ld 更细的档位名；
 *    有用户 Cookie 时仍注入，可提高成功率。
 */
const MTOP_APPKEY = '12574478'
const LIVE_DETAIL_API = { api: 'mtop.roomstudio.live.detail.get', v: '1.0' }
const MTOP_ORIGIN = 'https://h5api.m.taobao.com'

function mtopSign(token, t, data, appkey = MTOP_APPKEY) {
  return crypto
    .createHash('md5')
    .update(`${token}&${t}&${appkey}&${data}`)
    .digest('hex')
}

/** 递归收集 JSON 中所有候选流地址 { qualityName, url } */
function collectStreams(node, out = [], prefix = '') {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const it of node) collectStreams(it, out, prefix)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if (/^https?:\/\/[^\s"']+\.(m3u8|flv)(\?[^\s"']*)?$/.test(v.trim())) {
        out.push({ qualityName: String(k || '').toLowerCase(), url: v.trim() })
      }
    } else {
      collectStreams(v, out, prefix)
    }
  }
  return out
}

/** 从流候选里挑「最低画质」：优先能映射到档位名的，否则按关键字启发式 */
function pickLowest(candidates) {
  if (!candidates.length) return null
  const named = {}
  for (const c of candidates) {
    const last = c.qualityName.split(/[._-]/).pop() || ''
    if (last && !named[last]) named[last] = c.url
  }
  const picked = pickLowestQuality(named)
  if (picked) return { ...picked, url: picked.url }
  const score = (u) => {
    const s = u.toLowerCase()
    if (/(^|[^a-z])(ld|sd)([^a-z]|$)/.test(s)) return 0
    if (/origin|uhd|full_hd/.test(s)) return 2
    return 1
  }
  candidates.sort((a, b) => score(a.url) - score(b.url))
  return { quality: 'auto', url: candidates[0].url }
}

/** 递归搜索直播间元信息候选字段（大小写不敏感，深度受限） */
function dig(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 7) return undefined
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = dig(it, keys, depth + 1)
      if (r !== undefined) return r
    }
    return undefined
  }
  for (const [k, v] of Object.entries(node)) {
    if (keys.includes(String(k).toLowerCase())) return v
  }
  for (const v of Object.values(node)) {
    const r = dig(v, keys, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

/** 按优先级取字段：依次 dig 单个 key，返回第一个非 undefined（避免被同名老字段抢先命中） */
function digOne(node, keys) {
  for (const k of keys) {
    const v = dig(node, [String(k).toLowerCase()])
    if (v !== undefined) return v
  }
  return undefined
}

/** 解析 set-cookie 头里与 mtop 签名相关的 cookie（完整三件套） */
function pickCookies(setCookie) {
  const parts = new Map()
  for (const chunk of String(setCookie || '').split(',')) {
    const m = chunk.match(/(cookie2|_m_h5_tk|_m_h5_tk_enc)=([^;,]*)/)
    if (m) parts.set(m[1], `${m[1]}=${m[2]}`)
  }
  return [...parts.values()].join('; ')
}

export class TaobaoAdapter extends BaseAdapter {
  static platform = 'taobao'
  static label = '淘宝直播'
  static stability = 'experimental'
  static urlHints = [
    'https://tbzb.taobao.com/live?liveId=<liveId>（直播间）',
    'https://h5.m.taobao.com/taolive/video.html?id=<liveId>',
    'https://m.tb.cn/h.xxxx（App 分享短链，自动展开）',
  ]

  matchUrl(url) {
    // 域名边界：taobao.com/tmall.com 子域用 (^|[/.:])；tb.cn 短链前面是 // 或 .（如 https://tb.cn、m.tb.cn）
    return /(^|[\/.:])tb\.cn\b|(^|[\/.:])taobao\.com\b|(^|[\/.:])tmall\.com\b/.test(url)
  }

  parseRoomId(url) {
    if (!url) return null
    const named = url.match(/[?&](?:liveId|roomId|room_id|feed_id|id)=(\d{5,})/)
    if (named) return named[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    if (/(^|[\/.:])tb\.cn\//.test(u)) u = await this.resolveRedirect(u)
    return u
  }

  /** 从已登录页面 HTML 中兜底抽取 liveId（SSR 数据） */
  #grepLiveId(html) {
    return html?.match(/"liveId"\s*:\s*"?(\d{5,})/)?.[1] || null
  }

  #cookieToken(cookie) {
    const m = String(cookie || '').match(/_m_h5_tk=([^;]+)/)
    return m ? m[1].split('_')[0] : ''
  }

  /**
   * mtop 两跳调用：
   *  ① 无有效 token 时先发一枪（空 token）触发 Set-Cookie，取 cookie2/_m_h5_tk/_m_h5_tk_enc；
   *  ② 带回完整 cookie 链 + md5 签名重试（缺 enc/cookie2 会 ILLEGAL_ACCESS）。
   *  若外部 cookie 已含 _m_h5_tk，直接用其 token 单跳。
   */
  async #mtopCall(api, v, data, externalCookie = '') {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), config.requestTimeoutMs)
    const doCall = async (cookie, withToken) => {
      const t = String(Date.now())
      const body = JSON.stringify(data)
      const token = withToken ? this.#cookieToken(cookie) : ''
      const sign = mtopSign(token, t, body)
      const qs = new URLSearchParams({
        jsv: '2.7.2',
        appKey: MTOP_APPKEY,
        t,
        sign,
        api,
        v,
        type: 'json',
        dataType: 'json',
        data: body,
      })
      const res = await fetch(`${MTOP_ORIGIN}/h5/${api}/${v}/?${qs}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
          Referer: 'https://tbzb.taobao.com/',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: ac.signal,
      })
      const setCookie = res.headers.get('set-cookie') || ''
      const bodyText = await res.text()
      return { res, setCookie, bodyText }
    }

    try {
      // 外部已有 _m_h5_tk：直接用，单跳
      if (this.#cookieToken(externalCookie)) {
        const r = await doCall(externalCookie, true)
        return JSON.parse(r.bodyText)
      }
      // 无 token：两跳
      const first = await doCall('', false)
      const ck = pickCookies(first.setCookie)
      if (!ck || !this.#cookieToken(ck)) {
        throw new AdapterError('淘宝未下发 mtop 令牌（网络/风控拦截）', {
          code: 'RISK_CONTROL',
          retryable: false,
          hint: '稍后重试；仍失败则打开直播间抓包，把 .m3u8/.flv 用「直链」模式接入',
        })
      }
      const second = await doCall(ck, true)
      return JSON.parse(second.bodyText)
    } catch (err) {
      if (err instanceof AdapterError) throw err
      if (err.name === 'AbortError') throw new AdapterError('淘宝接口请求超时', { code: 'TIMEOUT' })
      if (err instanceof SyntaxError) {
        throw new AdapterError('淘宝接口返回非 JSON（疑似被风控页拦截）', {
          code: 'RISK_CONTROL',
          retryable: false,
          hint: '请打开直播间抓包，把 .m3u8/.flv 用「直链」模式接入',
        })
      }
      throw new AdapterError(`网络异常：${err.message}`, { code: 'NETWORK' })
    } finally {
      clearTimeout(timer)
    }
  }

  #friendlyError(err, detail) {
    const msg = `${detail}${err?.message ? `：${err.message}` : ''}`
    return new AdapterError(msg.slice(0, 200), {
      code: 'RISK_CONTROL',
      retryable: false,
      hint: '① 可在房间 Cookie 中填入已登录淘宝的 Cookie（须含 _m_h5_tk）重试；' +
            '② 仍失败则打开直播间按 F12 抓包，把 .m3u8/.flv 直链用「直链」模式接入',
    })
  }

  async fetchRoomInfo(url, opts = {}) {
    const normalized = await this.normalizeUrl(url)
    let liveId = this.parseRoomId(normalized)
    if (!liveId) {
      try {
        const html = await this.request(normalized, { profile: opts.cookie, json: false })
        liveId = this.#grepLiveId(html)
      } catch {
        /* 网络失败就放弃兜底 */
      }
    }
    if (!liveId) {
      throw new AdapterError('无法从该链接解析出直播间 liveId。淘宝直播链接请用 tbzb.taobao.com/live?liveId= 或 m.tb.cn 短链', {
        code: 'PARSE_FAILED',
        retryable: false,
        hint: '支持：tbzb.taobao.com/live?liveId=、taolive/video.html?id=、m.tb.cn 短链',
      })
    }

    const cookie = this.cookieFor(opts.cookie)
    const j = await this.#mtopCall(LIVE_DETAIL_API.api, LIVE_DETAIL_API.v, { liveId }, cookie)
    const ret = Array.isArray(j?.ret) ? j.ret.join(';') : String(j?.ret || '')
    const body = j?.data || j || {}

    if (ret.includes('FAIL_SYS_TOKEN') || ret.includes('FAIL_SYS_ILLEGAL') || ret.includes('FAIL_SYS_USER_VALIDATE')) {
      throw this.#friendlyError(null, `淘宝令牌校验未通过（${ret.slice(0, 60)}）`)
    }
    if (ret.includes('RGV587') || ret.includes('FAIL') || ret.includes('ILLEGAL')) {
      throw this.#friendlyError(null, `淘宝接口拒绝（${ret.slice(0, 80)}）`)
    }

    const title = dig(body, ['title', 'liveTitle', 'subject', 'name'])
    const anchorName = dig(body, ['anchorName', 'anchorNick', 'nick', 'userName', 'nickname'])
    // isLive 判据：优先 streamStatus / roomStatus（实测直播中 status=0 但 streamStatus=1）
    const streamStatus = digOne(body, ['streamStatus', 'roomStatus', 'liveStatus', 'liveState', 'status'])
    const streams = collectStreams(body)
    const isLive =
      String(streamStatus) === '1' ||
      String(streamStatus) === 'true' ||
      (streams.length > 0 && !['0', '2', 'false'].includes(String(streamStatus)))

    return {
      roomId: String(liveId),
      title: typeof title === 'string' ? title : '',
      anchorName: typeof anchorName === 'string' ? anchorName : '',
      isLive,
      shareUrl: normalized,
      raw: { ret, body, liveId },
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://tbzb.taobao.com/live?liveId=${roomId}`, opts))
    const body = info?.raw?.body || {}
    const candidates = collectStreams(body)
    if (!info.isLive && !candidates.length) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    const picked = pickLowest(candidates)
    if (!picked) {
      throw new AdapterError('接口未返回可播放的流地址', {
        code: 'NO_STREAM',
        retryable: false,
        hint: '请在浏览器登录淘宝后打开直播间抓包，将 .m3u8/.flv 用「直链」模式接入',
      })
    }
    const isHls = /\.m3u8/.test(picked.url)
    return {
      url: picked.url,
      format: isHls ? 'hls' : 'flv',
      quality: picked.quality || 'auto',
      requestedQuality: 'lowest',
      qualities: [],
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  }

  async fetchMetrics(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://tbzb.taobao.com/live?liveId=${roomId}`, opts))
    const body = info?.raw?.body || {}
    // 数字型在线数优先（viewCount）；viewCountFormat 为「257 观看」展示串，仅在无数字字段时兜底解析
    const onlineRaw = digOne(body, ['viewCount', 'onlineCount', 'onlineNum', 'viewerCount', 'watchNum'])
    let online =
      typeof onlineRaw === 'number'
        ? onlineRaw
        : typeof onlineRaw === 'string' && /^\d[\d,]*$/.test(onlineRaw)
          ? Number(onlineRaw.replace(/,/g, ''))
          : null
    if (online === null) {
      const fmt = digOne(body, ['viewCountFormat'])
      const n = Number(String(fmt || '').replace(/[^\d]/g, ''))
      if (n > 0) online = n
    }
    const likeRaw = digOne(body, ['praiseCount', 'likeCount', 'favoritesCount'])
    const like =
      typeof likeRaw === 'number'
        ? likeRaw
        : typeof likeRaw === 'string' && /^\d+$/.test(likeRaw)
          ? Number(likeRaw)
          : null
    const startRaw = digOne(body, ['startTime', 'liveStartTime'])
    const startTime =
      typeof startRaw === 'number' && startRaw > 1e11
        ? startRaw
        : startRaw && /^\d{13}$/.test(String(startRaw))
          ? Number(startRaw)
          : null
    return { isLive: info.isLive, onlineCount: online, likeCount: like, startTimeMs: startTime }
  }
}
