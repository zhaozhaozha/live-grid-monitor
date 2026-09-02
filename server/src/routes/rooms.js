import { getDb, nowIso, uid } from '../db/index.js'
import { detectPlatform, listAdapters } from '../adapters/index.js'
import { resolveRoomInfo } from '../services/streamResolver.js'
import { closeAllSessions } from '../services/poller.js'
import { AdapterError } from '../adapters/base.js'

const MAX_SLOTS = 9

export default async function roomsRoutes(app) {
  /** 平台能力清单（前端「添加直播间」弹窗用） */
  app.get('/platforms', async () => ({ items: listAdapters() }))

  app.get('/', async () => {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM rooms ORDER BY slot ASC, created_at ASC').all()
    return { items: rows.map(mapRoom) }
  })

  /**
   * 实时快照：每个房间的最新在线人数 + 当前场次开播时间 + 进行中的广告段。
   * 前端每 10s 拉一次，用于宫格上的角标展示。
   */
  app.get('/live', async () => {
    const db = getDb()
    const rooms = db.prepare('SELECT * FROM rooms WHERE enabled = 1').all()
    const items = {}

    for (const r of rooms) {
      const sample = db
        .prepare(
          `SELECT ts, online_count, like_count, is_live FROM metrics_samples
           WHERE room_id = ? ORDER BY ts DESC, id DESC LIMIT 1`
        )
        .get(r.id)

      const session = db
        .prepare(
          `SELECT id, start_at FROM live_sessions
           WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1`
        )
        .get(r.id)

      const openAd = db
        .prepare(
          `SELECT id, start_at FROM ad_segments
           WHERE room_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1`
        )
        .get(r.id)

      items[r.id] = {
        id: r.id,
        slot: r.slot,
        online_count: sample?.online_count ?? null,
        like_count: sample?.like_count ?? null,
        is_live: sample ? Boolean(sample.is_live) : null,
        sampled_at: sample?.ts ?? null,
        session_start: session?.start_at ?? null,
        session_id: session?.id ?? null,
        ad_open: openAd ? { id: openAd.id, since: openAd.start_at } : null,
      }
    }
    return { items, at: nowIso() }
  })

  /** 解析分享链接（不落库，用于添加前的预览） */
  app.post('/parse', async (req, reply) => {
    const { url, platform, cookie, force } = req.body || {}
    if (!url) return reply.code(400).send({ error: '缺少 url' })
    try {
      const info = await resolveRoomInfo({ platform, shareUrl: url, cookie, force })
      return {
        ok: true,
        platform: info.platform || detectPlatform(url),
        roomId: info.room_id || info.roomId,
        title: info.title,
        anchorName: info.anchor_name || info.anchorName,
        avatarUrl: info.avatar_url || info.avatarUrl,
        isLive: Boolean(info.isLive ?? info.is_live),
      }
    } catch (err) {
      return reply.code(err instanceof AdapterError ? 422 : 500).send({
        error: err.message,
        code: err.code || 'ERROR',
        hint: err.hint || '',
      })
    }
  })

  app.post('/', async (req, reply) => {
    const { url, platform, slot, cookie, title, quality = 'lowest' } = req.body || {}
    if (!url) return reply.code(400).send({ error: '缺少直播间链接' })

    const db = getDb()
    const key = platform || detectPlatform(url)

    // 适配器返回 camelCase，DB 列是 snake_case，这里统一规整并消除 undefined
    let meta = { room_id: null, title: null, anchor_name: '', avatar_url: '', isLive: false }
    let parseError = null
    try {
      const r = await resolveRoomInfo({ platform: key, shareUrl: url, cookie })
      meta = {
        room_id: nn(r.room_id ?? r.roomId),
        title: nn(r.title ?? r.room_id ?? title),
        anchor_name: nn(r.anchor_name ?? r.anchorName ?? ''),
        avatar_url: nn(r.avatar_url ?? r.avatarUrl ?? ''),
        isLive: Boolean(r.isLive ?? r.is_live),
      }
    } catch (err) {
      // stub 平台解析必然失败，允许先占位保存，后续用直链补
      parseError = err.message
      if (key !== 'direct') {
        return reply.code(422).send({ error: err.message, code: err.code, hint: err.hint })
      }
    }

    // 自动分配宫格位置
    let targetSlot = Number.isInteger(slot) && slot >= 0 && slot < MAX_SLOTS ? slot : null
    if (targetSlot === null) {
      const used = new Set(db.prepare('SELECT slot FROM rooms WHERE slot IS NOT NULL').all().map((r) => r.slot))
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (!used.has(i)) {
          targetSlot = i
          break
        }
      }
    }
    if (targetSlot === null) {
      return reply.code(409).send({ error: `最多同时监控 ${MAX_SLOTS} 个直播间` })
    }

    // 同一宫格位置已有房间则替换
    db.prepare('DELETE FROM rooms WHERE slot = ?').run(targetSlot)

    const id = uid('room')
    const ts = nowIso()
    db.prepare(
      `INSERT INTO rooms (id, platform, share_url, room_id, title, anchor_name, avatar_url,
                          slot, quality, enabled, cookie, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
    ).run(
      id,
      key,
      url,
      meta.room_id,
      meta.title || url,
      meta.anchor_name,
      meta.avatar_url,
      targetSlot,
      quality || 'lowest',
      cookie || null,
      parseError,
      ts,
      ts
    )

    return reply.code(201).send({ item: mapRoom(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)) })
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params
    const allowed = ['title', 'anchor_name', 'slot', 'quality', 'enabled', 'cookie', 'share_url']
    const patch = Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
    if (!patch.length) return reply.code(400).send({ error: '没有可更新字段' })

    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    if ('share_url' in Object.fromEntries(patch)) {
      db.prepare('DELETE FROM stream_cache WHERE room_id = ?').run(id)
    }

    const sets = patch.map(([k]) => `${k} = ?`).join(', ')
    db.prepare(`UPDATE rooms SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...patch.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)),
      nowIso(),
      id
    )
    return { item: mapRoom(db.prepare('SELECT * FROM rooms WHERE id = ?').get(id)) }
  })

  app.delete('/:id', async (req, reply) => {
    const db = getDb()
    closeAllSessions(req.params.id)
    const res = db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id)
    if (!res.changes) return reply.code(404).send({ error: '房间不存在' })
    return { ok: true }
  })

  /** 手动关场（主播下播但采集器未识别到时使用） */
  app.post('/:id/close-session', async (req, reply) => {
    const db = getDb()
    const n = closeAllSessions(req.params.id)
    if (!n) return reply.code(404).send({ error: '没有进行中的场次' })
    return { ok: true, closed: n }
  })
}

function mapRoom(r) {
  if (!r) return null
  return {
    ...r,
    enabled: Boolean(r.enabled),
    isLive: undefined,
  }
}
