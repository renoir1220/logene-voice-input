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
let _inputSize = 0

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

function loadUser32(): void {
  if (_GetForegroundWindow) return
  const user32 = koffi.load('user32.dll')
  _GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
  _SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
  _SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT_KB *pInputs, int cbSize)')
  _inputSize = koffi.sizeof(INPUT_KB)
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

/** 模拟 Ctrl+V 粘贴（SendInput 版本，对 Chromium 内核应用兼容性更好） */
export function win32PasteClipboard(): void {
  const inputs = [
    makeKeyInput(VK_CONTROL, 0),
    makeKeyInput(VK_V, 0),
    makeKeyInput(VK_V, KEYEVENTF_KEYUP),
    makeKeyInput(VK_CONTROL, KEYEVENTF_KEYUP),
  ]
  _SendInput!(inputs.length, inputs, _inputSize)
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
    _SendInput!(inputs.length, inputs, _inputSize)
  }
}

