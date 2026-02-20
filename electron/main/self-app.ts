import type { app as ElectronApp } from 'electron'

type AppLike = Pick<typeof ElectronApp, 'getName'> & {
  getBundleID?: () => string
}

const KNOWN_SELF_APP_IDS = new Set([
  'com.github.Electron',
  'com.logene.voice-input',
  'com.logene.voice-input.electron',
])

export function isSelfAppId(
  appId: string | null,
  platform: NodeJS.Platform,
  electronApp: AppLike,
): boolean {
  if (!appId) return false
  if (platform !== 'darwin') return false

  if (KNOWN_SELF_APP_IDS.has(appId)) return true

  // 某些运行态（尤其开发模式）没有 getBundleID，不能直接调用。
  if (typeof electronApp.getBundleID === 'function') {
    try {
      const bundleId = electronApp.getBundleID()
      if (bundleId && appId === bundleId) return true
    } catch {
      // ignore
    }
  }

  return false
}
