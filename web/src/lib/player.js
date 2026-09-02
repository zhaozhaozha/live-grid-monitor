/** 支持的格式 */
const HLS = /\.(m3u8)(\?|$)/i
const FLV = /\.(flv)(\?|$)/i

/**
 * 创建低码率、静音的实时流播放器。
 *
 * 关键策略（对应需求「不需要声音 + 最低画质」）：
 *  - muted = true 且 volume = 0：彻底不出声，同时规避浏览器自动播放限制
 *  - HLS：锁定最低码率档（level 0），关闭 ABR 自动上调
 *  - FLV：由后端在 pull_url 中挑选最低档；前端把缓冲区压到最小以降低延迟
 *  - 暂停/恢复：直接销毁实例，避免后台标签页持续占带宽与 CPU
 */
export function createLowBitratePlayer(videoEl, url, { format, onError, onStats } = {}) {
  // format 显式优先（后端流接口会返回 format 字段，如 'flv'/'hls'）；
  // 否则回退到 URL 扩展名判断（relay 代理 URL 形如 …/relay，无 .flv 后缀，必须靠 format 识别）。
  const fmt = format || (HLS.test(url) ? 'hls' : FLV.test(url) ? 'flv' : 'native')
  const isHls = fmt === 'hls'
  const isFlv = fmt === 'flv'

  videoEl.muted = true
  videoEl.volume = 0
  videoEl.playsInline = true
  videoEl.setAttribute('muted', '')
  videoEl.setAttribute('playsinline', '')

  let instance = null
  let destroyed = false

  const fail = (msg) => {
    if (!destroyed) onError?.(msg)
  }

  const attachStats = () => {
    if (!onStats) return
    const timer = setInterval(() => {
      if (destroyed) return clearInterval(timer)
      const v = videoEl.buffered
      onStats({
        bufferSec: v.length ? +(v.end(v.length - 1) - videoEl.currentTime).toFixed(2) : 0,
        videoWidth: videoEl.videoWidth,
        videoHeight: videoEl.videoHeight,
        droppedFrames: videoEl.getVideoPlaybackQuality?.()?.droppedVideoFrames ?? null,
      })
    }, 5000)
  }

  if (isHls) {
    import('hls.js').then(({ default: Hls }) => {
      if (destroyed) return
      if (Hls.isSupported()) {
        const hls = new Hls({
          // 最低画质：起始档位 0，并禁止自动升档
          startLevel: 0,
          capLevelToPlayerSize: false,
          maxBufferLength: 4,
          maxMaxBufferLength: 8,
          maxBufferSize: 10 * 1000 * 1000,
          liveSyncDurationCount: 3,
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 5,
        })
        hls.loadSource(url)
        hls.attachMedia(videoEl)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          hls.currentLevel = 0 // 再次锁定最低档，防止 ABR 上探
          hls.autoLevelCapping = 0
          videoEl.play().catch(() => {})
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data?.fatal) fail(`HLS 播放错误：${data.type} / ${data.details}`)
        })
        instance = hls
        attachStats()
      } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari 原生 HLS
        videoEl.src = url
        videoEl.play().catch(() => {})
        attachStats()
      } else {
        fail('当前浏览器不支持 HLS 播放')
      }
    }).catch(() => fail('hls.js 加载失败'))
  } else if (isFlv) {
    import('mpegts.js').then(({ default: mpegts }) => {
      if (destroyed) return
      if (!mpegts.isSupported()) return fail('当前浏览器不支持 FLV 播放')
      const player = mpegts.createPlayer(
        { type: 'flv', url, isLive: true, cors: true, hasAudio: false },
        {
          enableWorker: false, // worker 线程内 demux 错误序列化后丢失 message(HEVC 等关键信息),主线程执行更利于诊断
          enableStashBuffer: false, // 直播低延迟
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 3,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
        }
      )
      let hevcTerminal = false // HEVC 解码失败为终态,后续 IO/EOF 错误不得覆盖提示
      player.attachMediaElement(videoEl)
      player.load()
      player.play().catch(() => {})
      player.on(mpegts.Events.ERROR, (...args) => {
        // mpegts 各版本回调签名不一:(type, detail, info) / (type, detail, errObj) …
        // 全量序列化保证 HEVC 等关键信息不被漏掉
        const raw = args
          .map((a) => {
            try {
              if (a && typeof a === 'object') return a.info?.msg || a.msg || a.message || JSON.stringify(a)
              return String(a)
            } catch {
              return String(a)
            }
          })
          .join(' | ')
        if (/HEVC|hvcC|HEVCDecoder|H\.265|codecid.?12/i.test(raw)) {
          hevcTerminal = true
          return fail('该直播间为 H.265/HEVC 编码，当前浏览器不支持解码（可换 Chrome 新版本或有硬解的浏览器）')
        }
        // HEVC 不可恢复:解码器报错后 mpegts 会连带抛 IO/EOF 噪声,不能覆盖上面的终态提示
        if (hevcTerminal) return
        const m = raw.match(/(\d{3})\s*(?:\(|$)/)
        const code = m ? m[1] : ''
        fail(`FLV 播放错误：${(raw.split(' | ').find((x) => x && x !== 'undefined') || 'unknown').slice(0, 80)}${code ? ` (${code})` : ''}`)
      })
      instance = player
      attachStats()
    }).catch(() => fail('mpegts.js 加载失败'))
  } else {
    // mp4 / 其他：直接交给 <video>
    videoEl.src = url
    videoEl.play().catch(() => {})
    attachStats()
  }

  return {
    destroy() {
      destroyed = true
      try {
        instance?.destroy?.()
      } catch {
        /* noop */
      }
      videoEl.removeAttribute('src')
      videoEl.load()
      instance = null
    },
    get kind() {
      return isHls ? 'hls' : isFlv ? 'flv' : 'native'
    },
  }
}
