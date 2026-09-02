import { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

export default function AddRoomDialog({ open, onClose, onAdded, occupiedSlots = [] }) {
  const [url, setUrl] = useState('')
  const [platforms, setPlatforms] = useState({})
  const [platform, setPlatform] = useState('auto')
  const [cookie, setCookie] = useState('')
  const [slot, setSlot] = useState('')
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    api.platforms().then(setPlatforms).catch(() => setPlatforms({}))
    setUrl('')
    setPreview(null)
    setError('')
    setSlot('')
  }, [open])

  if (!open) return null

  const hints = platform !== 'auto' ? platforms[platform]?.urlHints || [] : []

  async function handleParse() {
    if (!url.trim()) return
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      const r = await api.parseRoom(url.trim(), platform === 'auto' ? undefined : platform, cookie || undefined)
      setPreview(r)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleAdd() {
    setBusy(true)
    setError('')
    try {
      await api.addRoom({
        url: url.trim(),
        platform: platform === 'auto' ? undefined : platform,
        cookie: cookie || undefined,
        slot: slot === '' ? undefined : Number(slot),
      })
      onAdded?.()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h3>添加直播间</h3>
          <button className="btn btn--ghost" onClick={onClose}>✕</button>
        </header>

        <label className="field">
          <span>直播间分享链接</span>
          <div className="field__row">
            <input
              autoFocus
              value={url}
              placeholder="粘贴抖音 / 快手 / 淘宝 / 视频号 / 小红书的直播间链接，或 m3u8 / flv 直链"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleParse()}
            />
            <button className="btn" disabled={busy || !url.trim()} onClick={handleParse}>
              解析
            </button>
          </div>
        </label>

        <div className="field__grid">
          <label className="field">
            <span>平台</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="auto">自动识别</option>
              {Object.entries(platforms).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {v.stability === 'stub' ? '（1.0 未实现）' : v.stability === 'experimental' ? '（实验）' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>宫格位置</span>
            <select value={slot} onChange={(e) => setSlot(e.target.value)}>
              <option value="">自动分配</option>
              {Array.from({ length: 9 }, (_, i) => (
                <option key={i} value={i} disabled={occupiedSlots.includes(i)}>
                  第 {i + 1} 格{occupiedSlots.includes(i) ? '（已占用）' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span>
            Cookie（选填）
            <em>抖音 / 快手遇到风控时填写，否则留空</em>
          </span>
          <textarea rows={2} value={cookie} onChange={(e) => setCookie(e.target.value)} placeholder="从浏览器复制的完整 Cookie 字符串" />
        </label>

        {hints.length > 0 && (
          <div className="hint">
            <strong>支持的链接格式：</strong>
            <ul>
              {hints.map((h) => (
                <li key={h}><code>{h}</code></li>
              ))}
            </ul>
          </div>
        )}

        {preview && (
          <div className="preview">
            <div className={`preview__dot ${preview.isLive ? 'on' : 'off'}`} />
            <div>
              <p className="preview__title">{preview.title || '(无标题)'}</p>
              <p className="preview__meta">
                {preview.anchorName || '未知主播'} · {preview.platform}
                {preview.roomId ? ` · roomId ${preview.roomId}` : ''}
              </p>
            </div>
            <span className={`badge badge--${preview.isLive ? 'live' : 'idle'}`}>
              {preview.isLive ? '在播' : '未开播'}
            </span>
          </div>
        )}

        {error && <p className="error">{error}</p>}

        <footer className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose}>取消</button>
          <button className="btn btn--primary" disabled={busy || !url.trim()} onClick={handleAdd}>
            {busy ? '处理中…' : '添加到宫格'}
          </button>
        </footer>
      </div>
    </div>
  )
}
