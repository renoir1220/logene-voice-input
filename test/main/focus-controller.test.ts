import { describe, expect, it, vi } from 'vitest'
import { FocusController } from '../../electron/main/focus-controller'

describe('FocusController.isSelfAppFrontmost', () => {
  it('当前前台是本应用时返回 true', async () => {
    const focusController = new FocusController({
      isSelfAppId: (appId) => appId === 'com.logene.voice-input',
    })
    ;(focusController as any).getCurrentFrontmost = vi.fn().mockResolvedValue('com.logene.voice-input')

    await expect(focusController.isSelfAppFrontmost('test')).resolves.toBe(true)
  })

  it('当前前台是外部应用时返回 false', async () => {
    const focusController = new FocusController({
      isSelfAppId: (appId) => appId === 'com.logene.voice-input',
    })
    ;(focusController as any).getCurrentFrontmost = vi.fn().mockResolvedValue('com.apple.TextEdit')

    await expect(focusController.isSelfAppFrontmost('test')).resolves.toBe(false)
  })
})
