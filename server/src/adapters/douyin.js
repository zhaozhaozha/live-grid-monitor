import { BaseAdapter, AdapterError, pickLowestQuality } from './base.js'

/**
 * 抖音直播适配器
 *
 * 实现思路参考社区广泛使用的 ihmily/DouyinLiveRecorder（10.8k★）：
 *   分享短链 v.douyin.com/xxx  -> 跟踪 302 -> live.douyin.com/<web_rid>
 *   -> 调 webcast/room/web/enter 拿 room_id / 状态 / 流地址 / 在线人数
 *
 * 该接口无需登录即可获取大部分数据；若平台开启严格校验，
 * 在 .env 中配置 DOUYIN_COOKIE 即可（或在房间配置里单独填 cookie）。
 */
export class DouyinAdapter extends BaseAdapter {
  static platform = 'douyin'
  static label = '抖音直播'
  static stability = 'stable'
  static urlHints = [
    'https://live.douyin.com/712345678901',
    'https://v.douyin.com/iRabcdef/',
    'https://www.douyin.com/user/MS4wLjABAAAA  （主页，开播时可解析）',
  ]

  matchUrl(url) {
    return /douyin\.com|iesdouyin\.com/.test(url)
  }

  parseRoomId(url) {
    if (!url) return null
    // 完整直播间地址
    const m = url.match(/live\.douyin\.com\/(\d{6,})/)
    if (m) return m[1]
    // 带参数形式 ?room_id= / web_rid=
    const q = url.match(/[?&](?:room_id|web_rid)=(\d{6,})/)
    if (q) return q[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    if (/v\.douyin\.com/.test(u)) u = await this.resolveRedirect(u)
    // 主页形式无法直接从 URL 拿 roomId，交给 fetchRoomInfo 处理
    return u
  }

  async fetchRoomInfo(url, opts = {}) {
    const profile = opts.cookie
    const normalized = await this.normalizeUrl(url)
    const webRid = this.parseRoomId(normalized)

    if (!webRid) {
      // 主页地址：抓取 HTML 中的 roomId（SSR 数据）
      const html = await this.request(normalized, { profile, json: false })
      const rid =
        html.match(/"web_rid"\s*:\s*"(\d+)"/)?.[1] ||
        html.match(/live\.douyin\.com\/(\d{6,})/)?.[1] ||
        html.match(/"room_id"\s*:\s*"(\d+)"/)?.[1]
      if (!rid) {
        throw new AdapterError(
          '无法从该链接解析出房间号。若为主页链接，请改用直播间地址（live.douyin.com/数字）',
          { code: 'PARSE_FAILED', retryable: false, hint: '支持：live.douyin.com/<id>、v.douyin.com 短链' }
        )
      }
      return this.#enter(rid, normalized, profile)
    }
    return this.#enter(webRid, normalized, profile)
  }

  async #enter(webRid, shareUrl, profile) {
    const api =
      'https://live.douyin.com/webcast/room/web/enter/?' +
      new URLSearchParams({
        aid: '6383',
        app_name: 'douyin_web',
        live_id: '1',
        device_platform: 'web',
        language: 'zh-CN',
        enter_from: 'web_live',
        cookie_enabled: 'true',
        browser_language: 'zh-CN',
        browser_platform: 'MacIntel',
        browser_name: 'Chrome',
        browser_version: '124.0.0.0',
        web_rid: webRid,
      })

    const data = await this.request(api, { profile })
    if (data?.status_code !== 0) {
      throw new AdapterError(`抖音接口返回异常 status_code=${data?.status_code ?? 'null'}`, {
        code: 'API_ERROR',
        hint: '常见原因：Cookie 失效或触发风控滑块，请更新 DOUYIN_COOKIE',
      })
    }

    const room = data?.data?.data?.[0]
    const user = data?.data?.user
    if (!room) {
      throw new AdapterError('直播间不存在或已关闭', {
        code: 'ROOM_NOT_FOUND',
        retryable: false,
      })
    }

    const owner = room.owner || user || {}
    return {
      roomId: room.id_str || String(room.id) || webRid,
      webRid,
      title: room.title || '',
      anchorName: owner.nickname || '',
      avatarUrl: owner.avatar_thumb?.url_list?.[0] || owner.avatar_larger?.url_list?.[0] || '',
      isLive: room.status === 2,
      shareUrl,
      raw: { room, user },
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const { quality = 'lowest', webRid } = opts
    const info = opts.roomInfo || (await this.#enter(webRid || roomId, '', opts.cookie))
    if (!info.isLive) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    const streamUrl = info.raw?.room?.stream_url || {}
    const flvMap = streamUrl.flv_pull_url || {}
    const hlsMap = streamUrl.hls_pull_url_map || streamUrl.hls_pull_url || {}

    // 优先 FLV（延迟低、CPU 占用小于 HLS 多切片）；失败时前端会回落到 HLS
    let picked = null
    let format = 'flv'
    if (Object.keys(flvMap).length) {
      picked = pickLowestQuality(flvMap)
      format = 'flv'
    }
    if (!picked && Object.keys(hlsMap).length) {
      picked = pickLowestQuality(hlsMap)
      format = 'hls'
    }
    if (!picked) {
      throw new AdapterError('未取到流地址，可能需要配置有效 Cookie', {
        code: 'NO_STREAM',
        hint: '在 .env 中设置 DOUYIN_COOKIE 后重试',
      })
    }

    return {
      url: picked.url,
      format,
      quality: picked.quality,
      requestedQuality: quality,
      qualities: [...Object.keys(flvMap), ...Object.keys(hlsMap)].filter(
        (v, i, a) => a.indexOf(v) === i
      ),
      expiresAt: Date.now() + 30 * 60 * 1000,
    }
  }

  async fetchMetrics(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.#enter(opts.webRid || roomId, '', opts.cookie))
    const room = info.raw?.room || {}
    const stats = room.stats || room.room_view_stats || {}
    const online =
      Number(stats.total_user ?? stats.user_count ?? room.user_count ?? 0) || 0
    return {
      isLive: info.isLive,
      onlineCount: online,
      likeCount: Number(stats.like_count ?? room.like_count ?? 0) || 0,
      title: info.title,
      anchorName: info.anchorName,
    }
  }
}
