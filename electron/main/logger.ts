import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { insertAppLog, getRecentLogs, clearAppLogs } from './db'
import { getConfig } from './config'

// 日志级别
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  time: string
  level: LogLevel
  msg: string
}

// 内存中保留最近的日志条目，供前端拉取
const LOG_BUFFER_SIZE = 2000
const buffer: LogEntry[] = []

// 日志文件路径
let logFilePath = ''
let logStream: fs.WriteStream | null = null

// 主进程窗口引用，用于推送日志到渲染进程
let _sendToRenderer: ((entry: LogEntry) => void) | null = null

/** 东八区时间字符串 YYYY-MM-DD HH:mm:ss */
function localTimestamp(): string {
  const d = new Date(Date.now() + 8 * 3600000)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** 东八区日期 YYYY-MM-DD */
function localDateStr(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
}

export function initLogger(sendToRenderer?: (entry: LogEntry) => void) {
  const logDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

  // 按日期命名日志文件
  const date = localDateStr()
  logFilePath = path.join(logDir, `${date}.log`)
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' })

  if (sendToRenderer) _sendToRenderer = sendToRenderer

  // 启动时从 SQLite 预热最近日志，保证前端首屏可读取历史日志。
  try {
    const recent = getRecentLogs(LOG_BUFFER_SIZE)
    buffer.length = 0
    buffer.push(...recent.map((entry) => ({
      time: entry.time,
      level: normalizeLevel(entry.level),
      msg: entry.msg,
    })))
  } catch {
    // ignore preload errors
  }
}

function write(level: LogLevel, msg: string) {
  if (level === 'debug' && !isDebugEnabled()) return

  const entry: LogEntry = {
    time: localTimestamp(),
    level,
    msg,
  }

  // 写入内存缓冲
  buffer.push(entry)
  if (buffer.length > LOG_BUFFER_SIZE) buffer.shift()

  // 写入文件
  const line = `[${entry.time}] [${level.toUpperCase()}] ${msg}\n`
  logStream?.write(line)

  // 写入 SQLite（用于前台日志页持久化）
  try {
    insertAppLog(entry)
  } catch (e) {
    // 不能在 logger 内部递归写 logger，这里仅输出控制台
    console.error(`[LOG] sqlite write failed: ${String(e)}`)
  }

  // 推送到渲染进程
  _sendToRenderer?.(entry)

  // 同时输出到控制台
  if (level === 'error') console.error(`[${entry.time}] [LOG] ${msg}`)
  else if (level === 'debug') console.debug(`[${entry.time}] [LOG] ${msg}`)
  else console.log(`[${entry.time}] [LOG] ${msg}`)
}

export const logger = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
}

// 获取缓冲中的日志（供前端首次加载时拉取）
export function getLogBuffer(): LogEntry[] {
  try {
    const rows = getRecentLogs(LOG_BUFFER_SIZE)
    return rows.map((entry) => ({
      time: entry.time,
      level: normalizeLevel(entry.level),
      msg: entry.msg,
    }))
  } catch {
    return [...buffer]
  }
}

export function clearLogs() {
  buffer.length = 0
  try {
    clearAppLogs()
  } catch {
    // ignore clear errors
  }
}

function normalizeLevel(level: string): LogLevel {
  const lv = String(level || '').toLowerCase()
  if (lv === 'debug') return 'debug'
  if (lv === 'error') return 'error'
  if (lv === 'warn' || lv === 'warning') return 'warn'
  return 'info'
}

function isDebugEnabled(): boolean {
  try {
    return Boolean(getConfig().logging?.enableDebug)
  } catch {
    return false
  }
}
