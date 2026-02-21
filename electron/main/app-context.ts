import { BrowserWindow, Tray } from 'electron'
import { logger } from './logger'

// ── 共享应用状态 ──

export let mainWindow: BrowserWindow | null = null
export let dashboardWindow: BrowserWindow | null = null
export let tray: Tray | null = null
export let vadEnabled = false
export let permissionWarned = false
export let permissionCheckInFlight = false
export let hotkeysRegistered = false
export let lastPermissionCheckAt = 0

export const FLOAT_WIDTH = 116
export const FLOAT_HEIGHT = 46
export const VAD_TOGGLE_HOTKEY = 'Alt+Shift+V'
export const PERMISSION_CHECK_INTERVAL_MS = 30_000
export const DEFAULT_LOCAL_MODEL_ID = 'paraformer-zh-contextual-quant'

export let floatPos = { x: 0, y: 0 }

export function setMainWindow(w: BrowserWindow | null) { mainWindow = w }
export function setDashboardWindow(w: BrowserWindow | null) { dashboardWindow = w }
export function setTray(t: Tray | null) { tray = t }
export function setVadEnabled(v: boolean) { vadEnabled = v }
export function setPermissionWarned(v: boolean) { permissionWarned = v }
export function setPermissionCheckInFlight(v: boolean) { permissionCheckInFlight = v }
export function setHotkeysRegistered(v: boolean) { hotkeysRegistered = v }
export function setLastPermissionCheckAt(v: number) { lastPermissionCheckAt = v }
export function setFloatPos(pos: { x: number; y: number }) { floatPos = pos }

// ── 诊断工具 ──

export function stringifyErrorLike(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function attachWebContentsDiagnostics(win: BrowserWindow, name: string) {
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(`[Window:${name}] preload-error path=${preloadPath} err=${stringifyErrorLike(error)}`)
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    const text = `[Window:${name}] console level=${level} ${sourceId || 'unknown'}:${line} ${message}`
    if (level >= 3) logger.error(text)
    else logger.warn(text)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Window:${name}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    logger.error(`[Window:${name}] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
}

// ── 进程错误钩子 ──

let processErrorHooksRegistered = false

export function registerProcessErrorHooks(app: Electron.App) {
  if (processErrorHooksRegistered) return
  processErrorHooksRegistered = true
  process.on('uncaughtException', (error) => {
    logger.error(`[Main] uncaughtException: ${stringifyErrorLike(error)}`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(`[Main] unhandledRejection: ${stringifyErrorLike(reason)}`)
  })
  app.on('child-process-gone', (_event, details) => {
    logger.error(
      `[App] child-process-gone type=${details.type} reason=${details.reason} ` +
      `exitCode=${details.exitCode} name=${details.name ?? 'unknown'} service=${details.serviceName ?? 'unknown'}`,
    )
  })
}
