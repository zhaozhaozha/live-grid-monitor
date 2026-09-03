import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { getAdapter } from '../adapters/index.js'
import { config } from '../config.js'

/**
 * 直播流转码服务（HEVC → H.264）
 *
 * 背景：淘宝部分直播间全档位为 H.265/HEVC，且其 FLV 是 Annex-B 非标准封装——
 *   - 浏览器 MSE：Chrome 无 HEVC 硬解 → 无法播放
 *   - ffmpeg flv demuxer：只认标准 enhanced-rtmp(hvcC) 封装，同样无法解这种 FLV
 *   但同档 m3u8(HLS/TS) 为标准封装，ffmpeg 完全可解。
 * 方案：判定房间流为 HEVC 后，relay 改拉上游 m3u8，ffmpeg 实时转 H.264，
 *       以 FLV(mpegts) 形式回传浏览器（mpegts.js 原生播放，前端零改动）。
 *
 * 输出刻意去掉音频（-an）：监控九宫格本就无声，且规避 mpegts hasAudio
 * 与"部分直播间无声"的兼容坑，同时省 CPU。
 */

const CODEC_CACHE_TTL = 5 * 60 * 1000 // 编码判定缓存：房间编码长期稳定
const M3U8_CACHE_TTL = 60 * 1000 // m3u8 直链带 auth_key，短缓存防过期

/** 上游 flv 判定结果 */
export const codecOf = {
  UNKNOWN: null,
  AVC: 7,
  HEVC: 12,
}

const codecCache = new Map() // roomId -> { codec, at }
const m3u8Cache = new Map() // roomId -> { url, at }

// ---------- FLV codecid 解析 ----------

/** 从已累积的 FLV 字节里找第一个 video tag 的 codecid；数据不足返回 null */
function codecidFromFlv(buf) {
  if (buf.length < 13 || !(buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56)) return null
  let off = 9 + 4 // FLV header 9B + prevTagSize 4B
  for (let i = 0; i < 32 && off + 11 <= buf.length; i++) {
    const t = buf[off]
    const size = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
    if (off + 11 + size > buf.length) return null // tag 未收全，等下一包再解
    if (t === 9) return buf[off + 11] & 0x0f // video tag: 首字节低 4 位即 codecid
    off += 11 + size + 4
  }
  return null
}

/**
 * 拉上游 flv 首部字节判定编码。读取即 cancel，不消费整条流。
 * 返回 codecid(7/12) 或 null（网络失败/空包/数据不足均视为未知）。
 */
export async function probeFlvCodecid(url, { referer = '', timeoutMs = 8000 } = {}) {
  const ac = new AbortController()
  const tm = setTimeout(() => ac.abort(new Error('probe timeout')), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': config.userAgent,
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: 'follow',
      signal: ac.signal,
    })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    try {
      for (let i = 0; i < 4; i++) {
        const { value, done } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
        total += value.length
        const codecid = codecidFromFlv(Buffer.concat(chunks))
        if (codecid !== null) return codecid
        if (total > 256 * 1024) break // 数据异常：正常 1-2 包内必含 seq header
      }
    } finally {
      try { await reader.cancel() } catch {}
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(tm)
  }
}

// ---------- 编码判定缓存 ----------

export function cachedCodec(roomId) {
  const hit = codecCache.get(roomId)
  if (!hit) return codecOf.UNKNOWN
  if (Date.now() - hit.at > CODEC_CACHE_TTL) {
    codecCache.delete(roomId)
    return codecOf.UNKNOWN
  }
  return hit.codec
}

export function rememberCodec(roomId, codecid) {
  if (codecid === 7 || codecid === 12) codecCache.set(roomId, { codec: codecid, at: Date.now() })
}

// ---------- m3u8 源解析 ----------

function collectUrls(node, out = [], path = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const it of node) collectUrls(it, out, path)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && /^https?:\/\/[^\s"']+\.(m3u8|flv)(\?[^\s"']*)?$/.test(v.trim())) {
      out.push({ key: [...path, k].join('.'), url: v.trim() })
    } else {
      collectUrls(v, out, [...path, k])
    }
  }
  return out
}

/**
 * 从淘宝直播间候选流里解析一个可转码的 m3u8 地址（60s 缓存）。
 * 优先级：liveUrlHls > liveplatform dynamicResolution 转码档 > 任一 hls。
 */
export async function resolveTaobaoM3u8(room) {
  const hit = m3u8Cache.get(room.id)
  if (hit && Date.now() - hit.at < M3U8_CACHE_TTL) return hit.url

  const adapter = getAdapter('taobao')
  const info = await adapter.fetchRoomInfo(room.share_url, { cookie: room.cookie })
  const cands = collectUrls(info?.raw?.body || {}).filter((c) => c.url.includes('.m3u8'))
  if (!cands.length) return null

  const byKey = (suffix) => cands.find((c) => c.key.endsWith(suffix))?.url
  const url =
    byKey('liveUrlHls') ||
    cands.find((c) => c.url.includes('/liveplatform/') && c.url.includes('dynamicResolution'))?.url ||
    cands[0].url
  if (!url) return null
  m3u8Cache.set(room.id, { url, at: Date.now() })
  return url
}

// ---------- ffmpeg 转码进程 ----------

/**
 * 起一个 ffmpeg 实时转码进程：拉 HEVC m3u8 → H.264 FLV 到 stdout。
 * @param {string} m3u8Url
 * @param {{ referer?: string }} opts
 * @returns {{ proc: import('node:child_process').ChildProcess, stream: import('node:stream').Readable, stderrTail: () => string }}
 */
export function spawnTranscoder(m3u8Url, { referer = '' } = {}) {
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-err_detect', 'ignore_err', // 单分片损坏不整体退出
    ...(referer ? ['-headers', `Referer: ${referer}\r\n`] : []),
    '-user_agent', config.userAgent,
    '-i', m3u8Url,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-an', // 监控场景无声；规避 hasAudio 兼容坑
    '-f', 'flv',
    'pipe:1',
  ]
  const proc = spawn(ffmpegStatic, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let errBuf = ''
  proc.stderr?.on('data', (d) => {
    errBuf = (errBuf + String(d)).slice(-6000)
  })
  proc.once('error', () => {}) // ENOENT 等；错误由 exit/stream error 暴露，防 unhandled
  return { proc, stream: proc.stdout, stderrTail: () => errBuf }
}

export function killTranscoder(proc) {
  if (!proc || proc.exitCode !== null) return
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
}
