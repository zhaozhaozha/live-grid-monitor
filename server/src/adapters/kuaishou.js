import { BaseAdapter, AdapterError, pickLowestQuality } from './base.js'

/**
 * 快手直播适配器（experimental）
 *
 * 快手网页端主要依赖 __INITIAL_STATE__ SSR 数据与 GraphQL 接口。
 * 1.0 实现了 SSR 抽取 + livePlay GraphQL 兜底两条路径，
 * 但由于快手风控更新频繁，建议在生产环境配置 KUAISHOU_COOKIE。
 */
export class KuaishouAdapter extends BaseAdapter {
  static platform = 'kuaishou'
  static label = '快手直播'
  static stability = 'experimental'
  static urlHints = [
    'https://live.kuaishou.com/u/username',
    'https://live.kuaishou.com/short-video/xxxx',
  ]

  matchUrl(url) {
    return /kuaishou\.com|chenzhongtech\.com/.test(url)
  }

  parseRoomId(url) {
    const m = url?.match(/live\.kuaishou\.com\/u\/([A-Za-z0-9_-]+)/)
    return m ? m[1] : null
  }

  async fetchRoomInfo(url, opts = {}) {
    const profile = opts.cookie
    const principalId = this.parseRoomId(url)
    if (!principalId) {
      throw new AdapterError('请使用形如 live.kuaishou.com/u/<用户名> 的直播间地址', {
        code: 'PARSE_FAILED',
        retryable: false,
      })
    }

    const html = await this.request(`https://live.kuaishou.com/u/${principalId}`, {
      profile,
      json: false,
      headers: { Referer: 'https://live.kuaishou.com/' },
    })

    const initState = this.#extractInitState(html)
    const live = initState?.liveroom?.liveStream || initState?.liveroom
    if (!live) {
      throw new AdapterError('未取到直播间数据，可能需要配置 KUAISHOU_COOKIE', {
        code: 'NO_DATA',
        hint: '在 .env 中设置 KUAISHOU_COOKIE 后重试；也可先用「直链」适配器接入',
      })
    }

    const author = live.author || initState?.liveroom?.author || {}
    const playUrls = live.playUrls || []
    const qualities = {}
    for (const p of playUrls) {
      if (p?.quality && p?.url) qualities[p.quality] = p.url
    }

    return {
      roomId: live.id || live.liveStreamId || principalId,
      title: live.caption || live.name || '',
      anchorName: author.name || author.user_name || '',
      avatarUrl: author.avatar || author.headurl || '',
      isLive: Number(live.living ?? live.isLiving ?? 0) === 1,
      shareUrl: url,
      raw: { live, author, qualities },
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(opts.shareUrl, opts))
    if (!info.isLive) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    const qualities = info.raw?.qualities || {}
    const picked = pickLowestQuality(qualities)
    if (!picked) {
      throw new AdapterError('未取到流地址，可能需要配置 KUAISHOU_COOKIE', { code: 'NO_STREAM' })
    }
    return {
      url: picked.url,
      format: picked.url.includes('.m3u8') ? 'hls' : 'flv',
      quality: picked.quality,
      qualities: Object.keys(qualities),
      expiresAt: Date.now() + 20 * 60 * 1000,
    }
  }

  async fetchMetrics(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(opts.shareUrl, opts))
    const live = info.raw?.live || {}
    return {
      isLive: info.isLive,
      onlineCount: Number(live.watchingCount ?? live.viewerCount ?? 0) || 0,
      likeCount: Number(live.likeCount ?? 0) || 0,
      title: info.title,
      anchorName: info.anchorName,
    }
  }

  #extractInitState(html) {
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)
    if (!m) return null
    try {
      // SSR 数据含 undefined / 单引号键，做最小容错清洗
      const json = m[1].replace(/\bundefined\b/g, 'null')
      return JSON.parse(json)
    } catch {
      return null
    }
  }
}
