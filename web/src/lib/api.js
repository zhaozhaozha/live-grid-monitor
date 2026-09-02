// 默认走同源 /api：开发期由 Vite 代理到后端，生产期由后端直接托管 dist。
// 只有前后端分离部署时才需要显式设置 VITE_API_BASE。
const BASE = import.meta.env.VITE_API_BASE || ''

async function req(path, options = {}) {
  let res
  try {
    res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
  } catch {
    throw new Error('无法连接后端服务，请先启动 server（cd server && npm run dev）')
  }
  if (!res.ok) {
    let msg = `请求失败 HTTP ${res.status}`
    let j = null
    try {
      j = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    if (j) {
      msg = j.error || msg
      if (j.hint) msg += `（${j.hint}）`
    }
    // 透传服务端业务 code(如 NOT_LIVE),供调用方区分「未开播」与「真异常」
    const e = new Error(msg)
    if (j?.code) e.code = j.code
    if (j?.hint) e.hint = j.hint
    throw e
  }
  const ct = res.headers.get('content-type') || ''
  return ct.includes('json') ? res.json() : res.text()
}

export const api = {
  health: () => req('/api/health'),
  platforms: () => req('/api/rooms/platforms'),
  listRooms: () => req('/api/rooms'),
  parseRoom: (url, platform, cookie) =>
    req('/api/rooms/parse', { method: 'POST', body: JSON.stringify({ url, platform, cookie }) }),
  addRoom: (payload) => req('/api/rooms', { method: 'POST', body: JSON.stringify(payload) }),
  updateRoom: (id, patch) => req(`/api/rooms/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeRoom: (id) => req(`/api/rooms/${id}`, { method: 'DELETE' }),
  closeSession: (id) => req(`/api/rooms/${id}/close-session`, { method: 'POST' }),
  liveSnapshot: () => req('/api/rooms/live'),
  getStream: (roomId, force = false) => req(`/api/streams/${roomId}${force ? '?force=1' : ''}`),

  openAd: (payload) => req('/api/metrics/ad-segments/open', { method: 'POST', body: JSON.stringify(payload) }),
  closeAd: (id, payload = {}) =>
    req(`/api/metrics/ad-segments/${id}/close`, { method: 'POST', body: JSON.stringify(payload) }),
  manualAd: (payload) => req('/api/metrics/ad-segments/manual', { method: 'POST', body: JSON.stringify(payload) }),

  reportSummary: (days) => req(`/api/reports/summary?days=${days}`),
  reportByRoom: (days) => req(`/api/reports/by-room?days=${days}`),
  reportRoom: (id, days) => req(`/api/reports/room/${id}?days=${days}`),
  exportCsv: (days) => req(`/api/reports/export.csv?days=${days}`),
}

export const API_BASE = BASE
