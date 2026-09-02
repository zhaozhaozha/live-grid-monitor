import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 零依赖 .env 加载器：已存在于 process.env 的变量优先，不被文件覆盖 */
function loadDotEnv() {
  const file = path.resolve(__dirname, '../.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?\s*$/)
    if (!m || m[1].startsWith('#')) continue
    let val = (m[2] || '').trim()
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1)
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
}
loadDotEnv()

function env(key, fallback) {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

export const config = {
  port: Number(env('PORT', '8787')),
  host: env('HOST', '0.0.0.0'),
  logLevel: env('LOG_LEVEL', 'info'),
  dbFile: path.resolve(
    env('DB_FILE', '') || path.resolve(__dirname, '../../data/live-grid.db')
  ),

  /** 直播间数据轮询间隔（秒）。过低会触发平台风控。 */
  pollIntervalSec: Number(env('POLL_INTERVAL_SEC', '30')),
  /** 连续多少次轮询判定为离线才真正结束本场直播（容忍短暂断流） */
  offlineGraceCount: Number(env('OFFLINE_GRACE_COUNT', '3')),
  /** 流地址缓存有效期（秒） */
  streamCacheTtlSec: Number(env('STREAM_CACHE_TTL_SEC', '1800')),

  /** 全局默认 UA，适配器可覆盖 */
  userAgent: env(
    'USER_AGENT',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  ),
  /** 兜底 Cookie：DOUYIN_COOKIE / KUAISHOU_COOKIE 等按平台注入 */
  cookies: {
    douyin: env('DOUYIN_COOKIE', ''),
    kuaishou: env('KUAISHOU_COOKIE', ''),
    taobao: env('TAOBAO_COOKIE', ''),
    wxchannel: env('WXCHANNEL_COOKIE', ''),
    xiaohongshu: env('XHS_COOKIE', ''),
  },
  /** 请求超时（毫秒） */
  requestTimeoutMs: Number(env('REQUEST_TIMEOUT_MS', '15000')),
  /** 广告自动识别的置信度阈值（0~1），前端会拉取该值作为默认值 */
  adScoreThreshold: Number(env('AD_SCORE_THRESHOLD', '0.62')),
}
