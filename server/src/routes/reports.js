import { getDb } from '../db/index.js'

const DEFAULT_RANGE_DAYS = 7

function range(req) {
  const days = Number(req.query.days || DEFAULT_RANGE_DAYS)
  const to = req.query.to ? new Date(req.query.to) : new Date()
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - days * 864e5)
  return { from: from.toISOString(), to: to.toISOString() }
}

// ---------------- CSV 工具 ----------------

/** 含逗号/引号/换行的字段需要加引号并转义内部引号 */
const esc = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** ISO → 本地时间 "YYYY-MM-DD HH:MM:SS"（避免导出文件里出现 UTC 造成时间对不上） */
const fmtLocal = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const minutes = (sec) => (sec / 60).toFixed(1)
const ratio = (adSec, liveSec) => (liveSec ? ((adSec / liveSec) * 100).toFixed(1) + '%' : '0%')

/**
 * Content-Disposition：ASCII 名兜底 + RFC 5987 中文名。
 * 只用中文名会在部分环境乱码，只用 ASCII 名则用户下载后分不清是哪个直播间。
 */
function disposition(displayName, asciiName) {
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`
}

function sendCsv(reply, { displayName, asciiName, lines }) {
  reply.header('Content-Type', 'text/csv; charset=utf-8')
  reply.header('Content-Disposition', disposition(displayName, asciiName))
  // Excel 需要 BOM 才能正确识别 UTF-8 中文
  return '\uFEFF' + lines.map((r) => r.map(esc).join(',')).join('\r\n')
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

  /** 全局 CSV 导出（可直接 Excel 打开）—— 一行一场次，含所有直播间 */
  app.get('/export.csv', async (req, reply) => {
    const { from, to } = range(req)
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT r.platform, r.title, r.anchor_name, s.duration_sec, s.start_at, s.end_at,
                s.peak_online, s.avg_online, s.ad_count, s.ad_duration_sec
         FROM live_sessions s JOIN rooms r ON r.id = s.room_id
         WHERE s.start_at >= ? AND s.start_at <= ?
         ORDER BY r.platform, s.start_at DESC`
      )
      .all(from, to)

    const lines = [
      ['平台', '直播间', '主播', '开播时间', '下播时间',
       '直播时长(分钟)', '峰值在线', '平均在线', '广告段数', '广告时长(分钟)', '广告占比'],
    ]
    for (const r of rows) {
      lines.push([
        r.platform, r.title, r.anchor_name,
        fmtLocal(r.start_at), r.end_at ? fmtLocal(r.end_at) : '进行中',
        minutes(r.duration_sec), r.peak_online, r.avg_online,
        r.ad_count, minutes(r.ad_duration_sec),
        ratio(r.ad_duration_sec, r.duration_sec),
      ])
    }
    return sendCsv(reply, {
      displayName: `直播统计报表_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      asciiName: `live-report-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      lines,
    })
  })

  /**
   * 单直播间统计报表导出
   * 一份文件 = 一个直播间的完整台账：汇总 + 场次明细 + 广告时段明细。
   */
  app.get('/room/:id/export.csv', async (req, reply) => {
    const { id } = req.params
    const { from, to } = range(req)
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    const sessions = db
      .prepare(
        `SELECT * FROM live_sessions
         WHERE room_id = ? AND start_at >= ? AND start_at <= ?
         ORDER BY start_at DESC`
      )
      .all(id, from, to)

    const ads = db
      .prepare(
        `SELECT * FROM ad_segments
         WHERE room_id = ? AND start_at >= ? AND start_at <= ?
         ORDER BY start_at DESC`
      )
      .all(id, from, to)

    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0)
    const liveSec = sum(sessions, (s) => s.duration_sec)
    const adSec = sum(ads, (a) => a.duration_sec)
    const peak = sessions.reduce((a, s) => Math.max(a, s.peak_online || 0), 0)
    const avgOnline = sessions.length
      ? Math.round(sum(sessions, (s) => s.avg_online || 0) / sessions.length)
      : 0

    const name = room.anchor_name || room.title || '直播间'
    const lines = [
      ['直播数据统计报表'],
      ['直播间', room.title || ''],
      ['主播', room.anchor_name || ''],
      ['平台', room.platform],
      ['统计区间', `${fmtLocal(from)} ~ ${fmtLocal(to)}`],
      ['导出时间', fmtLocal(new Date().toISOString())],
      [],
      ['—— 汇总 ——'],
      ['直播场次', sessions.length, '场'],
      ['直播总时长', (liveSec / 3600).toFixed(2), '小时'],
      ['峰值在线', peak, '人'],
      ['平均在线', avgOnline, '人'],
      ['广告段数', ads.length, '段'],
      ['广告总时长', minutes(adSec), '分钟'],
      ['广告时长占比', ratio(adSec, liveSec)],
      [],
      ['—— 场次明细 ——'],
      ['开播时间', '下播时间', '时长(分钟)', '峰值在线', '平均在线', '广告段数', '广告时长(分钟)', '广告占比'],
    ]

    for (const s of sessions) {
      lines.push([
        fmtLocal(s.start_at), s.end_at ? fmtLocal(s.end_at) : '进行中',
        minutes(s.duration_sec), s.peak_online, s.avg_online,
        s.ad_count, minutes(s.ad_duration_sec),
        ratio(s.ad_duration_sec, s.duration_sec),
      ])
    }
    if (!sessions.length) lines.push(['该统计区间内无直播场次'])

    lines.push([], ['—— 广告时段明细 ——'])
    lines.push(['开始时间', '结束时间', '时长(秒)', '置信度', '来源', '备注'])
    for (const a of ads) {
      lines.push([
        fmtLocal(a.start_at), a.end_at ? fmtLocal(a.end_at) : '进行中',
        a.duration_sec, `${Math.round((a.confidence || 0) * 100)}%`,
        a.source === 'manual' ? '人工' : '自动',
        a.note || '',
      ])
    }
    if (!ads.length) lines.push(['该统计区间内未记录到广告时段'])

    return sendCsv(reply, {
      displayName: `直播报表_${name}_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      asciiName: `live-report-${room.id}-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`,
      lines,
    })
  })
}
