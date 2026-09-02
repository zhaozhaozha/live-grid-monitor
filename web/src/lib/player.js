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
export function createLowBitratePlayer(videoEl, url, { onError, onStats } = {}) {
  const isHls = HLS.test(url)
  const isFlv = FLV.test(url)

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
          enableWorker: true,
          enableStashBuffer: false, // 直播低延迟
          stashInitialSize: 128,
          liveBufferLatencyChasing: true,
          liveBufferLatencyMaxLatency: 3,
          lazyLoad: false,
          autoCleanupSourceBuffer: true,
        }
      )
      player.attachMediaElement(videoEl)
      player.load()
      player.play().catch(() => {})
      player.on(mpegts.Events.ERROR, (_t, _d, err) => fail(`FLV 播放错误：${err?.message || 'unknown'}`))
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
