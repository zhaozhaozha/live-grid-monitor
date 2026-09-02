/**
 * 冒烟测试：不依赖 fastify / better-sqlite3，直接验证数据库层 + 适配器 + 采集逻辑。
 * 运行： cd server && node scripts/smoke.mjs
 */
import fs from 'node:fs'

process.env.DB_FILE = process.env.DB_FILE || '/tmp/lgm-smoke.db'
process.env.POLL_INTERVAL_SEC = '3600'

// 每次运行清空测试库，保证结果可重复
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(process.env.DB_FILE + suffix, { force: true })
}

const { getDb, dbDriver, nowIso, uid } = await import('../src/db/index.js')
const { registerAdapters, detectPlatform, listAdapters, getAdapter } = await import('../src/adapters/index.js')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log('\n=== 1. 数据库驱动 ===')
const db = getDb()
console.log(`  驱动：${dbDriver()}`)
ok('建表成功', db.prepare("SELECT COUNT(1) c FROM sqlite_master WHERE type='table'").get().c >= 5)

console.log('\n=== 2. 平台识别 ===')
registerAdapters()
const cases = [
  ['https://live.douyin.com/712345678901', 'douyin'],
  ['https://v.douyin.com/iRabcdef/', 'douyin'],
  ['https://live.kuaishou.com/u/zhangsan', 'kuaishou'],
  ['https://tb.cn/abc123', 'taobao'],
  ['https://m.tb.cn/h.abc123', 'taobao'],
  ['https://channels.weixin.qq.com/live/xyz', 'wxchannel'],
  ['https://www.xiaohongshu.com/user/profile/abc', 'xiaohongshu'],
  ['https://live.jd.com/3158482', 'jd'],
  ['https://h5.m.jd.com/dev/3pbY8ZuCx4ML99uttZKLHC2QcAMn/live.html?id=1807004', 'jd'],
  ['https://3.cn/1A2b3C', 'jd'],
  ['https://cdn.example.com/live/room.m3u8', 'direct'],
  ['https://cdn.example.com/live/room.flv', 'direct'],
]
for (const [url, expect] of cases) {
  const got = detectPlatform(url)
  ok(`${url.slice(0, 46)} -> ${got}`, got === expect, `期望 ${expect}`)
}
ok('平台清单 7 个', Object.keys(listAdapters()).length === 7)
ok('抖音标记为 stable', listAdapters().douyin.stability === 'stable')
ok('淘宝标记为 experimental', listAdapters().taobao.stability === 'experimental')
ok('京东标记为 experimental', listAdapters().jd.stability === 'experimental')
ok('淘宝需要 Cookie', listAdapters().taobao.needCookie === true)
ok('京东需要 Cookie（标题/在线；出流匿名即可）', listAdapters().jd.needCookie === true)

console.log('\n=== 3. 直链适配器（无需网络） ===')
const direct = getAdapter('direct')
const info = await direct.fetchRoomInfo('https://cdn.example.com/live/room.m3u8')
ok('房间名解析', info.title === 'room.m3u8', info.title)
const stream = await direct.fetchStreamUrl('https://cdn.example.com/live/room.m3u8')
ok('流格式判定为 hls', stream.format === 'hls', stream.format)
const flv = await direct.fetchStreamUrl('https://cdn.example.com/live/room.flv')
ok('流格式判定为 flv', flv.format === 'flv', flv.format)

console.log('\n=== 4. 未实现平台应抛出可操作错误 ===')
for (const p of ['wxchannel', 'xiaohongshu']) {
  const a = getAdapter(p)
  let err = null
  try { await a.fetchRoomInfo('https://x') } catch (e) { err = e }
  ok(`${p} 抛出 NOT_IMPLEMENTED`, err?.code === 'NOT_IMPLEMENTED')
  ok(`${p} 带 hint 提示`, Boolean(err?.hint))
}

console.log('\n=== 4.5 京东 / 淘宝适配器静态契约（不触网） ===')
const jd = getAdapter('jd')
ok('京东 live.html?id 提取 liveId', jd.parseRoomId('https://h5.m.jd.com/dev/3pbY8ZuCx4ML99uttZKLHC2QcAMn/live.html?id=1807004&position=0') === '1807004')
ok('京东 live.jd.com/<id> 提取', jd.parseRoomId('https://live.jd.com/3158482') === '3158482')
ok('京东短链可识别', jd.matchUrl('https://u.jd.com/xA1b2C'))
const jdBad = jd.parseRoomId('https://www.jd.com/') === null
ok('京东非直播页不产出 liveId', jdBad)
const taobao = getAdapter('taobao')
ok('淘宝 taolive/video.html?id 提取 liveId', taobao.parseRoomId('https://h5.m.taobao.com/taolive/video.html?id=209306221322') === '209306221322')
ok('淘宝 detail.html?liveId 提取', taobao.parseRoomId('https://market.m.taobao.com/app/fm-live/live-house/detail.html?liveId=209306221322&x=1') === '209306221322')
ok('淘宝 m.tb.cn 短链可识别', taobao.matchUrl('https://m.tb.cn/h.abc123'))
ok('京东/淘宝 experimental 不抛 NOT_IMPLEMENTED（元信息方法存在）', typeof jd.fetchRoomInfo === 'function' && typeof taobao.fetchStreamUrl === 'function')

console.log('\n=== 5. 插入房间 + 采集流程 ===')
const ts = nowIso()
const rid = uid('room')
db.prepare(
  `INSERT INTO rooms (id, platform, share_url, room_id, title, anchor_name, slot, quality, enabled, created_at, updated_at)
   VALUES (?, 'direct', ?, ?, '测试直播间', '测试主播', 0, 'lowest', 1, ?, ?)`
).run(rid, 'https://cdn.example.com/live/room.m3u8', rid, ts, ts)
ok('房间写入成功', db.prepare('SELECT COUNT(1) c FROM rooms').get().c === 1)

const { tick } = await import('../src/services/poller.js')
const r1 = await tick()
ok('采集器创建场次', r1.results[0]?.sessionId, JSON.stringify(r1.results))

// 模拟在线人数采样
const sid = r1.results[0].sessionId
// 把开播时间回拨 1 小时，贴近真实场次
db.prepare('UPDATE live_sessions SET start_at = ? WHERE id = ?').run(
  new Date(Date.now() - 3600_000).toISOString(),
  sid
)
for (const v of [100, 300, 250]) {
  db.prepare(
    `INSERT INTO metrics_samples (room_id, session_id, ts, online_count, like_count, is_live)
     VALUES (?, ?, ?, ?, 5, 1)`
  ).run(rid, sid, nowIso(), v)
}

console.log('\n=== 6. 广告段生命周期 ===')
const adId = uid('ad')
db.prepare(
  `INSERT INTO ad_segments (id, room_id, session_id, start_at, confidence, signals, source, created_at)
   VALUES (?, ?, ?, ?, 0.78, '{}', 'auto', ?)`
).run(adId, rid, sid, new Date(Date.now() - 60000).toISOString(), ts)
const { closeSession } = await import('../src/services/poller.js')
db.prepare('UPDATE ad_segments SET end_at = ?, duration_sec = 60 WHERE id = ?').run(nowIso(), adId)
const sessRow = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sid)
closeSession(sessRow)
const closed = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sid)
ok('场次结算写入 end_at', Boolean(closed.end_at))
ok('峰值在线 = 300', closed.peak_online === 300, String(closed.peak_online))
ok('平均在线 = 216', Math.abs(closed.avg_online - 216.67) < 1, String(closed.avg_online))
ok('广告段数 = 1', closed.ad_count === 1, String(closed.ad_count))
ok('广告时长 = 60s', closed.ad_duration_sec === 60, String(closed.ad_duration_sec))
ok('直播时长 ≈ 3600s', Math.abs(closed.duration_sec - 3600) <= 2, String(closed.duration_sec))

console.log('\n=== 7. 报表聚合 ===')
const row = db
  .prepare(
    `SELECT r.title, COUNT(s.id) AS sessions, COALESCE(SUM(s.duration_sec),0) AS liveSec,
            COALESCE(MAX(s.peak_online),0) AS peak, COALESCE(SUM(s.ad_duration_sec),0) AS adSec
     FROM rooms r LEFT JOIN live_sessions s ON s.room_id = r.id GROUP BY r.id`
  )
  .get()
ok('报表聚合返回数据', row.sessions === 1 && row.peak === 300, JSON.stringify(row))

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} 项，失败 ${fail} 项`)
console.log('='.repeat(46))
process.exit(fail ? 1 : 0)
