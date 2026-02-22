import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from './logger'
import * as win32Focus from './win32-focus'

const execAsync = promisify(exec)

// ── 前台应用检测 (private helpers) ──

function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`
}

async function run(cmd: string, timeout = 1200): Promise<string> {
  const { stdout } = await execAsync(cmd, { timeout })
  return stdout.trim()
}

async function getFrontmostAppDarwin(): Promise<string | null> {
  try {
    const front = await run('lsappinfo front')
    const asnMatch = front.match(/ASN:[^\s]+/)
    if (asnMatch) {
      const info = await run(`lsappinfo info -only bundleid ${shQuote(asnMatch[0])}`)
      const bundleMatch = info.match(/"CFBundleIdentifier"="([^"]+)"/)
      if (bundleMatch?.[1]) return bundleMatch[1]
    }
  } catch {
    // fallback
  }

  try {
    const id = await run(`osascript -e 'id of app (path to frontmost application as text)'`)
    if (id) return id
  } catch {
    // fallback
  }

  try {
    const id = await run(
      `osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'`,
    )
    if (id) return id
  } catch {
    // ignore
  }

  return null
}

export async function getFrontmostApp(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      return await getFrontmostAppDarwin()
    } else if (process.platform === 'win32') {
      return win32Focus.getWin32ForegroundWindow()
    } else {
      const { stdout } = await execAsync('xdotool getactivewindow', { timeout: 1200 })
      return stdout.trim() || null
    }
  } catch {
    return null
  }
}

export async function restoreFocus(appId: string | null): Promise<void> {
  if (!appId) return
  try {
    if (process.platform === 'darwin') {
      const safeAppId = appId.replace(/"/g, '\\"')
      await execAsync(
        `osascript -e 'tell application id "${safeAppId}" to activate'`,
        { timeout: 1500 },
      )
    } else if (process.platform === 'win32') {
      win32Focus.setWin32ForegroundWindow(appId)
    } else {
      await execAsync(`xdotool windowfocus ${appId}`, { timeout: 1500 })
    }
    await new Promise(r => setTimeout(r, 100))
  } catch {
    // 焦点还原失败不影响主流程
  }
}

// ── FocusController ──

interface FocusControllerOptions {
  isSelfAppId: (appId: string | null) => boolean
  trackerIntervalMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FocusController {
  private lastExternalAppId: string | null = null
  private tracker: NodeJS.Timeout | null = null
  private trackerInFlight = false
  private readonly trackerIntervalMs: number
  private readonly debugTrace: boolean
  private lastFrontmostWarnAt = 0

  constructor(private readonly options: FocusControllerOptions) {
    this.trackerIntervalMs = options.trackerIntervalMs ?? 300
    this.debugTrace = process.env.LOGENE_DEBUG_FOCUS === '1'
  }

  getLastExternalAppId(): string | null {
    return this.lastExternalAppId
  }

  startTracking() {
    if (this.tracker) return
    const tick = () => {
      if (this.trackerInFlight) return
      this.trackerInFlight = true
      void this.captureSnapshot('tracker', false)
        .catch(() => { /* ignore */ })
        .finally(() => { this.trackerInFlight = false })
    }
    tick()
    this.tracker = setInterval(tick, this.trackerIntervalMs)
  }

  stopTracking() {
    if (!this.tracker) return
    clearInterval(this.tracker)
    this.tracker = null
    this.trackerInFlight = false
  }

  async captureSnapshot(reason: string, logResult = true): Promise<string | null> {
    // tracker 已在后台持续更新 lastExternalAppId 缓存。
    // 非 tracker 自身调用时直接返回缓存值，避免 Windows 上每次启动 PowerShell 进程的延迟。
    if (reason !== 'tracker' && this.tracker !== null) {
      const chosen = this.lastExternalAppId
      if (logResult && this.debugTrace) {
        logger.debug(
          `[Focus] snapshot reason=${reason} using cached lastExternal=${chosen ?? 'null'}`,
        )
      }
      return chosen
    }

    const current = await this.getCurrentFrontmost()
    const chosen = current && !this.options.isSelfAppId(current)
      ? current
      : this.lastExternalAppId

    if (logResult && this.debugTrace) {
      logger.debug(
        `[Focus] snapshot reason=${reason} current=${current ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'} chosen=${chosen ?? 'null'}`,
      )
    }
    return chosen
  }

  async restore(snapshot: string | null, reason: string): Promise<void> {
    const target = snapshot || this.lastExternalAppId
    if (!target) {
      if (this.debugTrace) logger.debug(`[Focus] restore skipped reason=${reason} target=null`)
      return
    }

    if (this.debugTrace) {
      logger.debug(
        `[Focus] restore begin reason=${reason} target=${target} snapshot=${snapshot ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'}`,
      )
    }

    for (let i = 0; i < 3; i += 1) {
      await restoreFocus(target)
      const current = await this.getCurrentFrontmost()
      if (this.debugTrace) {
        logger.debug(`[Focus] restore attempt=${i + 1} reason=${reason} target=${target} current=${current ?? 'null'}`)
      }
      if (current === target || (current && !this.options.isSelfAppId(current))) {
        if (this.debugTrace) logger.debug(`[Focus] restore success attempt=${i + 1} reason=${reason} target=${target}`)
        return
      }
      await sleep(70)
    }

    logger.warn(`[Focus] restore exhausted reason=${reason} target=${target}`)
  }

  async isSelfAppFrontmost(reason = 'unknown'): Promise<boolean> {
    const current = await this.getCurrentFrontmost()
    const frontmostIsSelf = Boolean(current && this.options.isSelfAppId(current))
    if (this.debugTrace) {
      logger.debug(
        `[Focus] is-self-frontmost reason=${reason} current=${current ?? 'null'} result=${frontmostIsSelf}`,
      )
    }
    return frontmostIsSelf
  }

  private async getCurrentFrontmost(): Promise<string | null> {
    try {
      const appId = await getFrontmostApp()
      if (appId && !this.options.isSelfAppId(appId)) {
        this.lastExternalAppId = appId
      }
      return appId
    } catch (error) {
      const now = Date.now()
      if (now - this.lastFrontmostWarnAt >= 10000) {
        this.lastFrontmostWarnAt = now
        logger.warn(`[Focus] get-frontmost failed: ${String(error)}`)
      }
      return null
    }
  }
}
