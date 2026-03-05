import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as win32Focus from '../../electron/main/win32-focus'
import { isSelfAppId } from '../../electron/main/self-app'

describe('isSelfAppId', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('Windows 上句柄 PID 等于当前进程时返回 true', () => {
    vi.spyOn(win32Focus, 'getWin32WindowProcessId').mockReturnValue(process.pid)
    const appLike = { getName: () => 'Logene Voice Input' }
    expect(isSelfAppId('123456', 'win32', appLike)).toBe(true)
  })

  it('Windows 上句柄 PID 不一致时返回 false', () => {
    vi.spyOn(win32Focus, 'getWin32WindowProcessId').mockReturnValue(process.pid + 1000)
    const appLike = { getName: () => 'Logene Voice Input' }
    expect(isSelfAppId('123456', 'win32', appLike)).toBe(false)
  })

  it('非 macOS/Windows 平台返回 false', () => {
    const appLike = { getName: () => 'Logene Voice Input' }
    expect(isSelfAppId('com.logene.voice-input', 'linux', appLike)).toBe(false)
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
