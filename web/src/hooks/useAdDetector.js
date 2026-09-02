import { useEffect, useRef, useState } from 'react'
import { AdDetector } from '../lib/adDetector.js'
import { api } from '../lib/api.js'

/**
 * 把 AdDetector 接到 React 组件上，并把识别结果上报后端。
 *
 * 上报策略：
 *  - 进入 AD  -> 立即开段（拿到 segmentId）
 *  - 退出 AD  -> 闭段结算时长（后端会丢弃 <5s 的噪声段）
 *  - 组件卸载 -> 若仍在 AD 状态则补一次闭段，防止数据悬挂
 */
export function useAdDetector(videoRef, roomId, { enabled = true, threshold = 0.62 } = {}) {
  const [state, setState] = useState('LIVE')
  const [score, setScore] = useState(0)
  const [signals, setSignals] = useState(null)
  const [debug, setDebug] = useState(null)

  const detectorRef = useRef(null)
  const segIdRef = useRef(null)
  const stateRef = useRef('LIVE')

  useEffect(() => {
    if (!enabled || !videoRef.current || !roomId) return

    const detector = new AdDetector({
      videoEl: videoRef.current,
      threshold,
      onSample: (s) => {
        setScore(s.score)
        setSignals(s)
      },
      onStateChange: async (next, meta) => {
        stateRef.current = next
        setState(next)
        try {
          if (next === 'AD') {
            const r = await api.openAd({
              roomId,
              startAt: new Date().toISOString(),
              confidence: meta.score,
              signals: meta.signals,
            })
            segIdRef.current = r.id
          } else if (segIdRef.current) {
            await api.closeAd(segIdRef.current, { endAt: new Date().toISOString() })
            segIdRef.current = null
          }
        } catch (err) {
          console.warn('[ad] 上报失败:', err.message)
        }
      },
    })

    detectorRef.current = detector
    detector.start()

    const dbg = setInterval(() => setDebug(detector.debug()), 2000)

    return () => {
      clearInterval(dbg)
      // 卸载时补闭段
      if (segIdRef.current) {
        api.closeAd(segIdRef.current, { endAt: new Date().toISOString() }).catch(() => {})
        segIdRef.current = null
      }
      detector.stop()
      detectorRef.current = null
    }
  }, [videoRef, roomId, enabled, threshold])

  return {
    state,
    score,
    signals,
    debug,
    bumpKeyword: (w) => detectorRef.current?.bumpKeyword(w),
    markManual: (kind) => detectorRef.current?.markManual(kind),
  }
}
