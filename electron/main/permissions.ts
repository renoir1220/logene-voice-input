import { dialog, shell, systemPreferences } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'
import { logger } from './logger'
import {
  mainWindow,
  permissionWarned,
  permissionCheckInFlight,
  lastPermissionCheckAt,
  PERMISSION_CHECK_INTERVAL_MS,
  setPermissionWarned,
  setPermissionCheckInFlight,
  setLastPermissionCheckAt,
  dashboardWindow,
} from './app-context'

const execAsync = promisify(exec)

interface PermissionIssue {
  id: 'microphone' | 'accessibility' | 'automation'
  title: string
  guide: string
}

async function canControlSystemEvents(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  try {
    await execAsync(
      `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
      { timeout: 1500 },
    )
    return true
  } catch (err: unknown) {
    const msg = String((err as { stderr?: string; message?: string })?.stderr || (err as { message?: string })?.message || '')
    logger.warn(`[Permission] 无法控制 System Events: ${msg || 'unknown'}`)
    return false
  }
}

async function requestMacPermissionsIfNeeded(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      logger.info('[Permission] 请求麦克风权限...')
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (e) {
    logger.warn(`[Permission] 请求麦克风权限失败: ${String(e)}`)
  }

  try {
    const trusted = systemPreferences.isTrustedAccessibilityClient(true)
    logger.info(`[Permission] 辅助功能授权状态: ${trusted ? 'granted' : 'missing'}`)
  } catch (e) {
    logger.warn(`[Permission] 请求辅助功能权限失败: ${String(e)}`)
  }
}

export function emitPermissionWarning(message: string) {
  logger.warn(`[Permission] ${message}`)
  mainWindow?.webContents.send('permission-warning', message)
  dashboardWindow?.webContents.send('permission-warning', message)
}

function formatPermissionGuide(reason: string, issues: PermissionIssue[]): string {
  const lines = issues.map((item) => `${item.title}：${item.guide}`)
  return `权限检查(${reason})发现缺失：${lines.join(' ')} 如在系统设置里看不到本应用，请先将 App 拖到"应用程序"目录后重启再授权。授权后请重启应用。`
}

async function openPermissionSettings(issues: PermissionIssue[]): Promise<void> {
  const targets = new Set<string>()
  if (process.platform === 'darwin') {
    for (const issue of issues) {
      if (issue.id === 'microphone') targets.add('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      if (issue.id === 'accessibility') targets.add('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
      if (issue.id === 'automation') targets.add('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
    }
  } else if (process.platform === 'win32') {
    for (const issue of issues) {
      if (issue.id === 'microphone') targets.add('ms-settings:privacy-microphone')
    }
  }
  for (const target of targets) {
    try {
      await shell.openExternal(target)
    } catch (e) {
      logger.warn(`[Permission] 打开系统设置失败: ${target} ${String(e)}`)
    }
  }
}

async function collectPermissionIssues(): Promise<PermissionIssue[]> {
  const issues: PermissionIssue[] = []
  if (process.platform !== 'darwin' && process.platform !== 'win32') return issues
  const micStatus = systemPreferences.getMediaAccessStatus('microphone')
  if (micStatus === 'not-determined') {
    issues.push({
      id: 'microphone',
      title: '麦克风',
      guide: '系统尚未弹出麦克风授权，请在弹窗中点击"允许"。若未出现弹窗，请重启应用后重试。',
    })
  }
  if (micStatus === 'denied' || micStatus === 'restricted') {
    issues.push({
      id: 'microphone',
      title: '麦克风',
      guide: `当前状态为 ${micStatus}，请在系统隐私设置中允许本应用访问麦克风。`,
    })
  }
  if (process.platform === 'darwin') {
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      issues.push({
        id: 'accessibility',
        title: '辅助功能',
        guide: '请在 系统设置 -> 隐私与安全性 -> 辅助功能 中允许本应用，以便发送快捷键与文本回填。',
      })
    }
    const canControl = await canControlSystemEvents()
    if (!canControl) {
      issues.push({
        id: 'automation',
        title: '自动化(System Events)',
        guide: '请在 系统设置 -> 隐私与安全性 -> 自动化 中允许本应用控制 System Events，以便识别前台应用和恢复焦点。',
      })
    }
  }
  return issues
}

export async function checkPermissionsAndGuide(reason: string, forcePrompt = false): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return true
  const now = Date.now()
  if (permissionCheckInFlight) return true
  if (!forcePrompt && now - lastPermissionCheckAt < PERMISSION_CHECK_INTERVAL_MS) return true
  setPermissionCheckInFlight(true)
  setLastPermissionCheckAt(now)
  try {
    if (process.platform === 'darwin' && forcePrompt) {
      await requestMacPermissionsIfNeeded()
    }
    const issues = await collectPermissionIssues()
    if (issues.length === 0) {
      setPermissionWarned(false)
      logger.info(`[Permission] 权限检查通过 (${reason})`)
      return true
    }
    const message = formatPermissionGuide(reason, issues)
    if (!permissionWarned || forcePrompt) {
      emitPermissionWarning(message)
      setPermissionWarned(true)
      if (mainWindow) {
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '需要系统权限',
          message: '检测到权限未开启，相关功能暂不可用',
          detail: message,
          buttons: ['打开系统权限设置', '稍后处理'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        if (result.response === 0) {
          await openPermissionSettings(issues)
        }
      }
    } else {
      logger.warn(`[Permission] (${reason}) 仍有权限缺失: ${message}`)
    }
    return false
  } finally {
    setPermissionCheckInFlight(false)
  }
}
