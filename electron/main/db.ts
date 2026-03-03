import initSqlJs, { type Database } from 'sql.js'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

let db: Database | null = null
let dbPath = ''

export interface RecognitionRecord {
  id: number
  created_at: string
  text: string
  char_count: number
  mode: string
  is_command: number
  command_shortcut: string | null
}

export interface DailyStats {
  todayCount: number
  todayChars: number
  totalCount: number
  totalChars: number
}

export interface AppLogRecord {
  time: string
  level: string
  msg: string
}

const APP_LOG_RETENTION = 10000

/** 将 exec 结果转为对象数组 */
function queryAll<T>(d: Database, sql: string, params?: unknown[]): T[] {
  const stmt = d.prepare(sql)
  if (params) stmt.bind(params as any[])
  const rows: T[] = []
  while (stmt.step()) rows.push(stmt.getAsObject() as T)
  stmt.free()
  return rows
}

/** 查询单行 */
function queryOne<T>(d: Database, sql: string, params?: unknown[]): T {
  const stmt = d.prepare(sql)
  if (params) stmt.bind(params as any[])
  stmt.step()
  const row = stmt.getAsObject() as T
  stmt.free()
  return row
}

/** 执行写操作并持久化 */
function runAndSave(d: Database, sql: string, params?: unknown[]) {
  d.run(sql, params as any[])
  persist()
}

/** 将内存数据库写入磁盘 */
function persist() {
  if (!db) return
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
}

/** 异步初始化数据库（应用启动时调用一次） */
export async function initDb() {
  if (db) return
  dbPath = path.join(app.getPath('userData'), 'history.db')
  const SQL = await initSqlJs()
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath)
    db = new SQL.Database(buf)
  } else {
    db = new SQL.Database()
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS recognition_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      text TEXT NOT NULL,
      char_count INTEGER NOT NULL,
      mode TEXT NOT NULL,
      is_command INTEGER NOT NULL DEFAULT 0,
      command_shortcut TEXT
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      level TEXT NOT NULL,
      msg TEXT NOT NULL
    )
  `)
  persist()
}

/** 获取数据库实例（必须先调用 initDb） */
export function getDb(): Database {
  if (!db) throw new Error('数据库未初始化，请先调用 initDb()')
  return db
}

/** 插入一条识别记录 */
export function insertRecognition(params: {
  text: string
  mode: string
  isCommand: boolean
  commandShortcut?: string
}) {
  const d = getDb()
  runAndSave(d, `
    INSERT INTO recognition_history (text, char_count, mode, is_command, command_shortcut)
    VALUES (?, ?, ?, ?, ?)
  `, [
    params.text,
    params.text.length,
    params.mode,
    params.isCommand ? 1 : 0,
    params.commandShortcut ?? null,
  ])
}

/** 插入一条应用日志（自动裁剪旧日志） */
export function insertAppLog(params: AppLogRecord) {
  if (!db) return  // initDb 尚未完成时静默跳过，日志已写入文件缓冲
  const d = db
  d.run(`INSERT INTO app_logs (time, level, msg) VALUES (?, ?, ?)`,
    [params.time, params.level, params.msg])
  d.run(`DELETE FROM app_logs WHERE id <= COALESCE((SELECT MAX(id) - ? FROM app_logs), -1)`,
    [APP_LOG_RETENTION])
  persist()
}

/** 获取最近日志（按时间正序） */
export function getRecentLogs(limit = 2000): AppLogRecord[] {
  if (!db) return []
  const d = db
  const rows = queryAll<AppLogRecord>(d,
    'SELECT time, level, msg FROM app_logs ORDER BY id DESC LIMIT ?', [limit])
  return rows.reverse()
}

/** 清空应用日志 */
export function clearAppLogs() {
  runAndSave(getDb(), 'DELETE FROM app_logs')
}

/** 获取统计数据 */
export function getStats(): DailyStats {
  const d = getDb()
  const today = queryOne<{ cnt: number; chars: number }>(d,
    `SELECT COUNT(*) as cnt, COALESCE(SUM(char_count), 0) as chars
     FROM recognition_history WHERE date(created_at) = date('now', 'localtime')`)
  const total = queryOne<{ cnt: number; chars: number }>(d,
    `SELECT COUNT(*) as cnt, COALESCE(SUM(char_count), 0) as chars
     FROM recognition_history`)
  return {
    todayCount: today.cnt,
    todayChars: today.chars,
    totalCount: total.cnt,
    totalChars: total.chars,
  }
}

/** 获取最近的识别记录 */
export function getRecentHistory(limit = 50): RecognitionRecord[] {
  return queryAll<RecognitionRecord>(getDb(),
    'SELECT * FROM recognition_history ORDER BY id DESC LIMIT ?', [limit])
}

/** 获取所有识别记录（分页） */
export function getAllHistory(offset = 0, limit = 100): RecognitionRecord[] {
  return queryAll<RecognitionRecord>(getDb(),
    'SELECT * FROM recognition_history ORDER BY id DESC LIMIT ? OFFSET ?', [limit, offset])
}

/** 获取指定日期的非指令识别记录（用于每日总结） */
export function getRecordsByDate(date: string): RecognitionRecord[] {
  return queryAll<RecognitionRecord>(getDb(),
    `SELECT * FROM recognition_history
     WHERE date(created_at) = ? AND is_command = 0
     ORDER BY id ASC`, [date])
}

/** 关闭数据库 */
export function closeDb() {
  if (db) {
    persist()
    db.close()
    db = null
  }
}
