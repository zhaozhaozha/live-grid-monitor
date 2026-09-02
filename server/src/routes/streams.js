import { Readable } from 'node:stream'
import { getDb } from '../db/index.js'
import { getPlayableStream } from '../services/streamResolver.js'
import { AdapterError } from '../adapters/base.js'
import { config } from '../config.js'

/**
 * 浏览器播放跨域 FLV 兜底：服务端代拉，绕开平台 CDN 重定向链 + 跨域限制。
 * 仅对 flv 做代理；hls(.m3u8) 仍直连（jdcloud CDN 自带 CORS）。
 */
const PLATFORM_REFERER = {
  taobao: 'https://tbzb.taobao.com/',
  jd: 'https://lives.jd.com/',
  douyin: 'https://webcast.amemv.com/',
  kuaishou: 'https://live.kuaishou.com/',
}

export default async function streamsRoutes(app) {
  /**
   * 代拉上游 flv 并回传。stale 时尝试 force 重拉一次：
   * 缓存里的流 URL 带 auth_key，可能中途过期（CDN 拒连 403/302 到错误页），
   * 此时强制刷新流地址再试一次，避免整条 relay 因过期 URL 长期 502。
   */
  async function relayUpstream(room, { signal } = {}) {
    const referer = PLATFORM_REFERER[room.platform] || ''
    const attempt = async (force) => {
      const s = await getPlayableStream(room, { force })
      if (s.format !== 'flv') {
        const err = new Error(`relay 当前仅支持 flv，实际 ${s.format}`)
        err.code = 'NOT_FLV'
        throw err
      }
      // 上游 8s 内必须建立连接并返回响应头，否则视为不可拉（回放态/防盗链 hang 场景），
      // 避免浏览器侧 mpegts.js 无限等待
      const up = await fetch(s.url, {
        headers: { 'User-Agent': config.userAgent, Referer: referer },
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      })
      return { upstream: up, url: s.url }
    }
    let { upstream, url } = await attempt(false)
    // 非 2xx：取消后强制刷新流地址（auth_key 过期等）再试一次
    if (!upstream.ok) {
      try { upstream.body?.cancel() } catch {}
      upstream = (await attempt(true)).upstream
    }
    return { upstream, url }
  }

  // 先注册更具体的 /relay，否则会被 :roomId 截走
  app.get('/:roomId/relay', async (req, reply) => {
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })
    const ac = new AbortController()
    let upstream, url
    try {
      ;({ upstream, url } = await relayUpstream(room, { signal: ac.signal }))
    } catch (err) {
      const status = err.code === 'NOT_FLV' ? 400 : 502
      return reply.code(status).send({ error: err.message })
    }
    if (!upstream.ok || !upstream.body) {
      try { upstream.body?.cancel() } catch {}
      return reply.code(502).send({ error: `上游响应 ${upstream.status}（${url?.slice(0, 60)}…）` })
    }
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Type', 'video/x-flv')
    const nodeStream = Readable.fromWeb(upstream.body)
    const cleanup = () => {
      try { ac.abort() } catch {}
      nodeStream.destroy()
    }
    req.raw.on('close', cleanup)
    nodeStream.on('end', () => { try { req.raw.end() } catch {} })
    nodeStream.on('error', cleanup)
    return reply.send(nodeStream)
  })

  /** 取某房间的可播放流地址（带缓存）——FLV 自动改写为本地 relay URL */
  app.get('/:roomId', async (req, reply) => {
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    const force = req.query.force === '1'
    try {
      const s = await getPlayableStream(room, { force })
      if (s.format === 'flv') {
        // 改写为同源 relay，浏览器侧 mpegts.js 直接打本地，避免跨域 + CDN 重定向链踩坑
        const baseUrl = `${req.protocol}://${req.hostname}`
        return { ok: true, ...s, url: `${baseUrl}/api/streams/${req.params.roomId}/relay`, relayed: true }
      }
      return { ok: true, ...s }
    } catch (err) {
      return reply.code(err instanceof AdapterError ? 422 : 500).send({
        error: err.message,
        code: err.code || 'ERROR',
        hint: err.hint || '',
      })
    }
  })
}