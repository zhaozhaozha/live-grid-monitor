import { getDb, nowIso, uid } from '../db/index.js'
import { getAdapter, detectPlatform } from '../adapters/index.js'
import { config } from '../config.js'

/**
 * 直播数据采集器
 *
 * 每 pollIntervalSec 秒轮询一次所有启用房间，完成三件事：
 *   1. 写入 metrics_samples 采样点（在线人数 / 点赞数）
 *   2. 维护 live_sessions 场次生命周期（开播 -> 下播）
 *   3. 刷新 rooms 表里的标题 / 主播名
 *
 * 离线判定采用「宽限计数」：连续 offlineGraceCount 次判定离线才关场，
 * 避免平台接口抖动导致一场直播被切成多段。
 */
const offlineStreak = new Map()
/** 房间级失败退避：{ roomId: { fails, until } }，避免对风控/下线接口高频重试 */
const failureBackoff = new Map()
const BACKOFF_MIN_MS = 5 * 60 * 1000
const BACKOFF_MAX_MS = 60 * 60 * 1000

let timer = null
let running = false

export function startPoller() {
  if (timer) return
  const intervalMs = Math.max(10, Number(process.env.POLL_INTERVAL_SEC || 30)) * 1000
  timer = setInterval(() => {
    tick().catch((err) => console.error('[poller] tick failed:', err.message))
  }, intervalMs)
  timer.unref?.()
  // 启动后立刻跑一轮
  setTimeout(() => tick().catch(() => {}), 1500)
}

export function stopPoller() {
  if (timer) clearInterval(timer)
  timer = null
}

/** 供测试/手动恢复使用：清空某房间的失败退避 */
export function clearBackoff(roomId) {
  failureBackoff.delete(roomId)
}

export async function tick() {
  if (running) return { skipped: true }
  running = true
  const db = getDb()
  const rooms = db.prepare('SELECT * FROM rooms WHERE enabled = 1').all()
  const results = []
  const now = Date.now()

  for (const room of rooms) {
    const backoff = failureBackoff.get(room.id)
    if (backoff && backoff.until > now) {
      results.push({
        roomId: room.id,
        ok: false,
        skipped: true,
        error: `解析接口连续失败，已退避 ${Math.round((backoff.until - now) / 60000)} 分钟后重试`,
      })
      continue
    }
    try {
      const r = await pollRoom(room)
      failureBackoff.delete(room.id)
      results.push(r)
    } catch (err) {
      const prev = failureBackoff.get(room.id) || { fails: 0, until: 0 }
      const fails = prev.fails + 1
      const wait = Math.min(BACKOFF_MAX_MS, fails * BACKOFF_MIN_MS)
      failureBackoff.set(room.id, { fails, until: Date.now() + wait })
      db.prepare('UPDATE rooms SET last_error = ?, updated_at = ? WHERE id = ?').run(
        `${String(err.message).slice(0, 400)}（接口暂不可用，${Math.round(wait / 60000)} 分钟后自动重试）`,
        nowIso(),
        room.id
      )
      results.push({ roomId: room.id, ok: false, error: err.message, backoffMs: wait })
    }
  }
  running = false
  return { ok: true, count: rooms.length, results }
}

async function pollRoom(room) {
  const db = getDb()
  const adapter = getAdapter(room.platform || detectPlatform(room.share_url))

  let info
  try {
    info = await adapter.fetchRoomInfo(room.share_url, { cookie: room.cookie })
  } catch (err) {
    if (room.platform === 'direct') {
      info = { isLive: true, title: room.title, anchorName: room.anchor_name, roomId: room.room_id }
    } else {
      throw err
    }
  }

  const metrics =
    (await adapter.fetchMetrics(info.roomId || room.room_id, {
      cookie: room.cookie,
      webRid: info.webRid,
      shareUrl: room.share_url,
      roomInfo: info,
    })) || {}

  const isLive = Boolean(metrics.isLive ?? info.isLive)
  const online = metrics.onlineCount ?? null
  const ts = nowIso()

  // 更新房间元信息
  db.prepare(
    `UPDATE rooms SET title = ?, anchor_name = ?, avatar_url = ?, room_id = ?, last_error = NULL, updated_at = ?
     WHERE id = ?`
  ).run(info.title || room.title, info.anchorName || room.anchor_name, info.avatarUrl || room.avatar_url, info.roomId || room.room_id, ts, room.id)

  // 场次生命周期
  const openSession = db
    .prepare('SELECT * FROM live_sessions WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1')
    .get(room.id)

  let sessionId = openSession?.id || null

  if (isLive) {
    offlineStreak.set(room.id, 0)
    if (!openSession) {
      sessionId = uid('ses')
      db.prepare(
        `INSERT INTO live_sessions (id, room_id, start_at) VALUES (?, ?, ?)`
      ).run(sessionId, room.id, ts)
    }
  } else {
    const streak = (offlineStreak.get(room.id) || 0) + 1
    offlineStreak.set(room.id, streak)
    if (openSession && streak >= config.offlineGraceCount) {
      closeSession(openSession)
      sessionId = null
    }
  }

  // 采样点
  db.prepare(
    `INSERT INTO metrics_samples (room_id, session_id, ts, online_count, like_count, is_live)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(room.id, sessionId, ts, online, metrics.likeCount ?? null, isLive ? 1 : 0)

  return { roomId: room.id, isLive, online, sessionId }
}

/** 关场：结算时长、峰值/均值在线、广告统计 */
export function closeSession(session) {
  const db = getDb()
  const endAt = nowIso()
  const start = new Date(session.start_at).getTime()
  const end = Date.now()
  const durationSec = Math.max(0, Math.round((end - start) / 1000))

  const agg = db
    .prepare(
      `SELECT
         COALESCE(MAX(online_count), 0) AS peak,
         COALESCE(AVG(online_count), 0) AS avg,
         COUNT(online_count) AS n
       FROM metrics_samples WHERE session_id = ? AND online_count IS NOT NULL`
    )
    .get(session.id)

  const ad = db
    .prepare(
      `SELECT COUNT(1) AS c, COALESCE(SUM(duration_sec), 0) AS d
       FROM ad_segments WHERE session_id = ?`
    )
    .get(session.id)

  db.prepare(
    `UPDATE live_sessions
     SET end_at = ?, duration_sec = ?, peak_online = ?, avg_online = ?, sample_count = ?,
         ad_count = ?, ad_duration_sec = ?
     WHERE id = ?`
  ).run(
    endAt,
    durationSec,
    agg.peak,
    Math.round(agg.avg),
    agg.n,
    ad.c,
    ad.d,
    session.id
  )
}

/** 关掉某房间的所有未结算场次（用于删除房间 / 手动停采） */
export function closeAllSessions(roomId) {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM live_sessions WHERE room_id = ? AND end_at IS NULL')
    .all(roomId)
  for (const s of rows) closeSession(s)
  return rows.length
}
