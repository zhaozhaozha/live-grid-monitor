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
  // 先注册更具体的 /relay，否则会被 :roomId 截走
  app.get('/:roomId/relay', async (req, reply) => {
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })
    let s
    try {
      s = await getPlayableStream(room, { force: req.query.force === '1' })
    } catch (err) {
      return reply.code(err instanceof AdapterError ? 422 : 500).send({
        error: err.message,
        code: err.code || 'ERROR',
        hint: err.hint || '',
      })
    }
    if (s.format !== 'flv') {
      return reply.code(400).send({ error: 'relay 当前仅支持 flv', format: s.format })
    }
    const referer = PLATFORM_REFERER[room.platform] || ''
    const ac = new AbortController()
    let upstream
    try {
      upstream = await fetch(s.url, {
        headers: { 'User-Agent': config.userAgent, Referer: referer },
        redirect: 'follow',
        signal: ac.signal,
      })
    } catch (err) {
      return reply.code(502).send({ error: '上游拉流失败：' + err.message })
    }
    if (!upstream.ok || !upstream.body) {
      try { upstream.body?.cancel() } catch {}
      return reply.code(502).send({ error: `上游响应 ${upstream.status}` })
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