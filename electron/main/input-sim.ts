import { exec } from 'child_process'
import { promisify } from 'util'
import { clipboard } from 'electron'

const execAsync = promisify(exec)

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

// Windows：PowerShell SendKeys
async function sendShortcutWin(shortcut: string): Promise<void> {
  const parts = shortcut.toUpperCase().split('+').map(s => s.trim())
  const modMap: Record<string, string> = {
    ALT: '%', CTRL: '^', CONTROL: '^', SHIFT: '+',
  }
  let mods = ''
  let mainKey = ''
  for (const part of parts) {
    if (modMap[part]) mods += modMap[part]
    else mainKey = part
  }
  const sendKey = mainKey.length === 1 ? mainKey.toLowerCase() : `{${mainKey}}`
  const keys = `${mods}${sendKey}`
  await execAsync(
    `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')"`,
  )
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
    await execAsync(
      `powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
    )
  } else {
    await execAsync('xdotool key ctrl+v')
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
