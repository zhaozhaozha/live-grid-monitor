import { DouyinAdapter } from './douyin.js'
import { KuaishouAdapter } from './kuaishou.js'
import { TaobaoAdapter, WxChannelAdapter, XiaohongshuAdapter } from './stub.js'
import { DirectAdapter } from './direct.js'
import { AdapterError } from './base.js'

const ADAPTER_CLASSES = [
  DouyinAdapter,
  KuaishouAdapter,
  TaobaoAdapter,
  WxChannelAdapter,
  XiaohongshuAdapter,
]

let registry = new Map()
let initialized = false

export function registerAdapters() {
  if (initialized) return registry
  registry = new Map()
  for (const Ctor of [...ADAPTER_CLASSES, DirectAdapter]) {
    const inst = new Ctor()
    registry.set(Ctor.platform, inst)
  }
  initialized = true
  return registry
}

export function listAdapters() {
  const map = {}
  for (const [key, inst] of registry) {
    const Ctor = inst.constructor
    map[key] = {
      ...Ctor.describe(),
      needCookie: ['douyin', 'kuaishou'].includes(key),
    }
  }
  return map
}

export function getAdapter(platform) {
  const a = registry.get(platform)
  if (!a) {
    throw new AdapterError(`不支持的平台：${platform}`, {
      code: 'UNKNOWN_PLATFORM',
      retryable: false,
    })
  }
  return a
}

/** 根据 URL 自动识别平台（识别失败则回落到 direct） */
export function detectPlatform(url) {
  for (const [key, inst] of registry) {
    if (key === 'direct') continue
    try {
      if (inst.matchUrl(url)) return key
    } catch {
      /* ignore */
    }
  }
  return 'direct'
}
