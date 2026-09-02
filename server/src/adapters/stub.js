import { BaseAdapter, AdapterError } from './base.js'

/**
 * 未实现平台的统一占位适配器。
 *
 * 淘宝直播 / 微信视频号 / 小红书在 1.0 处于 stub 状态，原因：
 *  - 淘宝直播：流地址与流量数据均绑定登录态与 mtgsig 签名，网页端强加密；
 *    生产方案通常是「浏览器扩展 / 无头浏览器带登录态抓取」或企业开放平台授权。
 *  - 微信视频号：无公开 Web 端接口，仅支持客户端内播放与小程序登录态。
 *  - 小红书：直播接口需 x-s / x-t 签名，且风控更新频繁。
 *
 * 1.0 保留适配器骨架与 URL 识别能力，接入路径已在 docs/ARCHITECTURE.md 说明。
 */
class StubAdapter extends BaseAdapter {
  #reason
  #plan

  constructor(reason, plan) {
    super()
    this.#reason = reason
    this.#plan = plan
  }

  #fail(method) {
    throw new AdapterError(`${this.constructor.label} 1.0 暂未实现（${this.#reason}）`, {
      code: 'NOT_IMPLEMENTED',
      retryable: false,
      hint: this.#plan,
    })
  }

  async fetchRoomInfo() {
    this.#fail('fetchRoomInfo')
  }
  async fetchStreamUrl() {
    this.#fail('fetchStreamUrl')
  }
  async fetchMetrics() {
    this.#fail('fetchMetrics')
  }
}

export class TaobaoAdapter extends StubAdapter {
  static platform = 'taobao'
  static label = '淘宝直播'
  static stability = 'stub'
  static urlHints = ['https://tb.cn/xxxx', 'https://huodong.m.taobao.com/...']
  matchUrl(url) {
    return /taobao\.com|tb\.cn|tmall\.com/.test(url)
  }
  constructor() {
    super(
      '流地址与数据绑定登录态 + mtgsig 签名，纯服务端难以稳定解析',
      '建议使用「直链适配器」：在浏览器装抓包插件取到 m3u8 后粘贴；或接入淘宝开放平台授权'
    )
  }
}

export class WxChannelAdapter extends StubAdapter {
  static platform = 'wxchannel'
  static label = '微信视频号直播'
  static stability = 'stub'
  static urlHints = ['https://channels.weixin.qq.com/live/xxxx']
  matchUrl(url) {
    return /channels\.weixin\.qq\.com|weixin\.qq\.com/.test(url)
  }
  constructor() {
    super(
      '无公开 Web 端接口，仅支持微信客户端内播放与小程序登录态',
      '建议：企业微信/视频号助手后台导出，或使用「直链适配器」配合抓包'
    )
  }
}

export class XiaohongshuAdapter extends StubAdapter {
  static platform = 'xiaohongshu'
  static label = '小红书直播'
  static stability = 'stub'
  static urlHints = ['https://www.xiaohongshu.com/user/profile/xxxx']
  matchUrl(url) {
    return /xiaohongshu\.com|xhslink\.com/.test(url)
  }
  constructor() {
    super(
      '接口需 x-s / x-t 动态签名，风控更新频繁',
      '建议：先用「直链适配器」接入；2.0 计划引入可选的无头浏览器抓取通道'
    )
  }
}
