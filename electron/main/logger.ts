import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// 日志级别
export type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  time: string
  level: LogLevel
  msg: string
}

// 内存中保留最近的日志条目，供前端拉取
const LOG_BUFFER_SIZE = 500
const buffer: LogEntry[] = []

// 日志文件路径
let logFilePath = ''
let logStream: fs.WriteStream | null = null

// 主进程窗口引用，用于推送日志到渲染进程
let _sendToRenderer: ((entry: LogEntry) => void) | null = null

export function initLogger(sendToRenderer?: (entry: LogEntry) => void) {
  const logDir = path.join(app.getPath('userData'), 'logs')
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })

  // 按日期命名日志文件
  const date = new Date().toISOString().slice(0, 10)
  logFilePath = path.join(logDir, `${date}.log`)
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' })

  if (sendToRenderer) _sendToRenderer = sendToRenderer
}

function write(level: LogLevel, msg: string) {
  const entry: LogEntry = {
    time: new Date().toISOString(),
    level,
    msg,
  }

  // 写入内存缓冲
  buffer.push(entry)
  if (buffer.length > LOG_BUFFER_SIZE) buffer.shift()

  // 写入文件
  const line = `[${entry.time}] [${level.toUpperCase()}] ${msg}\n`
  logStream?.write(line)

  // 推送到渲染进程
  _sendToRenderer?.(entry)

  // 同时输出到控制台
  if (level === 'error') console.error(`[LOG] ${msg}`)
  else console.log(`[LOG] ${msg}`)
}

export const logger = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
}

// 获取缓冲中的日志（供前端首次加载时拉取）
export function getLogBuffer(): LogEntry[] {
  return [...buffer]
}

export function clearLogs() {
  buffer.length = 0
}
