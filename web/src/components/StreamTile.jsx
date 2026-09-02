import { useEffect, useRef, useState } from 'react'
import { createLowBitratePlayer } from '../lib/player.js'
import { useAdDetector } from '../hooks/useAdDetector.js'
import { api } from '../lib/api.js'

const STATE_LABEL = {
  idle: '未加载',
  loading: '连接中',
  playing: '直播中',
  error: '异常',
  offline: '未开播',
}

export default function StreamTile({ room, live, adThreshold, refreshToken = 0, onRemove, onRefresh }) {
  const videoRef = useRef(null)
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [stream, setStream] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [expanded, setExpanded] = useState(false)

  const ad = useAdDetector(videoRef, room.id, {
    enabled: phase === 'playing',
    threshold: adThreshold,
  })

  // 拉取流地址并挂载播放器
  useEffect(() => {
    let player = null
    let cancelled = false

    setPhase('loading')
    setError('')

    api
      .getStream(room.id)
      .then((s) => {
        if (cancelled) return
        setStream(s)
        if (!s.url) {
          setPhase('offline')
          return
        }
        player = createLowBitratePlayer(videoRef.current, s.url, {
          onError: (msg) => {
            if (cancelled) return
            setError(msg)
            setPhase('error')
          },
        })
        setPhase('playing')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setPhase(err.code === 'NOT_LIVE' ? 'offline' : 'error')
      })

    return () => {
      cancelled = true
      player?.destroy()
    }
  }, [room.id, reloadKey])

  const isAd = ad.state === 'AD'

  return (
    <div
      className={`tile ${expanded ? 'tile--expanded' : ''} ${isAd ? 'tile--ad' : ''}`}
      onDoubleClick={() => setExpanded((v) => !v)}
    >
      <div className="tile__video">
        <video ref={videoRef} muted playsInline disablePictureInPicture />
        {phase !== 'playing' && (
          <div className="tile__placeholder">
            {phase === 'loading' && <span className="spinner" />}
            <p>{error || STATE_LABEL[phase]}</p>
            {phase === 'error' && (
              <button className="btn btn--xs" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tile__bar">
        <span className={`badge badge--${phase === 'playing' ? 'live' : 'idle'}`}>
          {isAd ? '广告中' : STATE_LABEL[phase]}
        </span>
        <span className="tile__title" title={room.title || room.share_url}>
          {room.anchor_name || room.title || '未命名直播间'}
        </span>
        <span className="tile__spacer" />
        {live?.online_count != null && (
          <span className="tile__metric" title="实时在线人数">
            👥 {formatNum(live.online_count)}
          </span>
        )}
        {live?.session_start && (
          <span className="tile__metric" title="本场已开播时长">
            ⏱ {formatDuration(live.session_start)}
          </span>
        )}
      </div>

      <div className="tile__actions">
        <button title="重新拉流" onClick={() => setReloadKey((k) => k + 1)}>⟳</button>
        <button title="强制刷新流地址" onClick={onRefresh}>⇪</button>
        <button
          title={isAd ? '判定为讲解（人工校正：误报）' : '标记为广告（人工校正：漏报）'}
          onClick={() => handleManualMark(isAd)}
        >
          {isAd ? '🚫' : '📢'}
        </button>
        <button title="移除" onClick={onRemove}>✕</button>
      </div>

      {/* 广告识别实时条 */}
      <div className="tile__admeter" title={`广告置信度 ${(ad.score * 100).toFixed(0)}% / 阈值 ${(adThreshold * 100).toFixed(0)}%`}>
        <div
          className="tile__admeter-fill"
          style={{
            width: `${Math.round(ad.score * 100)}%`,
            background: ad.score >= adThreshold ? 'var(--danger)' : 'var(--accent)',
          }}
        />
        <i className="tile__admeter-threshold" style={{ left: `${adThreshold * 100}%` }} />
      </div>
    </div>
  )

  async function handleManualMark(currentlyAd) {
    const now = Date.now()
    const start = new Date(now - 60_000).toISOString()
    const end = new Date(now).toISOString()
    try {
      await api.manualAd({
        roomId: room.id,
        startAt: start,
        endAt: end,
        isAd: !currentlyAd,
        note: !currentlyAd ? '人工补标：漏报' : '人工取消：误报',
      })
      ad.markManual(!currentlyAd ? 'false_negative' : 'false_positive')
    } catch (err) {
      console.warn(err.message)
    }
  }
}

function formatNum(n) {
  if (n == null) return '—'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

export function formatDuration(startIso) {
  const sec = Math.max(0, Math.round((Date.now() - new Date(startIso).getTime()) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (v) => String(v).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
