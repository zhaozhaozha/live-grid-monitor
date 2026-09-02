import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import staticPlugin from '@fastify/static'

import { config } from './config.js'
import { getDb } from './db/index.js'
import { startPoller } from './services/poller.js'
import { registerAdapters } from './adapters/index.js'
import roomsRoutes from './routes/rooms.js'
import streamsRoutes from './routes/streams.js'
import metricsRoutes from './routes/metrics.js'
import reportsRoutes from './routes/reports.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function buildServer({ logger = true } = {}) {
  getDb()
  registerAdapters()

  const app = Fastify({ logger, bodyLimit: 2 * 1024 * 1024 })
  await app.register(cors, { origin: true, credentials: true })

  app.get('/api/health', async () => ({
    ok: true,
    version: '1.0.0',
    time: new Date().toISOString(),
    platforms: Object.keys((await import('./adapters/index.js')).listAdapters()),
  }))

  await app.register(roomsRoutes, { prefix: '/api/rooms' })
  await app.register(streamsRoutes, { prefix: '/api/streams' })
  await app.register(metricsRoutes, { prefix: '/api/metrics' })
  await app.register(reportsRoutes, { prefix: '/api/reports' })

  // 生产模式下若已构建前端产物，则一并托管静态资源
  const dist = path.resolve(__dirname, '../../web/dist')
  if (fs.existsSync(dist)) {
    await app.register(staticPlugin, { root: dist, prefix: '/' })
    app.setNotFoundHandler((req, reply) => reply.sendFile('index.html'))
  }

  return app
}

export async function start() {
  const app = await buildServer({ logger: { level: config.logLevel } })
  startPoller()
  try {
    await app.listen({ port: config.port, host: config.host })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start()
}
