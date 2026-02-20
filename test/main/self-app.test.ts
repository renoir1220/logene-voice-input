import { describe, expect, it } from 'vitest'
import { isSelfAppId } from '../../electron/main/self-app'

describe('isSelfAppId', () => {
  it('在非 macOS 平台总是 false', () => {
    const appLike = { getName: () => 'Logene Voice Input' }
    expect(isSelfAppId('com.logene.voice-input', 'win32', appLike)).toBe(false)
  })

  it('命中已知 self appId 时返回 true', () => {
    const appLike = { getName: () => 'Electron' }
    expect(isSelfAppId('com.github.Electron', 'darwin', appLike)).toBe(true)
  })

  it('缺少 getBundleID API 时不抛错，并返回 false', () => {
    const appLike = { getName: () => 'Electron' }
    expect(isSelfAppId('com.some.external.app', 'darwin', appLike)).toBe(false)
  })

  it('getBundleID 可用且一致时返回 true', () => {
    const appLike = {
      getName: () => 'Logene Voice Input',
      getBundleID: () => 'com.logene.voice-input',
    }
    expect(isSelfAppId('com.logene.voice-input', 'darwin', appLike)).toBe(true)
  })

  it('getBundleID 抛错时不影响主流程', () => {
    const appLike = {
      getName: () => 'Electron',
      getBundleID: () => {
        throw new Error('not supported')
      },
    }
    expect(isSelfAppId('com.some.external.app', 'darwin', appLike)).toBe(false)
  })
})
