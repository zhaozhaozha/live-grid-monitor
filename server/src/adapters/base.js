import { config } from '../config.js'

/**
 * 平台适配器基类。
 *
 * 适配器的职责只有三件事：
 *   1. fetchRoomInfo  —— 分享链接  -> 房间元信息（roomId / 标题 / 主播 / 是否在播）
 *   2. fetchStreamUrl —— roomId    -> 可播放的真实流地址（flv 或 hls），默认取最低画质
 *   3. fetchMetrics   —— roomId    -> 在线人数、点赞数、是否在播
 *
 * 平台接口会随风控策略变动，因此每个适配器必须实现自检（describe()），
 * 并把失败原因以 AdapterError 抛出，便于前端直接展示可操作的提示。
 */
export class AdapterError extends Error {
  constructor(message, { code = 'ADAPTER_ERROR', hint = '', retryable = true } = {}) {
    super(message)
    this.name = 'AdapterError'
    this.code = code
    this.hint = hint
    this.retryable = retryable
  }
}

export class BaseAdapter {
  /** 稳定性标记：stable | experimental | stub */
  static stability = 'stub'
  /** 平台 key，如 douyin */
  static platform = 'unknown'
  /** 平台中文名 */
  static label = '未知平台'
  /** 支持的分享链接示例，用于 UI 提示 */
  static urlHints = []

  constructor() {
    this.timeout = config.requestTimeoutMs
  }

  /** 判断某个 URL 是否归属本平台 */
  matchUrl(_url) {
    return false
  }

  /** 从分享链接中提取房间号 / 短链，无法提取则返回 null */
  parseRoomId(_url) {
    return null
  }

  async fetchRoomInfo(_url, _opts = {}) {
    throw new AdapterError(`${this.constructor.label} 适配器尚未实现 fetchRoomInfo`, {
      code: 'NOT_IMPLEMENTED',
      retryable: false,
    })
  }

  async fetchStreamUrl(_roomId, _opts = {}) {
    throw new AdapterError(`${this.constructor.label} 适配器尚未实现 fetchStreamUrl`, {
      code: 'NOT_IMPLEMENTED',
      retryable: false,
    })
  }

  async fetchMetrics(_roomId, _opts = {}) {
    throw new AdapterError(`${this.constructor.label} 适配器尚未实现 fetchMetrics`, {
      code: 'NOT_IMPLEMENTED',
      retryable: false,
    })
  }

  static describe() {
    return {
      platform: this.platform,
      label: this.label,
      stability: this.stability,
      urlHints: this.urlHints,
    }
  }

  // ---------- 通用工具 ----------

  cookieFor(profile) {
    return profile || config.cookies[this.constructor.platform] || ''
  }

  headersFor(profile, extra = {}) {
    const cookie = this.cookieFor(profile)
    return {
      'User-Agent': config.userAgent,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://live.douyin.com/',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    }
  }

  async request(url, { profile, method = 'GET', headers = {}, body, json = true } = {}) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeout)
    try {
      const res = await fetch(url, {
        method,
        headers: this.headersFor(profile, headers),
        body,
        signal: ac.signal,
        redirect: 'follow',
      })
      if (!res.ok) {
        throw new AdapterError(`请求失败 HTTP ${res.status}`, {
          code: 'HTTP_ERROR',
          hint: res.status === 403 || res.status === 401 ? '疑似触发风控，请更新 Cookie' : '',
        })
      }
      return json ? await res.json() : await res.text()
    } catch (err) {
      if (err instanceof AdapterError) throw err
      if (err.name === 'AbortError') {
        throw new AdapterError('请求超时', { code: 'TIMEOUT' })
      }
      throw new AdapterError(`网络异常：${err.message}`, { code: 'NETWORK' })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 跟踪短链（v.douyin.com / kuaishou 短链等），返回最终 URL */
  async resolveRedirect(url) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.timeout)
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': config.userAgent },
        signal: ac.signal,
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        return new URL(location, url).toString()
      }
      return url
    } catch {
      return url
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 画质档位从低到高排序（用于挑选最低画质） */
export const QUALITY_ORDER = [
  'ld',
  'sd',
  'sd1',
  'sd2',
  'ld1',
  'hd',
  'hd1',
  'full_hd',
  'full_hd1',
  'origin',
  'uhd',
  '蓝光',
  '超清',
  '高清',
  '标清',
  '流畅',
]

/** 从 { 档位名: url } 映射中挑出最低画质 */
export function pickLowestQuality(map = {}) {
  const entries = Object.entries(map).filter(([, u]) => typeof u === 'string' && u.startsWith('http'))
  if (!entries.length) return null
  entries.sort((a, b) => {
    const ia = QUALITY_ORDER.indexOf(String(a[0]).toLowerCase())
    const ib = QUALITY_ORDER.indexOf(String(b[0]).toLowerCase())
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
  const [name, url] = entries[0]
  return { quality: name, url }
}
