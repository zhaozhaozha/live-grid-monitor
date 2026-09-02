import { getDb } from '../db/index.js'

const DEFAULT_RANGE_DAYS = 7

function range(req) {
  const days = Number(req.query.days || DEFAULT_RANGE_DAYS)
  const to = req.query.to ? new Date(req.query.to) : new Date()
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - days * 864e5)
  return { from: from.toISOString(), to: to.toISOString() }
}

export default async function reportsRoutes(app) {
  /** 总览卡片 */
  app.get('/summary', async (req) => {
    const { from, to } = range(req)
    const db = getDb()

    const rooms = db.prepare('SELECT COUNT(1) c FROM rooms WHERE enabled = 1').get().c
    const sessions = db
      .prepare(
        `SELECT COUNT(1) c,
                COALESCE(SUM(duration_sec),0) dur,
                COALESCE(MAX(peak_online),0) peak,
                COALESCE(SUM(ad_duration_sec),0) adDur,
                COALESCE(SUM(ad_count),0) adCnt
         FROM live_sessions WHERE start_at >= ? AND start_at <= ?`
      )
      .get(from, to)

    return {
      range: { from, to },
      activeRooms: rooms,
      sessionCount: sessions.c,
      totalLiveSec: sessions.dur,
      totalLiveHours: +(sessions.dur / 3600).toFixed(2),
      peakOnline: sessions.peak,
      totalAdSec: sessions.adDur,
      totalAdCount: sessions.adCnt,
      adRatio: sessions.dur ? +(sessions.adDur / sessions.dur).toFixed(4) : 0,
    }
  })

  /** 按房间聚合 */
  app.get('/by-room', async (req) => {
    const { from, to } = range(req)
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT
           r.id, r.platform, r.title, r.anchor_name, r.avatar_url, r.slot,
           COUNT(s.id)                              AS sessionCount,
           COALESCE(SUM(s.duration_sec),0)          AS liveSec,
           COALESCE(MAX(s.peak_online),0)           AS peakOnline,
           COALESCE(AVG(s.avg_online),0)            AS avgOnline,
           COALESCE(SUM(s.ad_count),0)              AS adCount,
           COALESCE(SUM(s.ad_duration_sec),0)       AS adSec
         FROM rooms r
         LEFT JOIN live_sessions s ON s.room_id = r.id AND s.start_at >= ? AND s.start_at <= ?
         GROUP BY r.id
         ORDER BY liveSec DESC`
      )
      .all(from, to)

    const items = rows.map((r) => ({
      ...r,
      liveHours: +(r.liveSec / 3600).toFixed(2),
      adHours: +(r.adSec / 3600).toFixed(2),
      avgOnline: Math.round(r.avgOnline),
      adRatio: r.liveSec ? +(r.adSec / r.liveSec).toFixed(4) : 0,
    }))
    return { range: { from, to }, items }
  })

  /** 单房间明细：在线人数曲线 + 广告段时间轴 */
  app.get('/room/:id', async (req, reply) => {
    const { id } = req.params
    const { from, to } = range(req)
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    const sessions = db
      .prepare(
        `SELECT * FROM live_sessions WHERE room_id = ? AND start_at >= ? AND start_at <= ? ORDER BY start_at DESC`
      )
      .all(id, from, to)

    const onlineSeries = db
      .prepare(
        `SELECT ts, online_count FROM metrics_samples
         WHERE room_id = ? AND ts >= ? AND ts <= ? AND online_count IS NOT NULL
         ORDER BY ts ASC`
      )
      .all(id, from, to)
      .map((r) => ({ t: r.ts, v: r.online_count }))

    const adSegments = db
      .prepare(
        `SELECT * FROM ad_segments WHERE room_id = ? AND start_at >= ? AND start_at <= ? ORDER BY start_at DESC LIMIT 200`
      )
      .all(id, from, to)

    return { range: { from, to }, room, sessions, onlineSeries, adSegments }
  })

  /** CSV 导出（可直接 Excel 打开） */
  app.get('/export.csv', async (req, reply) => {
    const { from, to } = range(req)
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT
           r.platform, r.title, r.anchor_name,
           datetime(s.start_at, 'localtime') AS start_at,
           datetime(s.end_at,   'localtime') AS end_at,
           s.duration_sec, s.peak_online, s.avg_online, s.ad_count, s.ad_duration_sec
         FROM live_sessions s JOIN rooms r ON r.id = s.room_id
         WHERE s.start_at >= ? AND s.start_at <= ?
         ORDER BY s.start_at DESC`
      )
      .all(from, to)

    const header = [
      '平台', '直播间', '主播', '开播时间', '下播时间',
      '直播时长(秒)', '峰值在线', '平均在线', '广告段数', '广告时长(秒)', '广告占比',
    ]
    const esc = (v) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = [header.join(',')]
    for (const r of rows) {
      lines.push(
        [
          r.platform, r.title, r.anchor_name, r.start_at, r.end_at || '',
          r.duration_sec, r.peak_online, r.avg_online, r.ad_count, r.ad_duration_sec,
          r.duration_sec ? (r.ad_duration_sec / r.duration_sec).toFixed(4) : '0',
        ].map(esc).join(',')
      )
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="live-report-${from.slice(0, 10)}_${to.slice(0, 10)}.csv"`)
    // Excel 需要 BOM 才能正确识别 UTF-8 中文
    return '\uFEFF' + lines.join('\r\n')
  })
}
