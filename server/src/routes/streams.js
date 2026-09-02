import { getDb } from '../db/index.js'
import { getPlayableStream } from '../services/streamResolver.js'
import { AdapterError } from '../adapters/base.js'

export default async function streamsRoutes(app) {
  /** 取某房间的可播放流地址（带缓存） */
  app.get('/:roomId', async (req, reply) => {
    const db = getDb()
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.roomId)
    if (!room) return reply.code(404).send({ error: '房间不存在' })

    const force = req.query.force === '1'
    try {
      const s = await getPlayableStream(room, { force })
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
