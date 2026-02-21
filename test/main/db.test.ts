import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

// mock electron 的 app.getPath，让数据库写到临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logene-db-test-'))
vi.mock('electron', () => ({
  app: { getPath: () => tmpDir },
}))

import {
  initDb,
  getDb,
  insertRecognition,
  insertAppLog,
  getRecentLogs,
  clearAppLogs,
  getStats,
  getRecentHistory,
  getAllHistory,
  getRecordsByDate,
  closeDb,
} from '../../electron/main/db'

// 初始化数据库（异步）
beforeAll(async () => {
  await initDb()
})

afterAll(() => {
  closeDb()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('db', () => {
  it('getDb 返回可用的数据库实例', () => {
    const db = getDb()
    expect(db).toBeDefined()
  })

  it('insertAppLog/getRecentLogs 可写入并读取应用日志', () => {
    clearAppLogs()
    insertAppLog({ time: '2026-02-21T00:00:00.000Z', level: 'warn', msg: 'first' })
    insertAppLog({ time: '2026-02-21T00:00:01.000Z', level: 'error', msg: 'second' })
    const logs = getRecentLogs(10)
    expect(logs).toHaveLength(2)
    expect(logs[0].msg).toBe('first')
    expect(logs[1].level).toBe('error')
  })

  it('clearAppLogs 可清空应用日志', () => {
    clearAppLogs()
    insertAppLog({ time: '2026-02-21T00:00:02.000Z', level: 'info', msg: 'temp' })
    expect(getRecentLogs(10).length).toBe(1)
    clearAppLogs()
    expect(getRecentLogs(10)).toHaveLength(0)
  })

  it('insertRecognition 插入文本记录', () => {
    insertRecognition({ text: '你好世界', mode: 'local', isCommand: false })
    const rows = getRecentHistory(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('你好世界')
    expect(rows[0].char_count).toBe(4)
    expect(rows[0].mode).toBe('local')
    expect(rows[0].is_command).toBe(0)
    expect(rows[0].command_shortcut).toBeNull()
  })

  it('insertRecognition 插入指令记录', () => {
    insertRecognition({
      text: '保存报告',
      mode: 'api',
      isCommand: true,
      commandShortcut: 'F2',
    })
    const rows = getRecentHistory(1)
    expect(rows[0].text).toBe('保存报告')
    expect(rows[0].is_command).toBe(1)
    expect(rows[0].command_shortcut).toBe('F2')
  })
})

describe('getStats', () => {
  it('返回正确的统计数据', () => {
    const stats = getStats()
    expect(stats.totalCount).toBeGreaterThanOrEqual(2)
    expect(stats.totalChars).toBeGreaterThanOrEqual(8)
    expect(stats.todayCount).toBeGreaterThanOrEqual(2)
    expect(stats.todayChars).toBeGreaterThanOrEqual(8)
  })
})

describe('getRecentHistory', () => {
  it('按 id 降序返回', () => {
    const rows = getRecentHistory(10)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0].id).toBeGreaterThan(rows[1].id)
  })

  it('limit 参数生效', () => {
    const rows = getRecentHistory(1)
    expect(rows).toHaveLength(1)
  })
})

describe('getAllHistory', () => {
  it('支持分页', () => {
    const page1 = getAllHistory(0, 1)
    const page2 = getAllHistory(1, 1)
    expect(page1).toHaveLength(1)
    expect(page2).toHaveLength(1)
    expect(page1[0].id).not.toBe(page2[0].id)
  })
})

describe('getRecordsByDate', () => {
  it('返回指定日期的非指令记录', () => {
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const rows = getRecordsByDate(dateStr)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows.every(r => r.is_command === 0)).toBe(true)
  })

  it('不存在的日期返回空数组', () => {
    const rows = getRecordsByDate('2000-01-01')
    expect(rows).toHaveLength(0)
  })
})
