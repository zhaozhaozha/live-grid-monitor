import { Readable } from 'node:stream'
import { getDb } from '../db/index.js'
import { getPlayableStream } from '../services/streamResolver.js'
import {
  codecOf,
  cachedCodec,
  rememberCodec,
  probeFlvCodecid,
  resolveTaobaoM3u8,
  spawnTranscoder,
  killTranscoder,
} from '../services/transcode.js'
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
   *
   * 失败判定覆盖两类真实场景：
   *  - 建连超时：8s 内拿不到响应头（回放态 hang / 防盗链）
   *  - 空包：响应头已回但 8s 无正文——CDN 对失效 URL 常回 200 空包，
   *    若只看响应头会误判成功，前端将静默 ready=0 无任何提示
   * 注意：超时只约束「建连 + 首字节」，不能约束整个流生命周期，
   * 直播流会持续读取数分钟，总时长超时会在固定秒数掐断正常播放。
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
      // —— 阶段1：建连 + 响应头，8s 预算 ——
      const watchdog = new AbortController()
      const connTimer = setTimeout(
        () => watchdog.abort(new Error('上游 8s 内未建立连接（流地址已失效或防盗链）')),
        8000
      )
      let up
      try {
        up = await fetch(s.url, {
          headers: { 'User-Agent': config.userAgent, Referer: referer },
          redirect: 'follow',
          signal: AbortSignal.any([signal, watchdog.signal]),
        })
      } finally {
        clearTimeout(connTimer)
      }
      if (!up.ok || !up.body) {
        // 非 2xx：交由调用方 force 重拉一次
        return { upstream: up, url: s.url }
      }

      // —— 阶段2：首字节，另给 8s（防 200 空包）——
      // 注意：这里不能用 abort 掐超时——响应头已到、body 已挂 reader 后，
      // abort 会在 undici 内部触发多处游离 rejection（Node 默认直接 crash 进程）。
      // 用 Promise.race 收口：超时则取消 reader，pending read 已映射为值、无 rejection 泄漏。
      const reader = up.body.getReader()
      let byteTimer
      const firstP = reader.read().then((r) => ({ r }), (e) => ({ e }))
      const timeoutP = new Promise((res) => {
        byteTimer = setTimeout(() => res({ timeout: true }), 8000)
      })
      const got = await Promise.race([firstP, timeoutP])
      clearTimeout(byteTimer)
      if (got.timeout) {
        try { await reader.cancel() } catch {}
        await firstP // 收口遗留 read（cancel 后即 settle）
        const err = new Error('上游响应头后 8s 无正文数据（流地址已失效）')
        err.retryableStale = true // 疑似 auth_key 过期 → 调用方 force 重拉一次
        throw err
      }
      if (got.e) throw got.e // read 内部错误（连接被上游中断等）
      if (got.r.done) {
        try { await reader.cancel() } catch {}
        throw new Error('上游返回空流（无任何数据）')
      }
      const first = got.r

      // 首字节已到：持续读取不再设总超时；客户端断开时中止上游
      const nodeStream = Readable.from(
        (async function* streamBody() {
          yield first.value
          for (;;) {
            const r = await reader.read()
            if (r.done) break
            yield r.value
          }
        })()
      )
      return { upstream: up, nodeStream, url: s.url }
    }

    let res
    try {
      res = await attempt(false)
    } catch (err) {
      // auth_key 过期常表现为 200 空包/首字节超时：换新流地址重试一次
      if (err.retryableStale) {
        res = await attempt(true)
      } else {
        throw err
      }
    }
    // 非 2xx（auth_key 过期等）：取消后强制刷新流地址再试一次
    if (!res.upstream.ok) {
      try { res.upstream.body?.cancel() } catch {}
      res = await attempt(true)
    }
    return res
  }

  // 先注册更具体的 /relay，否则会被 :roomId 截走
  app.get('/:roomId/relay', async (req, reply) => {
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    // —— HEVC 判定：编码缓存未命中且为 taobao 房时，探一次上游 flv codecid ——
    // 判定 12(HEVC) 的房间浏览器无法直解，转入 ffmpeg 转码分支（m3u8 → H.264）。
    // 其它平台/未知编码走原直连 relay（错误路径不变，由前端提示兜底）。
    let codec = cachedCodec(room.id)
    if (codec === codecOf.UNKNOWN && room.platform === 'taobao') {
      try {
        const s = await getPlayableStream(room, {})
        if (s.format === 'flv') codec = await probeFlvCodecid(s.url, { referer: PLATFORM_REFERER.taobao })
      } catch {
        codec = codecOf.UNKNOWN // 取流失败等：交给直连分支如实报错
      }
      if (codec === codecOf.AVC || codec === codecOf.HEVC) rememberCodec(room.id, codec)
    }
    if (codec === codecOf.HEVC) {
      return serveTranscoded(room, req, reply)
    }

    // —— 直连 relay（H.264 / 未知编码）——
    const ac = new AbortController()
    let res
    try {
      res = await relayUpstream(room, { signal: ac.signal })
    } catch (err) {
      const status = err.code === 'NOT_FLV' ? 400 : 502
      return reply.code(status).send({ error: err.message })
    }
    if (!res.upstream.ok || !res.nodeStream) {
      try { res.upstream.body?.cancel() } catch {}
      return reply.code(502).send({ error: `上游响应 ${res.upstream.status}（${res.url?.slice(0, 60)}…）` })
    }
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Cache-Control', 'no-store')
    reply.header('Content-Type', 'video/x-flv')
    const nodeStream = res.nodeStream
    const cleanup = () => {
      try { ac.abort() } catch {}
      nodeStream.destroy()
    }
    req.raw.on('close', cleanup)
    nodeStream.on('end', () => { try { req.raw.end() } catch {} })
    nodeStream.on('error', cleanup)
    return reply.send(nodeStream)
  })

  /**
   * HEVC 房间转码回传：拉上游 m3u8，ffmpeg 实时转 H.264 FLV 后原样交给浏览器。
   * 输出为纯视频流（-an），mpegts.js 直解，与直连分支对前端完全透明。
   */
  async function serveTranscoded(room, req, reply) {
    try {
      const m3u8 = await resolveTaobaoM3u8(room)
      if (!m3u8) {
        return reply.code(502).send({ error: '直播间为 HEVC 编码，但未获取到可转码的 m3u8 源流' })
      }
      const { proc, stream: out } = spawnTranscoder(m3u8, { referer: PLATFORM_REFERER.taobao })
      let closed = false
      const cleanup = () => {
        if (closed) return
        closed = true
        killTranscoder(proc)
        try { out.destroy() } catch {}
      }
      req.raw.on('close', cleanup)
      out.on('error', cleanup)
      out.on('end', cleanup)
      // ffmpeg 意外退出（m3u8 过期/分片 403）：结束流 → 浏览器触发自动重连自愈
      proc.once('exit', (code) => {
        if (!closed) cleanup()
      })
      reply.header('Access-Control-Allow-Origin', '*')
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Type', 'video/x-flv')
      reply.header('X-Live-Transcode', 'ffmpeg')
      return reply.send(out)
    } catch (err) {
      return reply.code(502).send({ error: `转码失败：${err.message}` })
    }
  }

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