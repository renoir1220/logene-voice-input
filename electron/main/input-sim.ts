import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import { clipboard } from 'electron'
import { classifyPasteTargetProbe, type PasteTargetAssessment } from './paste-plan'
import * as win32Focus from './win32-focus'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export type PasteTargetProbeReason =
  | 'ok'
  | 'unknown'
  | 'no-foreground-window'
  | 'no-focused-control'
  | 'focused-control-without-caret'

export interface PasteTargetProbe {
  ok: boolean
  reason: PasteTargetProbeReason
  source?: 'win32-gui' | 'win32-uia'
  detail?: string
  refineOutcome?: 'writable' | 'non-writable' | 'error'
}

// 将文字输入到目标窗口（剪贴板粘贴方式）
export async function typeText(text: string): Promise<void> {
  clipboard.writeText(text)
  // 短暂延迟确保剪贴板就绪
  await sleep(50)
  await pasteClipboard()
}

// 模拟组合键，如 "ALT+R"、"F2"
export async function sendShortcut(shortcut: string): Promise<void> {
  const platform = process.platform
  if (platform === 'darwin') {
    await sendShortcutMac(shortcut)
  } else if (platform === 'win32') {
    await sendShortcutWin(shortcut)
  } else {
    await sendShortcutLinux(shortcut)
  }
}

// macOS：AppleScript 发送快捷键
async function sendShortcutMac(shortcut: string): Promise<void> {
  const parts = shortcut.toUpperCase().split('+').map(s => s.trim())
  const modifiers: string[] = []
  let mainKey = ''

  for (const part of parts) {
    switch (part) {
      case 'ALT': modifiers.push('option down'); break
      case 'CTRL': case 'CONTROL': modifiers.push('control down'); break
      case 'SHIFT': modifiers.push('shift down'); break
      case 'META': case 'CMD': case 'COMMAND': modifiers.push('command down'); break
      default: mainKey = part
    }
  }

  // F 键用 key code，字母/数字用 keystroke
  const isFKey = /^F\d+$/.test(mainKey)
  const modStr = modifiers.length ? `using {${modifiers.join(', ')}}` : ''

  let script: string
  if (isFKey) {
    const fKeyCode = getFKeyCode(mainKey)
    script = `tell application "System Events" to key code ${fKeyCode} ${modStr}`
  } else {
    const key = mainKey.length === 1 ? mainKey.toLowerCase() : mainKey.toLowerCase()
    script = `tell application "System Events" to keystroke "${key}" ${modStr}`
  }

  await execAsync(`osascript -e '${script}'`)
}

// macOS F 键 key code 映射
function getFKeyCode(fKey: string): number {
  const map: Record<string, number> = {
    F1: 122, F2: 120, F3: 99, F4: 118,
    F5: 96, F6: 97, F7: 98, F8: 100,
    F9: 101, F10: 109, F11: 103, F12: 111,
  }
  return map[fKey] ?? 0
}

// Windows：koffi keybd_event
async function sendShortcutWin(shortcut: string): Promise<void> {
  win32Focus.win32SendShortcut(shortcut)
}

// Linux：xdotool
async function sendShortcutLinux(shortcut: string): Promise<void> {
  const parts = shortcut.toUpperCase().split('+').map(s => s.trim())
  const modMap: Record<string, string> = {
    ALT: 'alt', CTRL: 'ctrl', CONTROL: 'ctrl', SHIFT: 'shift',
    META: 'super', CMD: 'super',
  }
  const keys = parts.map(p => modMap[p] ?? p.toLowerCase()).join('+')
  await execAsync(`xdotool key ${keys}`)
}

// 粘贴剪贴板内容
export async function pasteClipboard(): Promise<void> {
  if (process.platform === 'darwin') {
    await execAsync(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`)
  } else if (process.platform === 'win32') {
    win32Focus.win32PasteClipboard()
  } else {
    await execAsync('xdotool key ctrl+v')
  }
}

/**
 * 仅在 Windows 上做可写焦点探测：
 * - 前台无窗口 / 无焦点控件 / 无 caret 时认为当前不可粘贴
 * - 其他平台暂不做底层探测，返回 unknown 由主流程继续尝试
 */
export function probePasteTarget(): PasteTargetProbe {
  if (process.platform !== 'win32') {
    return { ok: true, reason: 'unknown' }
  }
  const probe = win32Focus.probeWin32TextInputState()
  if (probe.likelyWritable) {
    return { ok: true, reason: 'ok', source: 'win32-gui' }
  }
  return { ok: false, reason: probe.reason, source: 'win32-gui' }
}

function shouldRefinePasteTargetProbe(probe: PasteTargetProbe): boolean {
  if (process.platform !== 'win32') return false
  if (probe.ok) return false
  return probe.reason === 'focused-control-without-caret' || probe.reason === 'no-focused-control'
}

// Win32 某些控件（尤其 Chromium/WebView）不会稳定暴露 caret。
// 当 GUIThreadInfo 判定为 focused-control-without-caret 时，再用 UIA 复核一次可写性。
const UIA_FOCUS_WRITABLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  $el = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -eq $el) {
    @{ writable = $false; reason = 'no-focused-element' } | ConvertTo-Json -Compress
    exit 0
  }

  $valuePatternObj = $null
  $textPatternObj = $null

  $hasValue = $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePatternObj)
  $hasText = $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPatternObj)

  $readOnly = $false
  if ($hasValue -and $valuePatternObj -ne $null) {
    try { $readOnly = [bool]$valuePatternObj.Current.IsReadOnly } catch { }
  }

  $isEnabled = [bool]$el.Current.IsEnabled
  $isFocusable = [bool]$el.Current.IsKeyboardFocusable
  $controlType = [string]$el.Current.ControlType.ProgrammaticName
  $writable = $isEnabled -and $isFocusable -and ((($hasValue -or $hasText) -and (-not $readOnly)) -or ($hasText -and $isEnabled))
  $reason = if ($writable) { 'uia-writable' } else { 'uia-non-writable' }

  @{
    writable = [bool]$writable
    reason = $reason
    hasValue = [bool]$hasValue
    hasText = [bool]$hasText
    readOnly = [bool]$readOnly
    isEnabled = [bool]$isEnabled
    isFocusable = [bool]$isFocusable
    controlType = $controlType
  } | ConvertTo-Json -Compress
} catch {
  @{
    writable = $false
    reason = 'uia-error'
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 0
}
`

function toPowerShellEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function stringifyStdout(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

function parseUiAutomationProbeResult(raw: string): {
  writable?: boolean
  reason?: string
  hasValue?: boolean
  hasText?: boolean
  readOnly?: boolean
  isEnabled?: boolean
  isFocusable?: boolean
  controlType?: string
  error?: string
} | null {
  try {
    const text = raw.replace(/^\uFEFF/, '').trim()
    if (!text) return null
    return JSON.parse(text) as {
      writable?: boolean
      reason?: string
      hasValue?: boolean
      hasText?: boolean
      readOnly?: boolean
      isEnabled?: boolean
      isFocusable?: boolean
      controlType?: string
      error?: string
    }
  } catch {
    return null
  }
}

export async function refinePasteTargetProbe(probe: PasteTargetProbe): Promise<PasteTargetProbe> {
  if (process.platform !== 'win32') return probe
  if (!shouldRefinePasteTargetProbe(probe)) return probe

  try {
    const encoded = toPowerShellEncodedCommand(UIA_FOCUS_WRITABLE_SCRIPT)
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 320, windowsHide: true, maxBuffer: 128 * 1024 },
    )
    const parsed = parseUiAutomationProbeResult(stringifyStdout(stdout))
    if (!parsed) {
      return { ...probe, source: 'win32-uia', detail: 'uia-empty-result', refineOutcome: 'error' }
    }

    const summary = [
      `reason=${parsed.reason ?? 'unknown'}`,
      `type=${parsed.controlType ?? 'unknown'}`,
      `value=${String(parsed.hasValue)}`,
      `text=${String(parsed.hasText)}`,
      `ro=${String(parsed.readOnly)}`,
      `en=${String(parsed.isEnabled)}`,
      `focusable=${String(parsed.isFocusable)}`,
      `err=${parsed.error ? parsed.error.replace(/\s+/g, ' ').slice(0, 120) : ''}`,
    ].join(',')

    if (parsed.writable === true) {
      return { ok: true, reason: 'ok', source: 'win32-uia', detail: summary, refineOutcome: 'writable' }
    }
    if (parsed.reason === 'uia-non-writable' || parsed.reason === 'no-focused-element') {
      return { ok: false, reason: 'no-focused-control', source: 'win32-uia', detail: summary, refineOutcome: 'non-writable' }
    }
    if (parsed.reason === 'uia-error') {
      return { ...probe, source: 'win32-uia', detail: summary, refineOutcome: 'error' }
    }
    return { ...probe, source: 'win32-uia', detail: summary }
  } catch (error) {
    return {
      ...probe,
      source: 'win32-uia',
      detail: `uia-exec-error:${error instanceof Error ? error.message : String(error)}`,
      refineOutcome: 'error',
    }
  }
}

export async function assessPasteTarget(
  options?: { maxAttempts?: number; retryDelayMs?: number },
): Promise<PasteTargetAssessment> {
  const maxAttempts = Math.max(1, Math.min(3, Math.round(options?.maxAttempts ?? 2)))
  const retryDelayMs = Math.max(0, Math.round(options?.retryDelayMs ?? 25))
  let attempts = 0
  let last = await refinePasteTargetProbe(probePasteTarget())
  attempts += 1

  while (attempts < maxAttempts && classifyPasteTargetProbe(last) === 'uncertain') {
    await sleep(retryDelayMs)
    last = await refinePasteTargetProbe(probePasteTarget())
    attempts += 1
  }

  return {
    status: classifyPasteTargetProbe(last),
    reason: last.reason,
    attempts,
    source: last.source,
    detail: last.detail,
    refineOutcome: last.refineOutcome,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 提取当前前台应用中鼠标选中的文本
export async function copySelectedText(): Promise<string> {
  // 增加延时以确保用户触发功能的热键（如 Alt+W）物理按键已松开
  // 否则在 Mac 上混合了修饰键会被识别为 Option+Command+C (拷贝样式) 导致普通文本提取失败
  await sleep(300)

  const oldText = clipboard.readText()
  // 清空剪贴板确保本次获取的是最新鲜的
  clipboard.clear()

  if (process.platform === 'darwin') {
    await execAsync(`osascript -e 'tell application "System Events" to keystroke "c" using {command down}'`)
  } else if (process.platform === 'win32') {
    await execAsync(
      `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"`
    )
  } else {
    await execAsync('xdotool key ctrl+c')
  }

  // 等待系统剪贴板通道写入
  await sleep(200)
  const newText = clipboard.readText()

  // 恢复用户的剪贴板记录以免弄脏他的历史
  if (oldText) {
    clipboard.writeText(oldText)
  }

  return newText
}
