import crypto from 'node:crypto'
import { BaseAdapter, AdapterError, pickLowestQuality } from './base.js'

/**
 * 淘宝直播适配器（experimental）
 *
 * 现状（2026-09 调研）：
 *  - 淘宝直播流地址只通过 mtop（h5api.m.taobao.com）下发，页面播放时动态换取。
 *  - H5 老式 mtop 通道使用 appKey=12574478 + md5(token&t&appKey&data) 简单签名，
 *    依赖登录 Cookie（_m_h5_tk）；部分接口已升级 mtgsig 强签名，此时老通道会被拒。
 *  - 因此本适配器分三层尝试，越往后越是保底：
 *      ① 无 Cookie：仍发起 mtop 请求（部分老接口允许空 token 匿名换取低清流）
 *      ② 有 Cookie：注入 _m_h5_tk 签名，成功率更高
 *      ③ 均被拒 / 无 liveId：抛出带「抓包直链」指引的错误，引导用 direct 适配器
 *
 * 返回结构参考淘宝开放平台 taobao.live.room.fetch：
 *   data.live_flv_ld / live_flv_hd / live_hls_ld … 多码率字段，
 *   本适配器优先挑最低码率（ld）——正好满足「最低画质监控」需求。
 */
const MTOP_APPKEY = '12574478'
const LIVE_DETAIL_APIS = [
  { api: 'mtop.mediaplatform.live.livedetail', v: '2.0' },
  { api: 'mtop.taobao.live.livedetail', v: '1.0' },
]

function mtopSign(token, t, data) {
  return crypto
    .createHash('md5')
    .update(`${token}&${t}&${MTOP_APPKEY}&${data}`)
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
  // 尝试档位名映射（live_flv_ld -> ld）
  const named = {}
  for (const c of candidates) {
    const last = c.qualityName.split(/[._-]/).pop() || ''
    if (last && !named[last]) named[last] = c.url
  }
  const picked = pickLowestQuality(named)
  if (picked) return { ...picked, url: picked.url }
  // 启发式兜底：ld/低清 优先，避开 hd/uhd/origin
  const score = (u) => {
    const s = u.toLowerCase()
    if (/(^|[^a-z])(ld|sd)([^a-z]|$)/.test(s)) return 0
    if (/origin|uhd|hd/.test(s)) return 2
    return 1
  }
  candidates.sort((a, b) => score(a.url) - score(b.url))
  return { quality: 'auto', url: candidates[0].url }
}

/** 递归搜索直播间元信息候选字段 */
function dig(node, keys, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return undefined
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

export class TaobaoAdapter extends BaseAdapter {
  static platform = 'taobao'
  static label = '淘宝直播'
  static stability = 'experimental'
  static urlHints = [
    'https://h5.m.taobao.com/taolive/video.html?id=<liveId>',
    'https://market.m.taobao.com/app/fm-live/live-house/detail.html?liveId=xxxx',
    'https://m.tb.cn/h.xxxx（App 分享短链，自动展开）',
  ]

  matchUrl(url) {
    return /(^|[./:])tb\.cn\b|(^|[./:])taobao\.com\b|(^|[./:])tmall\.com\b/.test(url)
  }

  parseRoomId(url) {
    if (!url) return null
    const named = url.match(/[?&](?:liveId|roomId|room_id|feed_id)=(\d{5,})/)
    if (named) return named[1]
    // taolive/video.html?id=<liveId>（老版淘宝直播 H5 详情页）
    const video = url.match(/taolive\/video\.html[^#]*[?&]id=(\d{5,})/)
    if (video) return video[1]
    return null
  }

  async normalizeUrl(url) {
    let u = url.trim()
    if (/(^|\.)tb\.cn\//.test(u)) u = await this.resolveRedirect(u)
    return u
  }

  /** 从已登录页面 HTML 中兜底抽取 liveId（SSR 数据） */
  #grepLiveId(html) {
    return html?.match(/"liveId"\s*:\s*"?(\d{5,})/)?.[1] || null
  }

  #cookieToken(cookie) {
    if (!cookie) return ''
    const m = cookie.match(/_m_h5_tk=([^;]+)/)
    if (!m) return ''
    return m[1].split('_')[0]
  }

  /** 调 mtop livedetail，返回原始响应 JSON */
  async #livedetail(liveId, cookie) {
    const t = String(Date.now())
    const data = JSON.stringify({ liveId })
    const token = this.#cookieToken(cookie)
    const sign = mtopSign(token, t, data)
    const qs = new URLSearchParams({
      jsv: '2.7.2',
      appKey: MTOP_APPKEY,
      t,
      sign,
      api: LIVE_DETAIL_APIS[0].api,
      v: LIVE_DETAIL_APIS[0].v,
      type: 'json',
      dataType: 'json',
      data,
    })
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      Referer: 'https://h5.m.taobao.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    }
    return this.request(`https://h5api.m.taobao.com/h5/mtop.mediaplatform.live.livedetail/2.0/?${qs}`, {
      headers,
    })
  }

  #friendlyError(err) {
    const msg = String(err.message || err)
    if (/mtgsig|签名|sign|风控|滑块|校验/i.test(msg) || /403|400/.test(msg)) {
      return new AdapterError(
        '淘宝接口拒绝访问（大概率需登录态或已升级 mtgsig 强签名）',
        {
          code: 'RISK_CONTROL',
          retryable: false,
          hint: '① 在房间 Cookie 中填入已登录淘宝的 Cookie（须含 _m_h5_tk）重试；' +
                '② 仍失败则打开直播间按 F12 抓包，把 .m3u8/.flv 直链用「直链」模式接入（不受签名影响）',
        }
      )
    }
    return err
  }

  async fetchRoomInfo(url, opts = {}) {
    const normalized = await this.normalizeUrl(url)
    let liveId = this.parseRoomId(normalized)
    if (!liveId) {
      // 兜底：主播主页等页面 SSR 里可能带 liveId
      try {
        const html = await this.request(normalized, { profile: opts.cookie, json: false })
        liveId = this.#grepLiveId(html)
      } catch {
        /* 网络失败就放弃兜底 */
      }
    }
    if (!liveId) {
      throw new AdapterError(
        '无法从该链接解析出直播间 liveId。淘宝分享链接请用直播间地址或 m.tb.cn 短链',
        {
          code: 'PARSE_FAILED',
          retryable: false,
          hint: '支持：taolive/video.html?id=、fm-live/live-house/detail.html?liveId=、m.tb.cn 短链',
        }
      )
    }

    let res
    try {
      res = await this.#livedetail(liveId, opts.cookie)
    } catch (err) {
      throw this.#friendlyError(err)
    }
    const ret = Array.isArray(res?.ret) ? res.ret.join(';') : String(res?.ret || '')
    const body = res?.data || res || {}

    if (ret.includes('FAIL') || ret.includes('ILLEGAL')) {
      throw new AdapterError(`淘宝接口返回：${ret.slice(0, 120)}`, {
        code: 'API_ERROR',
        retryable: false,
        hint: '若提示签名/风控，请按提示② 走抓包直链',
      })
    }

    const title = dig(body, ['title', 'liveTitle', 'subject', 'name'])
    const anchorName = dig(body, ['anchorName', 'anchorNick', 'nick', 'userName'])
    const liveState = dig(body, ['liveStatus', 'status', 'liveState'])
    const streams = collectStreams(body)
    return {
      roomId: liveId,
      title: typeof title === 'string' ? title : '',
      anchorName: typeof anchorName === 'string' ? anchorName : '',
      isLive: liveState === '0' ? false : streams.length > 0, // 有流地址视为在播
      shareUrl: normalized,
      raw: { ret, body, liveId },
    }
  }

  async fetchStreamUrl(roomId, opts = {}) {
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://h5.m.taobao.com/taolive/video.html?id=${roomId}`, opts))
    const body = info?.raw?.body || {}
    if (body && !collectStreams(body).length && !info.isLive) {
      throw new AdapterError('主播当前未开播', { code: 'NOT_LIVE', retryable: false })
    }
    const picked = pickLowest(collectStreams(body))
    if (!picked) {
      throw new AdapterError('接口未返回可播放的流地址（需登录态换取流）', {
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
    const info = opts.roomInfo || (await this.fetchRoomInfo(`https://h5.m.taobao.com/taolive/video.html?id=${roomId}`, opts))
    const body = info?.raw?.body || {}
    const onlineRaw = dig(body, ['onlineCount', 'onlineNum', 'viewerCount', 'uv', 'pv', 'watchNum', 'liveCount'])
    const online =
      typeof onlineRaw === 'number'
        ? onlineRaw
        : typeof onlineRaw === 'string' && /^\d+$/.test(onlineRaw)
          ? Number(onlineRaw)
          : null
    return { isLive: info.isLive, onlineCount: online, likeCount: null }
  }
}
