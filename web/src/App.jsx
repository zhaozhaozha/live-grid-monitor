import { useCallback, useEffect, useState } from 'react'
import MonitorGrid from './components/MonitorGrid.jsx'
import AddRoomDialog from './components/AddRoomDialog.jsx'
import ReportPanel from './components/ReportPanel.jsx'
import { api } from './lib/api.js'

const AD_THRESHOLD_KEY = 'lgm.adThreshold'

export default function App() {
  const [rooms, setRooms] = useState([])
  const [liveMap, setLiveMap] = useState({})
  const [view, setView] = useState('monitor')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [adThreshold, setAdThreshold] = useState(
    Number(localStorage.getItem(AD_THRESHOLD_KEY) || 0.62)
  )
  const [serverOk, setServerOk] = useState(null)
  const [error, setError] = useState('')
  const [lastSync, setLastSync] = useState(null)

  const loadRooms = useCallback(async () => {
    try {
      const r = await api.listRooms()
      setRooms(r.items)
      setServerOk(true)
      setError('')
    } catch (err) {
      setServerOk(false)
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    loadRooms()
  }, [loadRooms])

  // 在线人数 / 开播时长角标：10s 刷新一次
  useEffect(() => {
    if (view !== 'monitor') return
    let alive = true
    const run = () =>
      api
        .liveSnapshot()
        .then((r) => {
          if (!alive) return
          setLiveMap(r.items)
          setLastSync(new Date())
        })
        .catch(() => {})
    run()
    const t = setInterval(run, 10000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [view])

  useEffect(() => {
    localStorage.setItem(AD_THRESHOLD_KEY, String(adThreshold))
  }, [adThreshold])

  const occupiedSlots = rooms.map((r) => r.slot).filter((s) => s != null)

  async function handleRemove(id) {
    try {
      await api.removeRoom(id)
      setRooms((prev) => prev.filter((r) => r.id !== id))
      setLiveMap((prev) => {
        const n = { ...prev }
        delete n[id]
        return n
      })
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleRefreshRoom(id) {
    try {
      await api.getStream(id, true)
      // 递增 refreshToken 才能真正让该格子的播放器重新挂载
      setRefreshTokens((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }))
    } catch (err) {
      setError(err.message)
    }
  }

  const liveCount = Object.values(liveMap).filter((v) => v.is_live).length

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo" />
          <div>
            <h1>直播监控矩阵</h1>
            <p>
              九宫格低码率预览 · 开播时长 / 在线人数 / 广告时段自动采集
              {serverOk === false && <em className="offline"> · 后端未连接</em>}
              {serverOk === true && lastSync && (
                <em> · 已同步 {lastSync.toLocaleTimeString('zh-CN')}</em>
              )}
            </p>
          </div>
        </div>

        <div className="topbar__stats">
          <Stat label="直播间" value={`${rooms.length}/9`} />
          <Stat label="在播" value={liveCount} tone={liveCount ? 'live' : 'idle'} />
        </div>

        <div className="topbar__ctrl">
          <label className="threshold" title="调高：更严格，减少误判；调低：更灵敏，减少漏判">
            广告阈值
            <input
              type="range"
              min="0.35"
              max="0.9"
              step="0.01"
              value={adThreshold}
              onChange={(e) => setAdThreshold(Number(e.target.value))}
            />
            <b>{(adThreshold * 100).toFixed(0)}%</b>
          </label>

          <div className="switch">
            <button
              className={`chip ${view === 'monitor' ? 'chip--active' : ''}`}
              onClick={() => setView('monitor')}
            >
              监控墙
            </button>
            <button
              className={`chip ${view === 'report' ? 'chip--active' : ''}`}
              onClick={() => setView('report')}
            >
              数据报表
            </button>
          </div>

          <button className="btn btn--primary" onClick={() => setDialogOpen(true)}>
            + 添加直播间
          </button>
        </div>
      </header>

      {error && <div className="banner">{error}</div>}

      <main className="content">
        {view === 'monitor' ? (
          <MonitorGrid
            rooms={rooms}
            liveMap={liveMap}
            adThreshold={adThreshold}
            refreshTokens={refreshTokens}
            onRemove={handleRemove}
            onRefreshRoom={handleRefreshRoom}
            onAdd={() => setDialogOpen(true)}
          />
        ) : (
          <ReportPanel rooms={rooms} onBack={() => setView('monitor')} />
        )}
      </main>

      <AddRoomDialog
        open={dialogOpen}
        occupiedSlots={occupiedSlots}
        onClose={() => setDialogOpen(false)}
        onAdded={loadRooms}
      />
    </div>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone ? `stat--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
