import { getDb, nowIso, uid } from '../db/index.js'

export default async function metricsRoutes(app) {
  /** 前端广告自动识别上报：开段 */
  app.post('/ad-segments/open', async (req, reply) => {
    const { roomId, startAt, confidence = 0, signals = {} } = req.body || {}
    if (!roomId) return reply.code(400).send({ error: '缺少 roomId' })
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    const session = db
      .prepare('SELECT id FROM live_sessions WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1')
      .get(roomId)

    const id = uid('ad')
    db.prepare(
      `INSERT INTO ad_segments (id, room_id, session_id, start_at, confidence, signals, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'auto', ?)`
    ).run(id, roomId, session?.id || null, startAt || nowIso(), confidence, JSON.stringify(signals), nowIso())

    return reply.code(201).send({ id })
  })

  /** 前端上报：闭段（结算时长） */
  app.post('/ad-segments/:id/close', async (req, reply) => {
    const { endAt, note } = req.body || {}
    const db = getDb()
    const seg = db.prepare('SELECT * FROM ad_segments WHERE id = ?').get(req.params.id)
    if (!seg) return reply.code(404).send({ error: '广告段不存在' })

    const end = endAt || nowIso()
    const duration = Math.max(0, Math.round((new Date(end) - new Date(seg.start_at)) / 1000))

    db.prepare(
      `UPDATE ad_segments SET end_at = ?, duration_sec = ?, note = COALESCE(?, note) WHERE id = ?`
    ).run(end, duration, note ?? null, req.params.id)

    // 过短（<5s）的判定视为噪声，直接丢弃
    if (duration < 5) {
      db.prepare('DELETE FROM ad_segments WHERE id = ?').run(req.params.id)
      return { ok: true, discarded: true, reason: 'duration<5s' }
    }
    return { ok: true, durationSec: duration }
  })

  /** 人工校正：把某段时间标记为/取消标记为广告 */
  app.post('/ad-segments/manual', async (req, reply) => {
    const { roomId, startAt, endAt, isAd = true, note } = req.body || {}
    if (!roomId || !startAt || !endAt) {
      return reply.code(400).send({ error: '缺少 roomId / startAt / endAt' })
    }
    const db = getDb()
    const session = db
      .prepare('SELECT id FROM live_sessions WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1')
      .get(roomId)

    const duration = Math.max(0, Math.round((new Date(endAt) - new Date(startAt)) / 1000))

    if (!isAd) {
      // 取消标记：把覆盖区间内的自动广告段标为已校正并置零置信度
      db.prepare(
        `UPDATE ad_segments SET verified = 1, note = ?
         WHERE room_id = ? AND start_at >= ? AND COALESCE(end_at, ?) <= ?`
      ).run(note || '人工取消', roomId, startAt, endAt, endAt)
      return { ok: true, updated: true }
    }

    const id = uid('ad')
    db.prepare(
      `INSERT INTO ad_segments (id, room_id, session_id, start_at, end_at, duration_sec,
                                confidence, signals, source, verified, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, '{}', 'manual', 1, ?, ?)`
    ).run(id, roomId, session?.id || null, startAt, endAt, duration, note || '人工标记', nowIso())
    return reply.code(201).send({ id, durationSec: duration })
  })

  app.get('/ad-segments', async (req) => {
    const { roomId, from, to } = req.query
    const db = getDb()
    const where = []
    const args = []
    if (roomId) { where.push('room_id = ?'); args.push(roomId) }
    if (from) { where.push('start_at >= ?'); args.push(from) }
    if (to) { where.push('start_at <= ?'); args.push(to) }
    const sql = `SELECT * FROM ad_segments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY start_at DESC LIMIT 500`
    return { items: db.prepare(sql).all(...args) }
  })
}
