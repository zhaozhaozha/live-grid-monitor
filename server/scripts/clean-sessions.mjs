/**
 * 场次清洗：把被错误合并的「超长场次」按采样间隙拆回真实场次。
 *
 * ── 问题 ────────────────────────────────────────────────
 * 服务重启/关场判定失效时，一场直播会挂着不结算，等下次被关场时
 * 用「现在」结算 —— 于是两场真实直播之间的停机时长被算进直播时长，
 * 产生 40 小时这类明显失真的场次（实测单场 2424 分钟）。
 *
 * ── 判据 ────────────────────────────────────────────────
 * poller 每 pollIntervalSec(默认 30s) 采样一次，正常相邻采样间隔 ≤ 60s。
 * 若一个场次内部出现 > GAP_SEC(默认 30 分钟) 的采样空档，
 * 说明中间其实停播了 —— 在空档处切开，拆成多场真实直播。
 *
 * ── 用法 ────────────────────────────────────────────────
 *   node scripts/clean-sessions.mjs --dry-run   # 只报告，不改数据
 *   node scripts/clean-sessions.mjs             # 执行拆分
 *   GAP_SEC=3600 node scripts/clean-sessions.mjs
 *
 * 执行前请自行备份 data/live-grid.db。
 */

import { getDb, uid } from '../src/db/index.js'

const GAP_SEC = Number(process.env.GAP_SEC || 1800)
const dryRun = process.argv.includes('--dry-run')

const db = getDb()

const secBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 1000

/** 重新结算一场：时长、峰值/均值在线、广告统计，并回收该时段的广告段归属 */
function resettle(sessionId, roomId, startTs, endTs) {
  const duration = Math.max(0, Math.round(secBetween(startTs, endTs)))

  // 采样点归属：把落在区间内的采样点挂到本场（拆分后其它场已先移走自己的）
  db.prepare('UPDATE metrics_samples SET session_id = ? WHERE room_id = ? AND ts >= ? AND ts <= ? AND (session_id IS NULL OR session_id = ?)')
    .run(sessionId, roomId, startTs, endTs, sessionId)

  const agg = db
    .prepare(
      `SELECT COALESCE(MAX(online_count),0) AS peak, COALESCE(AVG(online_count),0) AS avg,
              COUNT(online_count) AS n
       FROM metrics_samples WHERE session_id = ? AND online_count IS NOT NULL`
    )
    .get(sessionId)

  db.prepare('UPDATE ad_segments SET session_id = ? WHERE room_id = ? AND start_at >= ? AND start_at <= ?')
    .run(sessionId, roomId, startTs, endTs)

  const ad = db
    .prepare('SELECT COUNT(1) AS c, COALESCE(SUM(duration_sec),0) AS d FROM ad_segments WHERE session_id = ?')
    .get(sessionId)

  db.prepare(
    `UPDATE live_sessions
     SET start_at = ?, end_at = ?, duration_sec = ?, peak_online = ?, avg_online = ?,
         sample_count = ?, ad_count = ?, ad_duration_sec = ?
     WHERE id = ?`
  ).run(
    startTs, endTs, duration,
    agg.peak, Math.round(agg.avg), agg.n,
    ad.c, ad.d,
    sessionId
  )
  return duration
}

const sessions = db
  .prepare('SELECT * FROM live_sessions ORDER BY room_id, start_at')
  .all()

const plan = []

for (const s of sessions) {
  const samples = db
    .prepare('SELECT ts FROM metrics_samples WHERE session_id = ? ORDER BY ts ASC')
    .all(s.id)
  if (samples.length < 2) continue

  const cuts = []
  for (let i = 1; i < samples.length; i++) {
    if (secBetween(samples[i - 1].ts, samples[i].ts) > GAP_SEC) cuts.push(i)
  }
  if (!cuts.length) continue

  const groups = []
  let st = 0
  for (const c of cuts) {
    groups.push([st, c])
    st = c
  }
  groups.push([st, samples.length])

  plan.push({
    session: s,
    parts: groups.map(([a, b]) => ({
      start: samples[a].ts,
      end: samples[b - 1].ts,
      samples: b - a,
    })),
  })
}

console.log(`扫描 ${sessions.length} 个场次，采样间隙阈值 ${GAP_SEC}s`)
console.log(`发现 ${plan.length} 个场次内部存在停播空档，需要拆分\n`)

for (const p of plan) {
  console.log(`场次 ${p.session.id}（房间 ${p.session.room_id}）`)
  console.log(`  原记录：${p.session.start_at} → ${p.session.end_at || '(未关场)'}  时长 ${(p.session.duration_sec / 60).toFixed(1)} 分钟`)
  p.parts.forEach((part, i) => {
    console.log(
      `  拆为第 ${i + 1} 段：${part.start} → ${part.end}  约 ${(secBetween(part.start, part.end) / 60).toFixed(1)} 分钟（${part.samples} 个采样点）`
    )
  })
  console.log('')
}

if (dryRun) {
  console.log('--dry-run：未修改任何数据。确认无误后去掉 --dry-run 再执行。')
  process.exit(0)
}

if (!plan.length) {
  console.log('没有需要清洗的场次。')
  process.exit(0)
}

// 显式事务：better-sqlite3 有 transaction()，node:sqlite(DatabaseSync) 没有，
// 用 BEGIN/COMMIT 两种驱动都支持。
db.exec('BEGIN')
try {
  for (const p of plan) {
    const s = p.session
    // 第 1 段沿用原场次 id，其余新建
    const ids = [s.id]
    for (let i = 1; i < p.parts.length; i++) {
      const newId = uid('ses')
      db.prepare('INSERT INTO live_sessions (id, room_id, start_at) VALUES (?, ?, ?)').run(
        newId, s.room_id, p.parts[i].start
      )
      ids.push(newId)
    }
    // 先把后续段的采样点挪到新场次，避免被第 1 段结算时吞掉
    for (let i = 1; i < p.parts.length; i++) {
      db.prepare(
        'UPDATE metrics_samples SET session_id = ? WHERE room_id = ? AND ts >= ? AND ts <= ? AND session_id = ?'
      ).run(ids[i], s.room_id, p.parts[i].start, p.parts[i].end, s.id)
    }
    p.parts.forEach((part, i) => resettle(ids[i], s.room_id, part.start, part.end))
  }
  db.exec('COMMIT')
} catch (err) {
  try {
    db.exec('ROLLBACK')
  } catch {
    /* 已回滚 */
  }
  console.error('清洗失败，已回滚：', err.message)
  process.exit(1)
}

console.log(`完成：${plan.length} 个场次已拆分。`)
