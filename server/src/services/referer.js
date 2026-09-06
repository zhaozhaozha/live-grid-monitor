/** 各平台直播流需要的 Referer，与 streams/transcode 共用一份，避免多处漂移 */
export const PLATFORM_REFERER = {
  taobao: 'https://tbzb.taobao.com/',
  jd: 'https://lives.jd.com/',
  douyin: 'https://webcast.amemv.com/',
  kuaishou: 'https://live.kuaishou.com/',
  wxchannel: 'https://channels.weixin.qq.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/',
}

export const refererOf = (platform) => PLATFORM_REFERER[platform] || ''
