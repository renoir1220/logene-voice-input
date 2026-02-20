import { getFrontmostApp, restoreFocus } from './focus'
import { logger } from './logger'

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
    // 前台应用检测涉及子进程调用，避免过高频率造成主进程压力。
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
    const current = await this.getCurrentFrontmost()
    const chosen = current && !this.options.isSelfAppId(current)
      ? current
      : this.lastExternalAppId

    if (logResult && this.debugTrace) {
      logger.info(
        `[Focus] snapshot reason=${reason} current=${current ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'} chosen=${chosen ?? 'null'}`,
      )
    }
    return chosen
  }

  async restore(snapshot: string | null, reason: string): Promise<void> {
    const target = snapshot || this.lastExternalAppId
    if (!target) {
      if (this.debugTrace) logger.info(`[Focus] restore skipped reason=${reason} target=null`)
      return
    }

    if (this.debugTrace) {
      logger.info(
        `[Focus] restore begin reason=${reason} target=${target} snapshot=${snapshot ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'}`,
      )
    }

    for (let i = 0; i < 3; i += 1) {
      await restoreFocus(target)
      const current = await this.getCurrentFrontmost()
      if (this.debugTrace) {
        logger.info(`[Focus] restore attempt=${i + 1} reason=${reason} target=${target} current=${current ?? 'null'}`)
      }
      if (current === target || (current && !this.options.isSelfAppId(current))) {
        if (this.debugTrace) logger.info(`[Focus] restore success attempt=${i + 1} reason=${reason} target=${target}`)
        return
      }
      await sleep(70)
    }

    logger.warn(`[Focus] restore exhausted reason=${reason} target=${target}`)
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
