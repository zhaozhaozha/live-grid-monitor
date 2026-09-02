import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { config } from '../config.js'

const require = createRequire(import.meta.url)

let db = null
let driver = null

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  share_url     TEXT NOT NULL,
  room_id       TEXT,
  title         TEXT,
  anchor_name   TEXT,
  avatar_url    TEXT,
  slot          INTEGER,
  quality       TEXT NOT NULL DEFAULT 'lowest',
  enabled       INTEGER NOT NULL DEFAULT 1,
  cookie        TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_sessions (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  start_at         TEXT NOT NULL,
  end_at           TEXT,
  duration_sec     INTEGER NOT NULL DEFAULT 0,
  peak_online      INTEGER NOT NULL DEFAULT 0,
  avg_online       INTEGER NOT NULL DEFAULT 0,
  sample_count     INTEGER NOT NULL DEFAULT 0,
  ad_count         INTEGER NOT NULL DEFAULT 0,
  ad_duration_sec  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(room_id, start_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_room ON live_sessions(room_id, start_at);

CREATE TABLE IF NOT EXISTS metrics_samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id    TEXT,
  ts            TEXT NOT NULL,
  online_count  INTEGER,
  like_count    INTEGER,
  is_live       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_samples_room_ts ON metrics_samples(room_id, ts);

CREATE TABLE IF NOT EXISTS ad_segments (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session_id    TEXT,
  start_at      TEXT NOT NULL,
  end_at        TEXT,
  duration_sec  INTEGER NOT NULL DEFAULT 0,
  confidence    REAL NOT NULL DEFAULT 0,
  signals       TEXT,
  source        TEXT NOT NULL DEFAULT 'auto',
  verified      INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ad_room_start ON ad_segments(room_id, start_at);

CREATE TABLE IF NOT EXISTS stream_cache (
  room_id      TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  stream_url   TEXT,
  format       TEXT,
  quality      TEXT,
  qualities    TEXT,
  expires_at   TEXT,
  updated_at   TEXT NOT NULL
);
`

/**
 * 双驱动：优先 better-sqlite3（兼容性最好），
 * 装不上时自动回落到 Node 22.5+ 内置的 node:sqlite，保证零原生依赖也能跑。
 */
function openDatabase(file) {
  try {
    const Database = require('better-sqlite3')
    driver = 'better-sqlite3'
    return new Database(file)
  } catch (err) {
    try {
      const { DatabaseSync } = require('node:sqlite')
      driver = 'node:sqlite'
      return new DatabaseSync(file)
    } catch (err2) {
      throw new Error(
        '未找到可用的 SQLite 驱动。请执行 `cd server && npm install` 安装 better-sqlite3，' +
          '或将 Node 升级到 22.5+ 使用内置 node:sqlite。' +
          `\n  原因1: ${err.message}\n  原因2: ${err2.message}`
      )
    }
  }
}

export function getDb() {
  if (db) return db
  const file = config.dbFile
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = openDatabase(file)
  db.exec(SCHEMA)
  return db
}

export function dbDriver() {
  return driver
}

export const nowIso = () => new Date().toISOString()

export const uid = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** 把可能是 undefined 的值规整为 null，避免 SQLite 驱动抛错 */
export const nn = (v) => (v === undefined ? null : v)
