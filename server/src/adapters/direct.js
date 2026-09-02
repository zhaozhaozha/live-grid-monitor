import { BaseAdapter, AdapterError } from './base.js'

/**
 * 直链适配器（调试 / 兜底通道）
 *
 * 直接接受 .m3u8 / .flv / .mp4 直链，不做任何平台解析。
 * 用途：
 *  1. 本地联调前端播放器（无需真实平台接口）
 *  2. 淘宝 / 视频号 / 小红书等 stub 平台的兜底接入方式
 *     —— 用浏览器抓包插件拿到直播流直链粘贴即可
 *  3. 接入自建 CDN / 转码后的低码率流
 */
export class DirectAdapter extends BaseAdapter {
  static platform = 'direct'
  static label = '直链（m3u8 / flv）'
  static stability = 'stable'
  static urlHints = [
    'https://example.com/live/room.m3u8',
    'https://example.com/live/room.flv',
  ]

  matchUrl(url) {
    return /\.(m3u8|flv|mp4)(\?|$)/i.test(url)
  }

  parseRoomId(url) {
    return url
  }

  #formatOf(url) {
    if (/\.m3u8(\?|$)/i.test(url)) return 'hls'
    if (/\.flv(\?|$)/i.test(url)) return 'flv'
    if (/\.mp4(\?|$)/i.test(url)) return 'mp4'
    throw new AdapterError('直链仅支持 .m3u8 / .flv / .mp4', {
      code: 'PARSE_FAILED',
      retryable: false,
    })
  }

  async fetchRoomInfo(url) {
    const name = decodeURIComponent(url.split('/').pop() || '').split('?')[0]
    return {
      roomId: url,
      title: name || '直链直播间',
      anchorName: '',
      avatarUrl: '',
      isLive: true,
      shareUrl: url,
      raw: {},
    }
  }

  async fetchStreamUrl(roomId) {
    return {
      url: roomId,
      format: this.#formatOf(roomId),
      quality: 'source',
      qualities: ['source'],
      expiresAt: Date.now() + 12 * 3600 * 1000,
    }
  }

  async fetchMetrics() {
    // 直链通道无法获取在线人数，返回 null 由采集层跳过统计
    return { isLive: true, onlineCount: null, likeCount: null }
  }
}
