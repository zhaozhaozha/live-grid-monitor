import { getDb, nowIso } from '../db/index.js'
import { getAdapter, detectPlatform } from '../adapters/index.js'
import { config } from '../config.js'
import { AdapterError } from '../adapters/base.js'

/**
 * 解析房间分享链接 -> 房间元信息（写库）
 */
export async function resolveRoomInfo({ platform, shareUrl, cookie, force = false }) {
  const key = platform || detectPlatform(shareUrl)
  const adapter = getAdapter(key)
  const db = getDb()

  const existing = db
    .prepare('SELECT * FROM rooms WHERE share_url = ? ORDER BY updated_at DESC LIMIT 1')
    .get(shareUrl)

  if (existing && !force && existing.room_id) {
    return { platform: key, ...existing, cached: true }
  }

  try {
    const info = await adapter.fetchRoomInfo(shareUrl, { cookie })
    return { platform: key, ...info }
  } catch (err) {
    if (err instanceof AdapterError && existing?.room_id) {
      // 解析失败但库里已有历史记录：返回缓存，避免整页不可用
      return { platform: key, ...existing, cached: true, staleReason: err.message }
    }
    throw err
  }
}

/**
 * 获取可播放流地址，带 TTL 缓存。
 * 流地址有有效期，过期后前端会带着 rid 重新拉取。
 */
export async function getPlayableStream(room, { force = false } = {}) {
  const db = getDb()
  const key = room.room_id || room.share_url

  if (!force) {
    const cached = db.prepare('SELECT * FROM stream_cache WHERE room_id = ?').get(room.id)
    if (cached && cached.expires_at && Number(cached.expires_at) > Date.now()) {
      return {
        url: cached.stream_url,
        format: cached.format,
        quality: cached.quality,
        qualities: safeJson(cached.qualities, []),
        cached: true,
        expiresAt: Number(cached.expires_at),
      }
    }
  }

  const adapter = getAdapter(room.platform || detectPlatform(room.share_url))
  let info
  try {
    info = await adapter.fetchRoomInfo(room.share_url, { cookie: room.cookie })
  } catch (err) {
    // 部分平台（如直链）允许跳过房间解析直接取流
    info = { roomId: room.room_id, shareUrl: room.share_url, isLive: true, raw: {} }
    if (room.platform !== 'direct') throw err
  }

  let stream
  try {
    stream = await adapter.fetchStreamUrl(info.roomId || key, {
      cookie: room.cookie,
      quality: room.quality || 'lowest',
      webRid: info.webRid,
      shareUrl: room.share_url,
      roomInfo: info,
    })
  } catch (err) {
    // 主播已下播(NOT_LIVE):旧缓存里的流地址已失效(如抖音回放态),
    // 若不清除会被非 force 请求持续命中,前端拉到已结束的流反复报错。
    if (err instanceof AdapterError && err.code === 'NOT_LIVE') {
      db.prepare('DELETE FROM stream_cache WHERE room_id = ?').run(room.id)
    }
    throw err
  }

  db.prepare(
    `INSERT INTO stream_cache (room_id, stream_url, format, quality, qualities, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET
       stream_url = excluded.stream_url,
       format = excluded.format,
       quality = excluded.quality,
       qualities = excluded.qualities,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`
  ).run(
    room.id,
    stream.url,
    stream.format,
    stream.quality,
    JSON.stringify(stream.qualities || []),
    stream.expiresAt ?? Date.now() + config.streamCacheTtlSec * 1000,
    nowIso()
  )

  return { ...stream, cached: false }
}

function safeJson(s, fallback) {
  try {
    return JSON.parse(s)
  } catch {
    return fallback
  }
}
