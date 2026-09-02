import { useEffect, useState } from 'react'
import { api, API_BASE } from '../lib/api.js'

const RANGES = [
  { label: '近 24 小时', days: 1 },
  { label: '近 7 天', days: 7 },
  { label: '近 30 天', days: 30 },
]

export default function ReportPanel({ rooms, onBack }) {
  const [days, setDays] = useState(7)
  const [summary, setSummary] = useState(null)
  const [byRoom, setByRoom] = useState([])
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    Promise.all([api.reportSummary(days), api.reportByRoom(days)])
      .then(([s, b]) => {
        setSummary(s)
        setByRoom(b.items)
      })
      .catch((e) => setError(e.message))
  }, [days])

  function openDetail(id) {
    setDetail(null)
    api.reportRoom(id, days).then(setDetail).catch((e) => setError(e.message))
  }

  return (
    <div className="report">
      <header className="report__head">
        <h2>直播数据报表</h2>
        <div className="report__range">
          {RANGES.map((r) => (
            <button
              key={r.days}
              className={`chip ${days === r.days ? 'chip--active' : ''}`}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
          <a className="btn" href={`${API_BASE}/api/reports/export.csv?days=${days}`} target="_blank" rel="noreferrer">
            导出 CSV
          </a>
          <button className="btn btn--ghost" onClick={onBack}>返回监控</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {summary && (
        <div className="cards">
          <Card label="监控直播间" value={summary.activeRooms} unit="个" />
          <Card label="累计直播时长" value={summary.totalLiveHours} unit="小时" />
          <Card label="直播场次" value={summary.sessionCount} unit="场" />
          <Card label="峰值在线" value={fmtNum(summary.peakOnline)} unit="人" />
          <Card label="广告总时长" value={(summary.totalAdSec / 3600).toFixed(2)} unit="小时" />
          <Card
            label="广告时长占比"
            value={`${(summary.adRatio * 100).toFixed(1)}%`}
            tone={summary.adRatio > 0.4 ? 'warn' : 'ok'}
          />
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>直播间</th>
            <th>平台</th>
            <th className="num">场次</th>
            <th className="num">直播时长</th>
            <th className="num">峰值在线</th>
            <th className="num">平均在线</th>
            <th className="num">广告段数</th>
            <th className="num">广告时长</th>
            <th className="num">广告占比</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {byRoom.map((r) => (
            <tr key={r.id}>
              <td title={r.title}>
                {r.anchor_name || r.title || '(未命名)'}
                {r.anchor_name && <em className="sub">{r.title}</em>}
              </td>
              <td><span className={`tag tag--${r.platform}`}>{r.platform}</span></td>
              <td className="num">{r.sessionCount}</td>
              <td className="num">{r.liveHours} h</td>
              <td className="num">{fmtNum(r.peakOnline)}</td>
              <td className="num">{fmtNum(r.avgOnline)}</td>
              <td className="num">{r.adCount}</td>
              <td className="num">{Math.round(r.adSec / 60)} min</td>
              <td className={`num ${r.adRatio > 0.4 ? 'warn' : ''}`}>
                {(r.adRatio * 100).toFixed(1)}%
              </td>
              <td><button className="btn btn--xs" onClick={() => openDetail(r.id)}>明细</button></td>
            </tr>
          ))}
          {!byRoom.length && (
            <tr><td colSpan={10} className="empty">暂无数据，先在监控页添加直播间</td></tr>
          )}
        </tbody>
      </table>

      {detail && <RoomDetail detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function RoomDetail({ detail, onClose }) {
  const { room, sessions, adSegments } = detail
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel modal__panel--wide" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h3>{room.anchor_name || room.title || '直播间明细'}</h3>
          <button className="btn btn--ghost" onClick={onClose}>✕</button>
        </header>

        <section>
          <h4>场次记录（{sessions.length}）</h4>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>开播</th><th>下播</th><th className="num">时长</th>
                <th className="num">峰值</th><th className="num">均值</th>
                <th className="num">广告段</th><th className="num">广告时长</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{fmtTime(s.start_at)}</td>
                  <td>{s.end_at ? fmtTime(s.end_at) : '进行中'}</td>
                  <td className="num">{Math.round(s.duration_sec / 60)} min</td>
                  <td className="num">{fmtNum(s.peak_online)}</td>
                  <td className="num">{fmtNum(s.avg_online)}</td>
                  <td className="num">{s.ad_count}</td>
                  <td className="num">{Math.round(s.ad_duration_sec / 60)} min</td>
                </tr>
              ))}
              {!sessions.length && <tr><td colSpan={7} className="empty">该时间范围内无场次</td></tr>}
            </tbody>
          </table>
        </section>

        <section>
          <h4>广告时段（{adSegments.length}）</h4>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>开始</th><th>结束</th><th className="num">时长</th>
                <th className="num">置信度</th><th>来源</th><th>备注</th>
              </tr>
            </thead>
            <tbody>
              {adSegments.slice(0, 50).map((a) => (
                <tr key={a.id}>
                  <td>{fmtTime(a.start_at)}</td>
                  <td>{a.end_at ? fmtTime(a.end_at) : '进行中'}</td>
                  <td className="num">{a.duration_sec}s</td>
                  <td className="num">{(a.confidence * 100).toFixed(0)}%</td>
                  <td>
                    <span className={`tag tag--${a.source === 'manual' ? 'manual' : 'auto'}`}>
                      {a.source === 'manual' ? '人工' : '自动'}
                    </span>
                    {a.verified ? ' ✓' : ''}
                  </td>
                  <td>{a.note || (a.signals ? briefSignals(a.signals) : '')}</td>
                </tr>
              ))}
              {!adSegments.length && <tr><td colSpan={6} className="empty">未识别到广告时段</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function briefSignals(s) {
  try {
    const o = typeof s === 'string' ? JSON.parse(s) : s
    return `重复${(o.repeatRatio * 100).toFixed(0)}% 切换${(o.sceneChangeRate * 100).toFixed(0)}%`
  } catch {
    return ''
  }
}

function Card({ label, value, unit, tone }) {
  return (
    <div className={`card ${tone ? `card--${tone}` : ''}`}>
      <span className="card__label">{label}</span>
      <strong className="card__value">
        {value}
        {unit && <em>{unit}</em>}
      </strong>
    </div>
  )
}

const fmtNum = (n) => (n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(1)}w` : String(n))
const fmtTime = (iso) =>
  new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
