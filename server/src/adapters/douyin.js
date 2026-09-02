import { BaseAdapter, AdapterError, pickLowestQuality } from './base.js'

/**
 * 抖音直播适配器
 *
 * 两条数据通道，真机实测（2026-09）：
 *
 * A) 短链分享（v.douyin.com/xxx，App 内分享的典型形态）
 *    302 -> webcast.amemv.com/douyin/webcast/reflow/<roomId>（移动端 H5）
 *    该页面 HTML 内嵌 RSC(React Server Component) 数据流 ——
 *    self.__rsc_f.push([...]) 中带有完整 room + streamUrl 数据，
 *    无需再调任何接口即可拿到 标题/主播/在线/多档 flv/hls 流地址。
 *    适配器直接从 HTML 还原 RSC JSON，零 Cookie 可用。
 *
 * B) 网页直播间（live.douyin.com/<web_rid>）
 *    调 webcast/room/web/enter 接口（社区通用方案），可匿名获取。
 *    若平台开启严格校验，在 .env 配置 DOUYIN_COOKIE（或房间级 cookie）。
 */
export class DouyinAdapter extends BaseAdapter {
  static platform = 'douyin'
  static label = '抖音直播'
  static stability = 'stable'
  static urlHints = [
    'https://v.douyin.com/xxxxxxx/  （分享短链，最常用）',
    'https://live.douyin.com/712345678901',
    'https://webcast.amemv.com/douyin/webcast/reflow/7680xxxxx（App 分享展开后）',
  ]

  matchUrl(url) {
    return /douyin\.com|iesdouyin\.com|amemv\.com/.test(url)
  }

  parseRoomId(url) {
    if (!url) return null
    // 完整直播间地址
    const m = url.match(/live\.douyin\.com\/(\d{6,})/)
    if (m) return m[1]
    // 带参数形式 ?room_id= / web_rid=
    const q = url.match(/[?&](?:room_id|web_rid)=(\d{6,})/)
    if (q) return q[1]
    // webcast reflow 页（App 分享短链展开后的落点）
    const r = url.match(/\/reflow\/(\d{6,})/)
    if (r) return r[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    if (/v\.douyin\.com/.test(u)) u = await this.resolveRedirect(u)
    // 主页形式无法直接从 URL 拿 roomId，交给 fetchRoomInfo 处理
    return u
  }

  /** 是否为 webcast reflow 移动页（App 分享展开后常落于此） */
  isReflowUrl(url) {
    return /amemv\.com\/douyin\/webcast\/(?:room\/)?reflow\//.test(url)
  }

  async fetchRoomInfo(url, opts = {}) {
    const profile = opts.cookie
    const normalized = await this.normalizeUrl(url)

    // A) reflow 移动页：HTML 内嵌完整 RSC 数据，无需再调接口
    if (this.isReflowUrl(normalized)) {
      return this.#fetchReflow(normalized, url, profile)
    }

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

  /** B) 网页直播间：webcast/room/web/enter 接口 */
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

  /**
   * A) reflow 移动页：HTML 内嵌 RSC —— 自包含 room + streamUrl，无需接口调用。
   */
  async #fetchReflow(pageUrl, shareUrl, profile) {
    const html = await this.request(pageUrl, { profile, json: false })

    // 1) 还原所有 __rsc_f.push 段（JS 字符串字面量 -> 真实文本）
    const segments = []
    for (const m of html.matchAll(/self\.__rsc_f\.push\(\[(\d+),"[^\"]/g)) {
      const seg = html.slice(m.index, m.index + 8_000_000)
      const arr = seg.match(/^self\.__rsc_f\.push\((\[.*?\])\)/s)
      if (!arr) continue
      const mm = arr[1].match(/^\[(\d+),"((?:[^"\\]|\\.)*)"\]/)
      if (!mm) continue
      try {
        segments.push(JSON.parse('"' + mm[2] + '"'))
      } catch {
        /* 个别段可能被截断，跳过 */
      }
    }
    if (!segments.length) {
      throw new AdapterError('reflow 页面未找到内嵌数据（可能被风控拦截或页面改版）', {
        code: 'PARSE_FAILED',
        hint: '可重试；若持续失败请改用 live.douyin.com/<id> 直播间地址',
      })
    }

    // 2) 用平衡括号提取 room / streamUrl / ownerUser 等 JSON 对象
    const extract = (text, key) => {
      const k = text.indexOf('"' + key + '":{')
      if (k < 0) return null
      let i = text.indexOf('{', k)
      let depth = 0
      let inStr = false
      let esc = false
      for (; i < text.length; i++) {
        const c = text[i]
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') { inStr = true; continue }
        if (c === '{') depth++
        else if (c === '}') {
          depth--
          if (depth === 0) {
            try {
              return JSON.parse(text.slice(k + key.length + 3, i + 1))
            } catch {
              return null
            }
          }
        }
      }
      return null
    }

    let room = null
    let streamUrl = null
    let ownerUser = null
    for (const seg of segments) {
      if (!room && seg.includes('"room":{')) room = extract(seg, 'room')
      if (!streamUrl && seg.includes('"streamUrl":{')) streamUrl = extract(seg, 'streamUrl')
      if (!ownerUser && seg.includes('"ownerUser":{')) ownerUser = extract(seg, 'ownerUser')
      if (room && streamUrl) break
    }
    if (!room) {
      throw new AdapterError('reflow 页面数据不完整（未找到房间数据），可能直播间不存在或页面改版', {
        code: 'ROOM_NOT_FOUND',
        retryable: true,
      })
    }

    const status = room.status
    const owner = room.owner || ownerUser || {}
    return {
      roomId: room.idStr || String(room.id) || '',
      webRid: null, // reflow 页无 web_rid；后续请求直接携带 roomInfo
      title: room.title || '',
      anchorName: owner.nickname || '',
      avatarUrl: room.cover?.url_list?.[0] || '',
      isLive: status === 2,
      shareUrl,
      raw: { reflow: true, room, streamUrl },
      // 便于直接使用，reflow 无 API 二次请求能力
      _metrics: this.#reflowMetrics(room),
    }
  }

  #reflowMetrics(room) {
    const stats = room.stats || {}
    const online =
      Number(room.user_count ?? room.userCount ?? stats.user_count ?? stats.total_user ?? 0) || 0
    return {
      onlineCount: online,
      likeCount: Number(stats.like_count ?? room.like_count ?? 0) || 0,
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const { quality = 'lowest', webRid } = opts
    // reflow 通道：roomInfo.raw.streamUrl 自包含多档地址
    const reflow = opts.roomInfo?.raw?.reflow
    if (reflow) {
      const su = opts.roomInfo.raw.streamUrl || {}
      const flvMap = su.flvPullUrl || {}
      const hlsMap = su.hlsPullUrlMap || (su.hlsPullUrl ? { hd: su.hlsPullUrl } : {})
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
        throw new AdapterError('reflow 页面未携带流地址（直播可能已结束）', {
          code: 'NO_STREAM',
          retryable: false,
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
        // reflow 内嵌流地址签名较短（约 15 分钟），缓存设短一些
        expiresAt: Date.now() + 10 * 60 * 1000,
      }
    }

    // 网页通道（与旧逻辑一致）
    const info = opts.roomInfo || (await this.#enter(webRid || roomId, '', opts.cookie))
    if (!info.isLive) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    const streamUrl = info.raw?.room?.stream_url || {}
    const flvMap = streamUrl.flv_pull_url || {}
    const hlsMap = streamUrl.hls_pull_url_map || streamUrl.hls_pull_url || {}

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
    const info = opts.roomInfo || (await this.fetchRoomInfo(opts.shareUrl || roomId, { cookie: opts.cookie }))
    if (info.raw?.reflow) return { ...info._metrics, isLive: info.isLive, title: info.title, anchorName: info.anchorName }
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
