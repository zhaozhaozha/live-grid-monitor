import { BaseAdapter, AdapterError } from './base.js'

/**
 * 京东直播适配器（experimental）
 *
 * 现状（2026-09 调研结论）：
 *  - 京东 web 端直播已收缩：live.jd.com 变成跳转 jd.com 的壳；
 *    历史上社区方案依赖的公开接口 api.m.jd.com/client.action?functionId=liveDetail
 *    已下线（实测返回 "the current API does not exist"），新版仅存在于京东 App / 小程序内。
 *  - 因此本适配器能做到：
 *      ① 识别京东域名的分享链接（live.html?id= / live.jd.com / 3.cn、u.jd.com 短链）
 *      ② 提取直播场次 liveId 并保存为房间（用于列表占位、手动整理）
 *      ③ 仍尝试老版 liveDetail 接口（万一局部环境可用），成功则直接出流
 *      ④ 失败时给出明确可操作的指引：京东 App / 浏览器播放时抓包 -> 用直链适配器接入
 */
export class JdAdapter extends BaseAdapter {
  static platform = 'jd'
  static label = '京东直播'
  static stability = 'experimental'
  static urlHints = [
    'https://h5.m.jd.com/dev/3pbY8ZuCx4ML99uttZKLHC2QcAMn/live.html?id=<liveId>',
    'https://live.jd.com/<liveId>',
    'https://u.jd.com/xxxx（App 分享短链，自动展开）',
    'https://3.cn/xxxx',
  ]

  matchUrl(url) {
    return /(^|[./:])jd\.com\b|(^|[./:])3\.cn\b/.test(url)
  }

  parseRoomId(url) {
    if (!url) return null
    // live.html?id=<liveId>  /  ?liveId= / ?room_id= / ?id=
    const m = url.match(/[?&](?:id|liveId|roomId|room_id)=(\d{4,})/)
    if (m) return m[1]
    // live.jd.com/<liveId>
    const p = url.match(/live\.jd\.com\/(\d{4,})/)
    if (p) return p[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    if (/(^|\.)3\.cn\//.test(u) || /u\.jd\.com/.test(u)) u = await this.resolveRedirect(u)
    return u
  }

  /** 老版 liveDetail 接口（2020 年社区方案，实测已下线，保留尝试以兼容局部环境） */
  async #liveDetail(liveId) {
    const url =
      'https://api.m.jd.com/client.action?' +
      new URLSearchParams({
        functionId: 'liveDetail',
        body: JSON.stringify({ id: liveId, videoType: 1 }),
        client: 'wh5',
      })
    return this.request(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://live.jd.com/',
      },
    })
  }

  #deprecatedError() {
    return new AdapterError(
      '京东直播 web 端入口已下线，服务端无法直接解析流地址',
      {
        code: 'API_DEPRECATED',
        retryable: false,
        hint: '请在京东 App / 浏览器中打开该直播间，按 F12 抓包拿到 .m3u8/.flv 直链，再用「直链」模式接入。链接本身可作为占位房间保留',
      }
    )
  }

  #parseBody(body) {
    // 老接口成功时：{ code:'0', data:{ status:1, h5Pull:'https://...', anchorNick, title, ... } }
    if (!body || typeof body !== 'object') return null
    const data = body.data || body
    const isLive = data.status === 1 || data.status === '1'
    const streamUrl =
      (typeof data.h5Pull === 'string' && data.h5Pull.startsWith('http') && data.h5Pull) ||
      (typeof data.pullUrl === 'string' && data.pullUrl.startsWith('http') && data.pullUrl) ||
      ''
    return {
      roomId: String(data.liveId || data.anchorId || ''),
      title: data.title || data.roomTitle || '',
      anchorName: data.anchorNick || data.nickName || data.anchorName || '',
      avatarUrl: data.anchorImg || data.avatar || '',
      isLive: Boolean(isLive),
      streamUrl,
    }
  }

  async fetchRoomInfo(url, opts = {}) {
    const normalized = await this.normalizeUrl(url)
    const liveId = this.parseRoomId(normalized)
    if (!liveId) {
      throw new AdapterError('无法从该链接解析出京东直播间 liveId', {
        code: 'PARSE_FAILED',
        retryable: false,
        hint: '支持：live.html?id=<liveId>、live.jd.com/<liveId>、u.jd.com / 3.cn 短链',
      })
    }
    try {
      const res = await this.#liveDetail(liveId)
      const info = this.#parseBody(res)
      if (info && info.roomId) {
        return { ...info, shareUrl: normalized }
      }
      throw this.#deprecatedError()
    } catch (err) {
      // 老接口已下线（code '2' / HTTP 错误 / 网络不通）统一给可操作指引
      if (err instanceof AdapterError && err.code !== 'API_DEPRECATED') {
        const dep = this.#deprecatedError()
        // 保留房间占位能力：把 liveId 返回给调用方，但注明接口不可用
        return {
          roomId: liveId,
          title: '',
          anchorName: '',
          isLive: false,
          shareUrl: normalized,
          deprecated: true,
          message: dep.message,
          hint: dep.hint,
        }
      }
      throw err
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://live.jd.com/${roomId}`))
    if (info.deprecated || !info.streamUrl) {
      throw this.#deprecatedError()
    }
    if (!info.isLive) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    return {
      url: info.streamUrl,
      format: /\.m3u8/i.test(info.streamUrl) ? 'hls' : 'flv',
      quality: 'auto',
      requestedQuality: 'lowest',
      qualities: [],
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  }

  async fetchMetrics(roomId, opts = {}) {
    // 京东无公开人气接口；仅在老接口存活时能拿到观看数
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://live.jd.com/${roomId}`))
    const online = info?.onlineCount ?? null
    return { isLive: Boolean(info.isLive), onlineCount: online, likeCount: null }
  }
}
