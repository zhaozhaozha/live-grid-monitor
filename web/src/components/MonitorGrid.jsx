import { useEffect, useState } from 'react'

const SLOT_COUNT = 9

export default function MonitorGrid({ rooms, liveMap, adThreshold, onRemove, onRefreshRoom, onAdd }) {
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => {
    const room = rooms.find((r) => r.slot === i)
    return { index: i, room: room || null }
  })

  return (
    <div className="grid">
      {slots.map(({ index, room }) =>
        room ? (
          <StreamTileLazy
            key={room.id}
            room={room}
            live={liveMap[room.id]}
            adThreshold={adThreshold}
            refreshToken={refreshTokens[room.id] || 0}
            onRemove={() => onRemove(room.id)}
            onRefresh={() => onRefreshRoom(room.id)}
          />
        ) : (
          <button key={`empty-${index}`} className="grid__empty" onClick={onAdd}>
            <span className="grid__empty-plus">+</span>
            <span>第 {index + 1} 格 · 添加直播间</span>
          </button>
        )
      )}
    </div>
  )
}

/** 按需加载播放器组件，避免首屏一次性打包全部播放依赖 */
function StreamTileLazy(props) {
  const [Comp, setComp] = useState(null)
  useEffect(() => {
    import('./StreamTile.jsx').then((m) => setComp(() => m.default))
  }, [])
  if (!Comp) {
    return (
      <div className="grid__empty grid__empty--loading">
        <span className="spinner" />
      </div>
    )
  }
  return <Comp {...props} />
}
