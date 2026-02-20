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
  private readonly trackerIntervalMs: number

  constructor(private readonly options: FocusControllerOptions) {
    this.trackerIntervalMs = options.trackerIntervalMs ?? 160
  }

  getLastExternalAppId(): string | null {
    return this.lastExternalAppId
  }

  startTracking() {
    if (this.tracker) return
    const tick = () => {
      void this.captureSnapshot('tracker', false).catch(() => { /* ignore */ })
    }
    tick()
    this.tracker = setInterval(tick, this.trackerIntervalMs)
  }

  stopTracking() {
    if (!this.tracker) return
    clearInterval(this.tracker)
    this.tracker = null
  }

  async captureSnapshot(reason: string, logResult = true): Promise<string | null> {
    const current = await this.getCurrentFrontmost()
    const chosen = current && !this.options.isSelfAppId(current)
      ? current
      : this.lastExternalAppId

    if (logResult) {
      logger.info(
        `[Focus] snapshot reason=${reason} current=${current ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'} chosen=${chosen ?? 'null'}`,
      )
    }
    return chosen
  }

  async restore(snapshot: string | null, reason: string): Promise<void> {
    const target = snapshot || this.lastExternalAppId
    if (!target) {
      logger.info(`[Focus] restore skipped reason=${reason} target=null`)
      return
    }

    logger.info(
      `[Focus] restore begin reason=${reason} target=${target} snapshot=${snapshot ?? 'null'} lastExternal=${this.lastExternalAppId ?? 'null'}`,
    )

    for (let i = 0; i < 3; i += 1) {
      await restoreFocus(target)
      const current = await this.getCurrentFrontmost()
      logger.info(`[Focus] restore attempt=${i + 1} reason=${reason} target=${target} current=${current ?? 'null'}`)
      if (current === target || (current && !this.options.isSelfAppId(current))) {
        logger.info(`[Focus] restore success attempt=${i + 1} reason=${reason} target=${target}`)
        return
      }
      await sleep(70)
    }

    logger.info(`[Focus] restore exhausted reason=${reason} target=${target}`)
  }

  private async getCurrentFrontmost(): Promise<string | null> {
    try {
      const appId = await getFrontmostApp()
      if (appId && !this.options.isSelfAppId(appId)) {
        this.lastExternalAppId = appId
      }
      return appId
    } catch (error) {
      logger.warn(`[Focus] get-frontmost failed: ${String(error)}`)
      return null
    }
  }
}
