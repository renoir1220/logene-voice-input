import { globalShortcut } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { getConfig } from './config'
import { logger } from './logger'
import { FocusController } from './focus-controller'
import { triggerRewrite } from './rewrite-window'
import {
  mainWindow,
  vadEnabled,
  VAD_TOGGLE_HOTKEY,
  setHotkeysRegistered,
  hotkeysRegistered,
} from './app-context'

interface ParsedHotkey {
  keycode: number
  alt: boolean
  ctrl: boolean
  shift: boolean
  meta: boolean
}

function parseHotkey(hotkey: string): ParsedHotkey {
  const parts = hotkey.split('+').map(p => p.trim().toUpperCase())
  let keycode = 0
  let alt = false, ctrl = false, shift = false, meta = false

  for (const part of parts) {
    switch (part) {
      case 'ALT': alt = true; break
      case 'CTRL': case 'CONTROL': ctrl = true; break
      case 'SHIFT': shift = true; break
      case 'META': case 'CMD': case 'COMMAND': case 'WIN': case 'SUPER':
        meta = true; break
      default:
        keycode = nameToKeycode(part)
    }
  }
  return { keycode, alt, ctrl, shift, meta }
}

function nameToKeycode(name: string): number {
  const map: Record<string, number> = {
    SPACE: UiohookKey.Space,
    ENTER: UiohookKey.Enter, RETURN: UiohookKey.Enter,
    TAB: UiohookKey.Tab,
    ESCAPE: UiohookKey.Escape, ESC: UiohookKey.Escape,
    BACKSPACE: UiohookKey.Backspace,
    DELETE: UiohookKey.Delete, DEL: UiohookKey.Delete,
    UP: UiohookKey.ArrowUp, DOWN: UiohookKey.ArrowDown,
    LEFT: UiohookKey.ArrowLeft, RIGHT: UiohookKey.ArrowRight,
    F1: UiohookKey.F1, F2: UiohookKey.F2, F3: UiohookKey.F3,
    F4: UiohookKey.F4, F5: UiohookKey.F5, F6: UiohookKey.F6,
    F7: UiohookKey.F7, F8: UiohookKey.F8, F9: UiohookKey.F9,
    F10: UiohookKey.F10, F11: UiohookKey.F11, F12: UiohookKey.F12,
    A: UiohookKey.A, B: UiohookKey.B, C: UiohookKey.C, D: UiohookKey.D,
    E: UiohookKey.E, F: UiohookKey.F, G: UiohookKey.G, H: UiohookKey.H,
    I: UiohookKey.I, J: UiohookKey.J, K: UiohookKey.K, L: UiohookKey.L,
    M: UiohookKey.M, N: UiohookKey.N, O: UiohookKey.O, P: UiohookKey.P,
    Q: UiohookKey.Q, R: UiohookKey.R, S: UiohookKey.S, T: UiohookKey.T,
    U: UiohookKey.U, V: UiohookKey.V, W: UiohookKey.W, X: UiohookKey.X,
    Y: UiohookKey.Y, Z: UiohookKey.Z,
    0: UiohookKey['0'], 1: UiohookKey['1'], 2: UiohookKey['2'], 3: UiohookKey['3'], 4: UiohookKey['4'],
    5: UiohookKey['5'], 6: UiohookKey['6'], 7: UiohookKey['7'], 8: UiohookKey['8'], 9: UiohookKey['9'],
  }
  return map[name] ?? 0
}

export function registerHotkey(
  focusController: FocusController,
  setVadEnabledState: (enabled: boolean, emit: boolean) => boolean,
) {
  if (hotkeysRegistered) return
  const config = getConfig()
  const parsed = parseHotkey(config.hotkey.record)
  logger.info(`[热键] 准备注册: ${config.hotkey.record}`)

  if (!parsed.keycode) {
    logger.error(`[热键] 无法解析热键: ${config.hotkey.record}`)
    return
  }

  let isRecording = false
  let prevApp: string | null = null

  uIOhook.on('keydown', async (e) => {
    if (isRecording) return
    if (e.keycode !== parsed.keycode) return
    if (e.altKey !== parsed.alt) return
    if (e.ctrlKey !== parsed.ctrl) return
    if (e.shiftKey !== parsed.shift) return
    if (e.metaKey !== parsed.meta) return

    isRecording = true
    // 先通知渲染进程开始录音，不等焦点快照（避免 Windows 上 PowerShell 延迟）
    mainWindow?.webContents.send('hotkey-state', 'recording')
    prevApp = await focusController.captureSnapshot('hotkey-keydown')
    logger.info(`[热键] 按下，开始录音，前台应用: ${prevApp ?? 'null'}`)
  })

  uIOhook.on('keyup', (e) => {
    if (!isRecording) return
    if (e.keycode !== parsed.keycode) return

    isRecording = false
    logger.info('[热键] 松开，触发识别')
    mainWindow?.webContents.send('hotkey-stop-recording', prevApp)
  })

  try {
    logger.info('[热键] 启动 uiohook...')
    uIOhook.start()
    logger.info('[热键] uiohook 已启用（按住说话，松开识别）')
  } catch (e) {
    throw new Error(`[热键] uiohook 启动失败: ${String(e)}`)
  }

  const registered = globalShortcut.register(config.hotkey.record, async () => {
    if (!isRecording) {
      isRecording = true
      // 先通知渲染进程，再异步获取焦点快照
      mainWindow?.webContents.send('hotkey-state', 'recording')
      prevApp = await focusController.captureSnapshot('hotkey-shortcut-fallback')
      console.log('[热键/拦截网] 捕获按下，开始录音，前台应用:', prevApp)
    }
  })

  if (registered) {
    logger.info(`[热键] 已注册拦截: ${config.hotkey.record}`)
  } else {
    logger.error(`[热键] 拦截注册失败，被其它应用占用或系统不允许: ${config.hotkey.record}`)
  }

  logger.info(`[VAD] 注册切换快捷键: ${VAD_TOGGLE_HOTKEY}`)
  const vadToggleRegistered = globalShortcut.register(VAD_TOGGLE_HOTKEY, () => {
    const enabled = setVadEnabledState(!vadEnabled, true)
    logger.info(`[VAD] 通过快捷键 ${VAD_TOGGLE_HOTKEY} 切换为 ${enabled ? '开启' : '关闭'}`)
  })
  if (vadToggleRegistered) {
    logger.info(`[VAD] 已注册切换快捷键: ${VAD_TOGGLE_HOTKEY}`)
  } else {
    logger.error(`[VAD] 切换快捷键注册失败: ${VAD_TOGGLE_HOTKEY}`)
  }

  logger.info('[Rewrite] 注册快捷键: Alt+W')
  const rewriteRegistered = globalShortcut.register('Alt+W', () => {
    logger.info('[Rewrite] 热键 Alt+W 触发')
    triggerRewrite()
  })
  if (rewriteRegistered) {
    logger.info('[Rewrite] 已注册快捷键: Alt+W')
  } else {
    logger.error('[Rewrite] 快捷键注册失败: Alt+W')
  }
  setHotkeysRegistered(true)
  logger.info('[热键] 注册流程完成')
}
