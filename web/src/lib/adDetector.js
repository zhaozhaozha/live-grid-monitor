/**
 * 广告时段自动识别器
 *
 * 平台接口不会告诉你「主播开始放广告了」，因此只能从画面/音频特征反推。
 * 1.0 采用多信号融合打分 + 滞回状态机，全部计算在浏览器端完成（后端只存结果），
 * 避免 9 路视频回传服务端造成的带宽与算力压力。
 *
 * ── 信号（每路每秒采样一次）──────────────────────────────
 *  1) repeatRatio      循环素材占比：窗口内出现 ≥2 次的画面指纹比例
 *                      → 循环播放同一段口播/混剪，是最强的广告特征
 *  2) sceneChangeRate  场景切换率：相邻帧差异超过阈值的比例
 *                      → 广告混剪剪辑碎；真人讲解切换平缓
 *  3) audioStability   音量稳定度：RMS 变异系数的反向指标
 *                      → 录播素材能量平稳；真人讲解起伏大
 *  4) keywordScore     关键词命中：弹幕/标题中「上车/小黄车/优惠券」等
 *
 * ── 状态机（带滞回，避免抖动）────────────────────────────
 *  LIVE --(score ≥ T 连续 enterSec 秒)--> AD
 *  AD   --(score < T×0.75 连续 exitSec 秒)--> LIVE
 *
 * ── 已知局限 ────────────────────────────────────────────
 *  · 直播间全程放背景音乐时 audioStability 会偏高，可能误判
 *  · 主播真人讲解商品（无循环素材）时重复率偏低，可能漏判
 *  → 因此提供人工校正，且每次校正会微调阈值做自适应（见 markManual）
 */

const HASH_BITS = 64
const SCENE_CHANGE_HAMMING = 12

export class AdDetector {
  constructor({
    videoEl,
    onStateChange,
    onSample,
    threshold = 0.62,
    sampleFps = 1,
    windowSec = 30,
    enterSec = 8,
    exitSec = 15,
    keywords = DEFAULT_KEYWORDS,
  }) {
    this.video = videoEl
    this.onStateChange = onStateChange
    this.onSample = onSample

    this.threshold = threshold
    this.baseThreshold = threshold
    this.sampleIntervalMs = Math.max(200, Math.round(1000 / sampleFps))
    this.windowSize = Math.max(8, Math.round(windowSec * sampleFps))
    this.enterSamples = Math.max(3, Math.round(enterSec * sampleFps))
    this.exitSamples = Math.max(3, Math.round(exitSec * sampleFps))
    this.keywords = keywords

    // 滑动窗口
    this.hashes = []
    this.rms = []
    this.scores = []

    this.state = 'LIVE'
    this.streak = 0
    this.keywordScore = 0

    this.timer = null
    this.ctx = null
    this.analyser = null
    this.rafId = null

    // 画布（8x9 用于 dHash 横向差分）
    this.canvas = document.createElement('canvas')
    this.canvas.width = 9
    this.canvas.height = 8
    this.ctx2d = this.canvas.getContext('2d', { willReadFrequently: true })

    this.visualEnabled = true
    this.audioEnabled = false
    this.lastError = null
  }

  start() {
    if (this.timer) return
    this.#initAudio()
    this.timer = setInterval(() => this.#tick(), this.sampleIntervalMs)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = null
    try {
      this.analyser?.disconnect()
      this.ctx?.close()
    } catch {
      /* noop */
    }
    this.ctx = null
    this.analyser = null
  }

  /** 外部注入关键词命中（弹幕/标题命中后调用），衰减式生效 */
  bumpKeyword(weight = 1) {
    this.keywordScore = Math.min(1, this.keywordScore + weight)
  }

  /**
   * 人工校正反馈：把某段判定改对/改错，用于自适应阈值
   * @param {'false_positive'|'false_negative'} kind
   */
  markManual(kind) {
    if (kind === 'false_positive') this.threshold = Math.min(0.9, this.threshold + 0.03)
    if (kind === 'false_negative') this.threshold = Math.max(0.35, this.threshold - 0.03)
    return this.threshold
  }

  /** 供 UI 展示的实时调试信息 */
  debug() {
    return {
      state: this.state,
      score: this.scores.length ? this.scores[this.scores.length - 1] : 0,
      threshold: this.threshold,
      visualEnabled: this.visualEnabled,
      audioEnabled: this.audioEnabled,
      lastError: this.lastError,
      samples: this.hashes.length,
    }
  }

  // ---------------- 内部实现 ----------------

  #initAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      const source = this.ctx.createMediaElementSource(this.video)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.6
      // 只接到 analyser，不接 destination —— 保证全程静音
      source.connect(this.analyser)
      this.audioEnabled = true
    } catch (err) {
      // 跨域流会污染音频，此时自动降级为「仅视觉信号」
      this.audioEnabled = false
      this.lastError = `音频分析不可用：${err.message}`
    }
  }

  #tick() {
    if (this.video.readyState < 2 || this.video.paused) return

    const hash = this.visualEnabled ? this.#visualHash() : null
    if (hash !== null) {
      this.hashes.push(hash)
      if (this.hashes.length > this.windowSize) this.hashes.shift()
    }

    const rms = this.audioEnabled ? this.#audioRms() : null
    if (rms !== null) {
      this.rms.push(rms)
      if (this.rms.length > this.windowSize) this.rms.shift()
    }

    if (this.hashes.length < Math.min(8, this.windowSize)) return

    const sig = this.#computeSignals()
    const score = this.#fuse(sig)
    this.scores.push(score)
    if (this.scores.length > this.windowSize) this.scores.shift()

    // 关键词命中随时间衰减
    this.keywordScore = Math.max(0, this.keywordScore - 1 / (this.windowSize * 2))

    this.#transition(score)
    this.onSample?.({ score, ...sig, state: this.state, threshold: this.threshold })
  }

  #visualHash() {
    try {
      this.ctx2d.drawImage(this.video, 0, 0, 9, 8)
      const d = this.ctx2d.getImageData(0, 0, 9, 8).data
      let bits = 0
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const i = (y * 9 + x) * 4
          const j = (y * 9 + x + 1) * 4
          const a = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          const b = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
          bits = (bits << 1) | (a < b ? 1 : 0)
        }
      }
      return bits >>> 0
    } catch (err) {
      // 画布被跨域流污染 -> 关闭视觉信号，仅靠音频 + 关键词
      this.visualEnabled = false
      this.lastError = `画面分析不可用（跨域污染）：${err.message}`
      return null
    }
  }

  #audioRms() {
    if (!this.analyser) return null
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
    const buf = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / buf.length)
  }

  #computeSignals() {
    // 1) 循环素材占比
    const counts = new Map()
    for (const h of this.hashes) counts.set(h, (counts.get(h) || 0) + 1)
    let repeated = 0
    for (const c of counts.values()) if (c >= 2) repeated += c
    const repeatRatio = this.hashes.length ? repeated / this.hashes.length : 0

    // 2) 场景切换率
    let changes = 0
    for (let i = 1; i < this.hashes.length; i++) {
      if (hamming(this.hashes[i - 1], this.hashes[i]) >= SCENE_CHANGE_HAMMING) changes++
    }
    const sceneChangeRate = this.hashes.length > 1 ? changes / (this.hashes.length - 1) : 0

    // 3) 音量稳定度：变异系数越小越稳定
    let audioStability = 0
    if (this.rms.length >= 4) {
      const mean = this.rms.reduce((a, b) => a + b, 0) / this.rms.length
      if (mean > 1e-4) {
        const varc = this.rms.reduce((a, b) => a + (b - mean) ** 2, 0) / this.rms.length
        const cv = Math.sqrt(varc) / mean
        audioStability = clamp01((1.1 - cv) / 0.9)
      }
    }

    return {
      repeatRatio,
      sceneChangeRate,
      audioStability,
      audioAvailable: this.audioEnabled,
      keywordScore: this.keywordScore,
    }
  }

  #fuse(s) {
    const W = { repeat: 0.32, scene: 0.28, audio: 0.20, keyword: 0.20 }
    let score =
      W.repeat * clamp01(s.repeatRatio) +
      W.scene * norm(s.sceneChangeRate, 0.2, 0.75) +
      W.keyword * clamp01(s.keywordScore)

    if (s.audioAvailable) {
      score += W.audio * s.audioStability
    } else {
      // 音频不可用时把权重按比例摊回视觉信号，保持总分可比
      score *= 1 + W.audio / (W.repeat + W.scene + W.keyword)
    }

    // 兜底规则：几乎完全静止的画面视为异常（黑屏/卡住），不算广告
    if (s.sceneChangeRate < 0.02 && s.repeatRatio > 0.95) score *= 0.3

    return clamp01(score)
  }

  #transition(score) {
    if (this.state === 'LIVE') {
      this.streak = score >= this.threshold ? this.streak + 1 : 0
      if (this.streak >= this.enterSamples) {
        this.state = 'AD'
        this.streak = 0
        this.onStateChange?.('AD', { score, signals: this.#computeSignals() })
      }
    } else {
      this.streak = score < this.threshold * 0.75 ? this.streak + 1 : 0
      if (this.streak >= this.exitSamples) {
        this.state = 'LIVE'
        this.streak = 0
        this.onStateChange?.('LIVE', { score, signals: this.#computeSignals() })
      }
    }
  }
}

export const DEFAULT_KEYWORDS = [
  '上车', '小黄车', '拍下', '优惠券', '领券', '下单', '链接', '秒杀',
  '库存', '只剩', '最后', '福利', '赠送', '限时', '买它', '下单立减',
]

/** 两个等长二进制字符串的汉明距离 */
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
