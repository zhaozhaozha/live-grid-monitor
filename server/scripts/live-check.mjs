/**
 * 活网集成验证（可选，需能直连平台）：
 *   验证三条真实直播间链接（淘宝+京东+抖音）能否“同时加入监控台”
 *   → 同轮采集并存 → 数据入库 → 报表聚合。
 *
 * 用法： node scripts/live-check.mjs
 * 依赖真实网络与平台接口可用；仅供人工验收，不参与 CI（smoke.mjs 才是离线回归）。
 */
import fs from 'node:fs'

process.env.DB_FILE = process.env.DB_FILE || '/tmp/lgm-live-check.db'
process.env.POLL_INTERVAL_SEC = '3600'
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(process.env.DB_FILE + suffix, { force: true })
}

const { getDb, nowIso, uid } = await import('../src/db/index.js')
const { registerAdapters, getAdapter } = await import('../src/adapters/index.js')
const { tick } = await import('../src/services/poller.js')

// 被测的真实分享链接（替换成你想验证的直播间即可）
const LINKS = [
  {
    platform: 'taobao',
    url: 'https://tbzb.taobao.com/live?liveId=4296685337829049&spm=a1z10.1-b-s.float.float_live',
  },
  {
    platform: 'jd',
    url: 'https://3.cn/-31zORBc',
  },
  {
    // App 分享短链 → webcast reflow 通道（适配器从 HTML 内嵌 RSC 还原，零 Cookie）
    platform: 'douyin',
    url: 'https://v.douyin.com/lFyhuxfcKXk/',
  },
]

registerAdapters()
const db = getDb()
const now = nowIso()

console.log(`\n${'='.repeat(60)}`)
console.log('  活网集成验证：三条真实直播间（淘宝+京东+抖音）“同时打开”')
console.log('='.repeat(60))

// 1) 预解析两条链接（模拟“粘贴分享链接 → 自动识别平台并占位/保存”）
const rooms = []
for (const { platform, url } of LINKS) {
  const a = getAdapter(platform)
  const id = uid('room')
  try {
    const info = await a.fetchRoomInfo(url, {})
    db.prepare(
      `INSERT INTO rooms (id, platform, share_url, room_id, title, anchor_name, slot, quality, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'lowest', 1, ?, ?)`
    ).run(id, platform, url, info.roomId || null, info.title || url, info.anchorName || '', rooms.length, now, now)
    rooms.push({ id, platform, liveId: info.roomId, title: info.title || '(未获取)' })
    console.log(`\n[${platform}] 解析成功  liveId=${info.roomId}  isLive=${info.isLive}`)
    if (info.title) console.log(`           标题：${info.title}`)
  } catch (err) {
    console.log(`\n[${platform}] 预解析失败：${err.code} ${err.message}`)
    // 失败也占位保存（与 POST /rooms 行为一致：占位 + last_error）
    db.prepare(
      `INSERT INTO rooms (id, platform, share_url, room_id, title, slot, quality, enabled, last_error, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'lowest', 1, ?, ?, ?)`
    ).run(id, platform, url, url, rooms.length, String(err.message).slice(0, 300), now, now)
    rooms.push({ id, platform, liveId: null, title: '(解析失败占位)' })
  }
}

// 2) 同轮采集（tick 会为两条房间各自 fetchRoomInfo + fetchMetrics + 建场次/采样）
console.log(`\n${'-'.repeat(60)}\n执行同一轮采集（tick）...`)
const r = await tick()
console.log('采集结果：')
for (const item of r.results) {
  const room = rooms.find((x) => x.id === item.roomId)
  console.log(
    `  [${room?.platform}] room=${room?.title?.slice(0, 18)}  isLive=${item.isLive}  online=${item.online ?? '—'}  session=${item.sessionId ? '已开' : item.error ? '失败' : '未开'}`
  )
}

// 3) 并行存活检查：两个场次同时 open？
const sessions = db.prepare('SELECT s.id, r.platform, r.room_id, s.start_at FROM live_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.end_at IS NULL ORDER BY s.start_at').all()
console.log(`\n当前并存进行中的场次：${sessions.length} 个`)
for (const s of sessions) console.log(`  [${s.platform}] liveId=${s.room_id}  开播于 ${s.start_at}`)

// 4) 第二次采样（模拟持续监控），验证采样点累加
const r2 = await tick()
const samples = db.prepare(
  `SELECT r.platform, COUNT(*) AS n, MAX(m.online_count) AS peak, ROUND(AVG(m.online_count),1) AS avg
   FROM metrics_samples m JOIN rooms r ON r.id = m.room_id GROUP BY r.platform ORDER BY r.platform`
).all()
console.log(`\n两轮采集后的采样点统计：`)
for (const s of samples) console.log(`  [${s.platform}] 采样 ${s.n} 点 | 峰值 ${s.peak ?? '—'} | 均值 ${s.avg ?? '—'}`)

// 5) 报表聚合（与 GET /api/reports 同语义）
console.log(`\n${'-'.repeat(60)}\n报表聚合（按房间）：`)
const report = db
  .prepare(
    `SELECT r.platform, r.room_id, r.title, COUNT(DISTINCT s.id) AS 场次数,
            COALESCE(MAX(s.peak_online), 0) AS 峰值在线, COALESCE(SUM(s.ad_duration_sec), 0) AS 广告秒
     FROM rooms r LEFT JOIN live_sessions s ON s.room_id = r.id
     GROUP BY r.id ORDER BY r.slot`
  )
  .all()
for (const row of report) {
  console.log(
    `  [${row.platform}] ${String(row.title).slice(0, 20)} | 场次 ${row.场次数} | 峰值在线 ${row.峰值在线} | 广告 ${row.广告秒}s`
  )
}

console.log(`\n${'='.repeat(60)}`)
const bothLive = sessions.length === LINKS.length
console.log(bothLive ? '✅ 结论：两条真实直播间已“同时打开”并存采集，数据与报表链路正常' : '⚠️ 结论：部分房间未能在本轮存活（见上方明细）')
console.log('='.repeat(60))
process.exit(bothLive ? 0 : 1)
