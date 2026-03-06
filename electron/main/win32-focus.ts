/**
 * Windows 专用：通过 koffi 直接调用 user32.dll，
 * 替代 PowerShell + Add-Type 方案，消除每次 ~500ms 的 C# 编译延迟。
 * 此文件仅在 Windows 上加载，不影响 macOS/Linux 代码路径。
 */

import koffi from 'koffi'

type KoffiFunc = (...args: unknown[]) => unknown

let _GetForegroundWindow: KoffiFunc | null = null
let _SetForegroundWindow: KoffiFunc | null = null
let _SendInput: KoffiFunc | null = null
let _GetWindowThreadProcessId: KoffiFunc | null = null
let _GetCurrentThreadId: KoffiFunc | null = null
let _AttachThreadInput: KoffiFunc | null = null
let _GetGUIThreadInfo: KoffiFunc | null = null
let _GetFocus: KoffiFunc | null = null
let _inputSize = 0
let _guiThreadInfoSize = 0

// SendInput 所需的 INPUT 结构体（仅键盘部分）
// 尾部 _pad 补齐到与 MOUSEINPUT（union 中最大成员）等宽，保证 sizeof 与系统一致
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
})
const INPUT_KB = koffi.struct('INPUT_KB', {
  type: 'uint32',
  ki: KEYBDINPUT,
  _pad: koffi.array('uint8', 8),
})
const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long',
})
const GUITHREADINFO = koffi.struct('GUITHREADINFO', {
  cbSize: 'uint32',
  flags: 'uint32',
  hwndActive: 'intptr_t',
  hwndFocus: 'intptr_t',
  hwndCapture: 'intptr_t',
  hwndMenuOwner: 'intptr_t',
  hwndMoveSize: 'intptr_t',
  hwndCaret: 'intptr_t',
  rcCaret: RECT,
})
const GUI_CARETBLINKING = 0x00000001

function loadUser32(): void {
  if (_GetForegroundWindow) return
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  _GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
  _SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
  _SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT_KB *pInputs, int cbSize)')
  _GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, uint32 *lpdwProcessId)')
  _AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)')
  _GetGUIThreadInfo = user32.func('bool __stdcall GetGUIThreadInfo(uint32 idThread, GUITHREADINFO *lpgui)')
  _GetFocus = user32.func('intptr_t __stdcall GetFocus()')
  _GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
  _inputSize = koffi.sizeof(INPUT_KB)
  _guiThreadInfoSize = koffi.sizeof(GUITHREADINFO)
}

// 仅在 Windows 上预加载，macOS/Linux 不执行
if (process.platform === 'win32') {
  loadUser32()
}

/** 获取当前前台窗口句柄，返回十进制字符串 */
export function getWin32ForegroundWindow(): string | null {
  try {
    const hwnd = _GetForegroundWindow!() as bigint | number
    if (!hwnd) return null
    return String(hwnd)
  } catch {
    return null
  }
}

/** 将指定句柄的窗口设为前台，hwnd 为十进制字符串 */
export function setWin32ForegroundWindow(hwnd: string): boolean {
  try {
    return Boolean(_SetForegroundWindow!(BigInt(hwnd)))
  } catch {
    return false
  }
}

/** 根据窗口句柄获取所属进程 PID */
export function getWin32WindowProcessId(hwnd: string): number | null {
  try {
    const pidOut = [0]
    const threadId = Number(_GetWindowThreadProcessId!(BigInt(hwnd), pidOut))
    if (!threadId || !pidOut[0]) return null
    return Number(pidOut[0])
  } catch {
    return null
  }
}

export interface Win32TextInputProbeResult {
  hasForegroundWindow: boolean
  hasFocusedControl: boolean
  hasCaret: boolean
  likelyWritable: boolean
  foregroundHwnd: string | null
  focusHwnd: string | null
  caretHwnd: string | null
  reason: 'ok' | 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret'
}

/**
 * 探测前台线程的焦点控件状态：
 * - 无前台窗口 / 无焦点控件 / 无插入光标 视为“不可写”
 * - 仅当存在焦点控件且存在 caret 时认为“可写概率高”
 */
export function probeWin32TextInputState(): Win32TextInputProbeResult {
  try {
    const hwnd = _GetForegroundWindow!() as bigint | number
    if (!hwnd) {
      return {
        hasForegroundWindow: false,
        hasFocusedControl: false,
        hasCaret: false,
        likelyWritable: false,
        foregroundHwnd: null,
        focusHwnd: null,
        caretHwnd: null,
        reason: 'no-foreground-window',
      }
    }

    const pidOut = [0]
    const targetThread = Number(_GetWindowThreadProcessId!(hwnd, pidOut))
    if (!targetThread) {
      return {
        hasForegroundWindow: true,
        hasFocusedControl: false,
        hasCaret: false,
        likelyWritable: false,
        foregroundHwnd: String(hwnd),
        focusHwnd: null,
        caretHwnd: null,
        reason: 'no-focused-control',
      }
    }

    const withAttachedThreadInput = <T>(threadId: number, fn: () => T): T => {
      const currentThread = Number(_GetCurrentThreadId!())
      if (!threadId || threadId === currentThread) {
        return fn()
      }
      const attached = Boolean(_AttachThreadInput!(currentThread, threadId, true))
      try {
        return fn()
      } finally {
        if (attached) _AttachThreadInput!(currentThread, threadId, false)
      }
    }

    const readGuiThreadInfo = (threadId: number) => {
      const info = {
        cbSize: _guiThreadInfoSize,
        flags: 0,
        hwndActive: 0,
        hwndFocus: 0,
        hwndCapture: 0,
        hwndMenuOwner: 0,
        hwndMoveSize: 0,
        hwndCaret: 0,
        rcCaret: { left: 0, top: 0, right: 0, bottom: 0 },
      }
      const ok = Boolean(_GetGUIThreadInfo!(threadId, info))
      if (!ok) return null
      return info
    }

    // 先用 GetFocus + AttachThreadInput 读取真实焦点控件句柄（该方法在 Win32 下更稳定）。
    const focusFromGetFocusRaw = withAttachedThreadInput(targetThread, () => _GetFocus!() as bigint | number)
    const focusFromGetFocus = focusFromGetFocusRaw ? String(focusFromGetFocusRaw) : null

    // 另外保留 GUIThreadInfo 作为 caret 辅助信息。
    // 先读前台线程（threadId=0），失败再回退到显式线程 id，降低误判概率。
    const info = readGuiThreadInfo(0) || readGuiThreadInfo(targetThread)
    if (!info && !focusFromGetFocus) {
      return {
        hasForegroundWindow: true,
        hasFocusedControl: false,
        hasCaret: false,
        likelyWritable: false,
        foregroundHwnd: String(hwnd),
        focusHwnd: null,
        caretHwnd: null,
        reason: 'no-focused-control',
      }
    }

    // 可靠性策略：
    // 1) 优先采用 GUIThreadInfo（系统前台线程视角）；
    // 2) GetFocus 仅作为补充，不直接把“有焦点句柄”判定为可写。
    const focusFromGui = info?.hwndFocus ? String(info.hwndFocus) : null
    const focusHwnd = focusFromGui || focusFromGetFocus || null
    const caretFromGui = info?.hwndCaret ? String(info.hwndCaret) : null
    const caretRect = info?.rcCaret
    const caretRectValid = Boolean(
      caretRect && (caretRect.right !== caretRect.left || caretRect.bottom !== caretRect.top),
    )
    const caretBlinking = Boolean((info?.flags ?? 0) & GUI_CARETBLINKING)
    const hasWritableCaret = Boolean(caretFromGui && caretBlinking && caretRectValid)

    if (!focusHwnd) {
      return {
        hasForegroundWindow: true,
        hasFocusedControl: false,
        hasCaret: false,
        likelyWritable: false,
        foregroundHwnd: String(hwnd),
        focusHwnd: null,
        caretHwnd: null,
        reason: 'no-focused-control',
      }
    }

    if (!hasWritableCaret) {
      return {
        hasForegroundWindow: true,
        hasFocusedControl: true,
        hasCaret: false,
        likelyWritable: false,
        foregroundHwnd: String(hwnd),
        focusHwnd,
        caretHwnd: caretFromGui,
        reason: 'focused-control-without-caret',
      }
    }

    return {
      hasForegroundWindow: true,
      hasFocusedControl: true,
      hasCaret: true,
      likelyWritable: true,
      foregroundHwnd: String(hwnd),
      focusHwnd,
      caretHwnd: caretFromGui,
      reason: 'ok',
    }
  } catch {
    return {
      hasForegroundWindow: false,
      hasFocusedControl: false,
      hasCaret: false,
      likelyWritable: false,
      foregroundHwnd: null,
      focusHwnd: null,
      caretHwnd: null,
      reason: 'no-foreground-window',
    }
  }
}

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
const VK_CONTROL = 0x11
const VK_SHIFT = 0x10
const VK_MENU = 0x12  // Alt
const VK_V = 0x56

/** 构造一个键盘 INPUT 结构体 */
function makeKeyInput(vk: number, flags: number) {
  return { type: INPUT_KEYBOARD, ki: { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 }, _pad: new Array(8).fill(0) }
}

/**
 * 将当前线程 attach 到前台窗口的输入线程，执行回调后 detach。
 * 解决 SetForegroundWindow 后焦点尚未就绪导致 SendInput 被拒绝的竞态问题。
 */
function withAttachedInput<T>(fn: () => T): T {
  const hwnd = _GetForegroundWindow!() as bigint | number
  if (!hwnd) return fn()

  const pidOut = [0]
  const targetThread = _GetWindowThreadProcessId!(hwnd, pidOut) as number
  const currentThread = _GetCurrentThreadId!() as number

  if (!targetThread || targetThread === currentThread) return fn()

  const attached = _AttachThreadInput!(currentThread, targetThread, true) as boolean
  try {
    return fn()
  } finally {
    if (attached) _AttachThreadInput!(currentThread, targetThread, false)
  }
}

/** 模拟 Ctrl+V 粘贴（AttachThreadInput + SendInput，确保按键送达 Chromium 等多进程应用） */
export function win32PasteClipboard(): void {
  const inputs = [
    makeKeyInput(VK_CONTROL, 0),
    makeKeyInput(VK_V, 0),
    makeKeyInput(VK_V, KEYEVENTF_KEYUP),
    makeKeyInput(VK_CONTROL, KEYEVENTF_KEYUP),
  ]
  const sent = withAttachedInput(() => Number(_SendInput!(inputs.length, inputs, _inputSize)))
  if (sent !== inputs.length) {
    throw new Error(`SendInput 粘贴失败: sent=${sent}, expected=${inputs.length}`)
  }
}

/** 虚拟键码映射 */
const VK_MAP: Record<string, number> = {
  ALT: VK_MENU, CTRL: VK_CONTROL, CONTROL: VK_CONTROL, SHIFT: VK_SHIFT,
  SPACE: 0x20, ENTER: 0x0D, RETURN: 0x0D, TAB: 0x09,
  ESCAPE: 0x1B, ESC: 0x1B, BACKSPACE: 0x08, DELETE: 0x2E, DEL: 0x2E,
  UP: 0x26, DOWN: 0x28, LEFT: 0x25, RIGHT: 0x27,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
}

/** 模拟快捷键，如 "ALT+R"、"CTRL+SHIFT+F2" */
export function win32SendShortcut(shortcut: string): void {
  const parts = shortcut.toUpperCase().split('+').map(s => s.trim())
  const modifiers: number[] = []
  const keys: number[] = []

  for (const part of parts) {
    const modVk = ({ ALT: VK_MENU, CTRL: VK_CONTROL, CONTROL: VK_CONTROL, SHIFT: VK_SHIFT } as Record<string, number>)[part]
    if (modVk) {
      modifiers.push(modVk)
    } else {
      const vk = VK_MAP[part] ?? (part.length === 1 ? part.charCodeAt(0) : 0)
      if (vk) keys.push(vk)
    }
  }

  const inputs = [
    ...modifiers.map(vk => makeKeyInput(vk, 0)),
    ...keys.map(vk => makeKeyInput(vk, 0)),
    ...[...keys].reverse().map(vk => makeKeyInput(vk, KEYEVENTF_KEYUP)),
    ...[...modifiers].reverse().map(vk => makeKeyInput(vk, KEYEVENTF_KEYUP)),
  ]
  if (inputs.length > 0) {
    const sent = withAttachedInput(() => Number(_SendInput!(inputs.length, inputs, _inputSize)))
    if (sent !== inputs.length) {
      throw new Error(`SendInput 快捷键失败: sent=${sent}, expected=${inputs.length}`)
    }
  }
}

