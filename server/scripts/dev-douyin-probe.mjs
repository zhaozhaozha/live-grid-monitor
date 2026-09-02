// 临时探测：解析 douyin reflow RSC 结构（验证后并入适配器）
const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

async function resolveRedirect(url, depth = 0) {
  if (depth > 6) return url
  const r = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'manual' })
  const loc = r.headers.get('location')
  return loc ? resolveRedirect(new URL(loc, url).href, depth + 1) : url
}

function parsePush(str) {
  const m = str.match(/__rsc_f\.push\((\[.*?\])\)/s)
  if (!m) return null
  const mm = m[1].match(/^\[(\d+),\"((?:[^\"\\]|\\.)*)\"\]/)
  if (!mm) return null
  try { return { id: mm[1], text: JSON.parse('"' + mm[2] + '"') } } catch { return null }
}

// 平衡括号提取 JSON 对象值：s.indexOf('"key":') 定位后调用
function extractObjectAt(s, keyIdx) {
  let i = s.indexOf('{', keyIdx)
  if (i < 0) return null
  const start = i
  let depth = 0, inStr = false, esc = false
  for (; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return null
}

const finalUrl = await resolveRedirect(process.argv[2] || 'https://v.douyin.com/lFyhuxfcKXk/')
console.log('finalUrl =', finalUrl.slice(0, 100))
const r = await fetch(finalUrl, { headers: { 'User-Agent': ua } })
const html = await r.text()

// 还原所有 push 段
const texts = []
for (const m of html.matchAll(/self\.__rsc_f\.push\(\[(\d+),\"[^\"]/g)) {
  const p = parsePush(html.slice(m.index, m.index + 5000000))
  if (p) texts.push(p.text)
}
console.log('还原段:', texts.length)

// 定位含 key 的段
function segWith(key) { return texts.findIndex(t => t.includes(key)) }
const roomSeg = segWith('"room":{')
const streamSeg = segWith('"streamUrl":{')
console.log('roomSeg =', roomSeg, 'streamSeg =', streamSeg)

// 提取 room
let room = null
if (roomSeg >= 0) {
  const t = texts[roomSeg]
  const k = t.indexOf('"room":{')
  const raw = extractObjectAt(t, k)
  if (raw) { try { room = JSON.parse(raw) } catch (e) { console.log('room parse err', e.message) } }
}
console.log('--- room ---')
if (room) {
  console.log('idStr:', room.idStr, '| status:', room.status, '(2=直播中,4=回放)')
  console.log('title:', room.title)
  console.log('userCount(实时):', room.userCount)
  console.log('totalUser(累计):', room.stats?.totalUser)
  console.log('createTime(开播s):', room.createTime, new Date((room.createTime || 0) * 1000).toISOString())
  console.log('ownerUserId:', room.ownerUserId)
  console.log('owner:', room.owner?.nickname || '(无 owner 字段)')
}

// 提取 streamUrl
let stream = null
if (streamSeg >= 0) {
  const t = texts[streamSeg]
  const k = t.indexOf('"streamUrl":{')
  const raw = extractObjectAt(t, k)
  if (raw) { try { stream = JSON.parse(raw) } catch (e) { console.log('stream parse err', e.message) } }
}
console.log('--- streamUrl ---')
if (stream) {
  const dump = JSON.stringify(stream)
  console.log('对象长度:', dump.length)
  console.log('顶层keys:', Object.keys(stream))
  // 打印前 2500 字符看清嵌套结构
  console.log('前2500字符:', dump.slice(0, 2500))
  // 找所有 http 串
  const urls = [...dump.matchAll(/\"(https?:[^\"]{20,240}?)\"/g)].map(m => m[1])
  const uniq = [...new Set(urls)].filter(u => /(pull|\.flv|\.m3u8|douyincdn)/.test(u))
  console.log('候选流地址(前5):')
  for (const u of uniq.slice(0, 5)) console.log(' ', u.replace(/\\u0026/g, '&'))
}
