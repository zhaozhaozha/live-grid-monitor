import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'
import { getDb, nowIso, uid } from '../db/index.js'
import { getPlayableStream } from './streamResolver.js'
import { refererOf } from './referer.js'
import { config } from '../config.js'

/**
 * 服务端广告采样器（ad_segments 的真正生产者）
 *
 * ── 为什么必须有这个服务 ────────────────────────────────
 * 1.0 把广告识别放在浏览器端（web/src/lib/adDetector.js），实际有两个致命伤：
 *   ① 关掉页面 / 切到后台标签页，检测立即停摆（setInterval 被节流到分钟级），
 *      而服务端 poller 是 7×24 在跑的 —— 数据必然一侧空、一侧满。
 *   ② HLS 直连房（jd 等）跨域污染 canvas，getImageData 抛 SecurityError，
 *      视觉信号被关闭；此时 hashes 恒空，tick 在 `hashes.length < 8` 处直接 return，
 *      状态机永不触发 —— 等价于检测功能整体失效。
 *
 * 本服务把采样搬到服务端：ffmpeg 常驻拉上游流 → 每秒抽 1 帧缩到 9×8 灰度
 * → Node 侧算 dHash → 滑动窗口 + 滞回状态机 → 直接写 ad_segments。
 * 不依赖浏览器是否打开，也不受跨域限制。
 *
 * ── 资源开销 ────────────────────────────────────────────
 * 每房每帧 9×8 = 72 字节，1fps → 72 B/s；9 房间合计 < 1 KB/s。
 * 主要成本是 ffmpeg 解码（不含编码），且仅对「正在直播」的房间启用。
 */

const FRAME_W = 9
const FRAME_H = 8
const FRAME_BYTES = FRAME_W * FRAME_H // 72

/** 超过该秒数没收到帧，认为上游已断，停掉本房采样（等待下轮重连） */
const NO_FRAME_TIMEOUT_MS = 45_000
/** ffmpeg 异常退出后的重启退避 */
const RESTART_BACKOFF_MS = 30_000

const active = new Map() // roomId -> RoomSampler
let timer = null
let syncing = false

// ---------------- dHash ----------------

/** 9×8 灰度帧 → 64 位字符串指纹（每行比较相邻 8 对，共 8 行） */
function dHash(buf) {
  let s = ''
  for (let y = 0; y < FRAME_H; y++) {
    const row = y * FRAME_W
    for (let x = 0; x < FRAME_W - 1; x++) {
      s += buf[row + x] < buf[row + x + 1] ? '1' : '0'
    }
  }
  return s
}

/** 两个等长二进制串的汉明距离 */
function hamming(a, b) {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
function norm(v, lo, hi) {
  if (hi === lo) return 0
  return clamp01((v - lo) / (hi - lo))
}

// ---------------- 单房间采样器 ----------------

class RoomSampler {
  constructor(room, opts = {}) {
    this.room = room
    this.threshold = opts.threshold ?? config.adScoreThreshold
    this.windowSize = opts.windowSec ?? 30
    this.enterSamples = opts.enterSec ?? 8
    this.exitSamples = opts.exitSec ?? 15

    this.hashes = []
    this.state = 'LIVE'
    this.streak = 0
    this.score = 0
    this.segId = null

    this.proc = null
    this.buf = Buffer.alloc(0)
    this.stopped = false
    this.lastFrameAt = Date.now()
    this.restartAt = 0
    this.frames = 0
    this.lastError = ''
  }

  async start() {
    if (this.stopped) return
    let url
    try {
      const s = await getPlayableStream(this.room, {})
      if (!s?.url) throw new Error('未取到可播放流地址')
      url = s.url
      this.streamFormat = s.format
    } catch (err) {
      this.lastError = `取流失败：${err.message}`
      return
    }
    if (this.stopped) return
    this.#spawn(url)
  }

  #spawn(url) {
    const referer = refererOf(this.room.platform)
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-err_detect', 'ignore_err',
      ...(referer ? ['-headers', `Referer: ${referer}\r\n`] : []),
      '-user_agent', config.userAgent,
      '-i', url,
      '-an', // 只要画面
      '-vf', `fps=1,scale=${FRAME_W}:${FRAME_H},format=gray`,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1',
    ]

    const proc = spawn(ffmpegStatic, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    let errBuf = ''
    proc.stderr?.on('data', (d) => {
      errBuf = (errBuf + String(d)).slice(-2000)
    })

    proc.stdout?.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk])
      while (this.buf.length >= FRAME_BYTES) {
        const frame = this.buf.subarray(0, FRAME_BYTES)
        this.buf = this.buf.subarray(FRAME_BYTES)
        this.lastFrameAt = Date.now()
        this.frames++
        this.#onFrame(frame)
      }
    })

    proc.once('exit', (code) => {
      this.proc = null
      if (this.stopped) return
      this.lastError = `ffmpeg 退出(code=${code}) ${errBuf.slice(-200)}`
      // 退避重启：上游抖动/流地址过期时避免疯狂重试
      this.restartAt = Date.now() + RESTART_BACKOFF_MS
      this.#closeOpenSegment()
    })
    proc.once('error', (err) => {
      this.lastError = `ffmpeg 启动失败：${err.message}`
      this.proc = null
    })
  }

  /** 上游长时间无数据：杀掉进程等下轮重连，避免僵死进程常驻 */
  checkHealth() {
    if (this.stopped) return
    if (this.proc && Date.now() - this.lastFrameAt > NO_FRAME_TIMEOUT_MS) {
      this.lastError = '上游超过 45s 无帧数据，判定断流'
      this.#kill()
      this.restartAt = Date.now() + RESTART_BACKOFF_MS
      return
    }
    if (!this.proc && Date.now() >= this.restartAt) {
      this.start().catch(() => {})
    }
  }

  #onFrame(frame) {
    const hash = dHash(frame)
    this.hashes.push(hash)
    if (this.hashes.length > this.windowSize) this.hashes.shift()
    if (this.hashes.length < Math.min(8, this.windowSize)) return

    const sig = this.#signals()
    this.score = this.#fuse(sig)
    this.#transition(this.score, sig)
  }

  #signals() {
    // 1) 循环素材占比：窗口内出现 ≥2 次的指纹比例
    const counts = new Map()
    for (const h of this.hashes) counts.set(h, (counts.get(h) || 0) + 1)
    let repeated = 0
    for (const c of counts.values()) if (c >= 2) repeated += c
    const repeatRatio = this.hashes.length ? repeated / this.hashes.length : 0

    // 2) 场景切换率：相邻帧差异超阈值的比例
    let changes = 0
    for (let i = 1; i < this.hashes.length; i++) {
      if (hamming(this.hashes[i - 1], this.hashes[i]) >= 12) changes++
    }
    const sceneChangeRate = this.hashes.length > 1 ? changes / (this.hashes.length - 1) : 0

    return { repeatRatio, sceneChangeRate }
  }

  /**
   * 服务端版融合：只有视觉两信号（无音频、无弹幕），按权重归一到 0~1。
   * 与前端版不同——前端把缺失信号的权重摊回去会系统性压低分数，这里直接归一。
   */
  #fuse(s) {
    const score = 0.55 * clamp01(s.repeatRatio) + 0.45 * norm(s.sceneChangeRate, 0.2, 0.75)
    // 近乎静止的画面视为黑屏/卡住，不是广告
    if (s.sceneChangeRate < 0.02 && s.repeatRatio > 0.95) return clamp01(score * 0.3)
    return clamp01(score)
  }

  #transition(score, sig) {
    if (this.state === 'LIVE') {
      this.streak = score >= this.threshold ? this.streak + 1 : 0
      if (this.streak >= this.enterSamples) {
        this.state = 'AD'
        this.streak = 0
        this.#openSegment(score, sig)
      }
    } else {
      this.streak = score < this.threshold * 0.75 ? this.streak + 1 : 0
      if (this.streak >= this.exitSamples) {
        this.state = 'LIVE'
        this.streak = 0
        this.#closeOpenSegment()
      }
    }
  }

  #openSegment(score, sig) {
    const db = getDb()
    const session = db
      .prepare('SELECT id FROM live_sessions WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1')
      .get(this.room.id)
    const id = uid('ad')
    const now = nowIso()
    db.prepare(
      `INSERT INTO ad_segments (id, room_id, session_id, start_at, confidence, signals, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'auto', ?)`
    ).run(id, this.room.id, session?.id || null, now, score, JSON.stringify(sig), now)
    this.segId = id
    console.log(`[ad-sampler] ${this.room.id} 进入广告段 score=${score.toFixed(2)}`)
  }

  #closeOpenSegment() {
    if (!this.segId) return
    const db = getDb()
    const id = this.segId
    this.segId = null
    const seg = db.prepare('SELECT * FROM ad_segments WHERE id = ?').get(id)
    if (!seg) return
    const end = nowIso()
    const duration = Math.max(0, Math.round((new Date(end) - new Date(seg.start_at)) / 1000))
    if (duration < 5) {
      // 过短判定视为噪声
      db.prepare('DELETE FROM ad_segments WHERE id = ?').run(id)
      return
    }
    db.prepare('UPDATE ad_segments SET end_at = ?, duration_sec = ? WHERE id = ?').run(end, duration, id)
    console.log(`[ad-sampler] ${this.room.id} 广告段结束 duration=${duration}s`)
  }

  #kill() {
    this.#closeOpenSegment()
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
    this.proc = null
  }

  stop() {
    this.stopped = true
    this.#kill()
  }

  debug() {
    return {
      roomId: this.room.id,
      state: this.state,
      score: +this.score.toFixed(3),
      threshold: this.threshold,
      frames: this.frames,
      running: Boolean(this.proc),
      lastError: this.lastError,
    }
  }
}

// ---------------- 调度 ----------------

export function startAdSampler() {
  if (timer) return
  const enabled = process.env.AD_SAMPLER_ENABLED !== '0'
  if (!enabled) {
    console.log('[ad-sampler] 已通过 AD_SAMPLER_ENABLED=0 禁用')
    return
  }
  timer = setInterval(() => {
    sync().catch((err) => console.error('[ad-sampler] sync failed:', err.message))
    for (const s of active.values()) s.checkHealth()
  }, 30_000)
  timer.unref?.()
  setTimeout(() => sync().catch(() => {}), 8000)
  console.log('[ad-sampler] 已启动')
}

export function stopAdSampler() {
  if (timer) clearInterval(timer)
  timer = null
  for (const s of active.values()) s.stop()
  active.clear()
}

/** 房间被删除/禁用/下播时立刻收摊，避免残留 ffmpeg 进程 */
export function stopRoomSampler(roomId) {
  const s = active.get(roomId)
  if (!s) return
  s.stop()
  active.delete(roomId)
}

/** 对齐在播房间集合：只为「正在直播」的房间起采样，其余立刻停 */
export async function sync() {
  if (syncing) return { skipped: true }
  syncing = true
  try {
    const db = getDb()
    const rooms = db
      .prepare(
        `SELECT r.* FROM rooms r
         WHERE r.enabled = 1
           AND EXISTS (SELECT 1 FROM live_sessions s WHERE s.room_id = r.id AND s.end_at IS NULL)`
      )
      .all()

    const want = new Set(rooms.map((r) => r.id))
    for (const [id, s] of [...active]) {
      if (!want.has(id)) {
        s.stop()
        active.delete(id)
      }
    }
    for (const room of rooms) {
      if (!active.has(room.id)) {
        const s = new RoomSampler(room)
        active.set(room.id, s)
        s.start().catch((err) => {
          s.lastError = err.message
        })
      }
    }
    return { active: active.size, rooms: rooms.length }
  } finally {
    syncing = false
  }
}

export function samplerDebug() {
  return [...active.values()].map((s) => s.debug())
}
