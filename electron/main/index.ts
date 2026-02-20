import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
} from 'electron'
import * as path from 'path'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { getConfig, saveConfig, AppConfig } from './config'
import { recognize } from './asr'
import { recognizeLocal, initLocalRecognizer, disposeLocalRecognizer } from './local-asr'
import { getModelStatuses, downloadModel, deleteModel, isModelDownloaded } from './model-manager'
import { initLogger, logger, getLogBuffer } from './logger'
import { matchVoiceCommand } from './voice-commands'
import { typeText, sendShortcut } from './input-sim'
import { getFrontmostApp, restoreFocus } from './focus'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
// VAD 是否启用（运行时状态，与配置同步）
let vadEnabled = false
// 记录悬浮球当前物理坐标（确保收起时回到原位）
let floatPos = { x: 0, y: 0 }
const FLOAT_WIDTH = 116
const FLOAT_HEIGHT = 46
const VAD_TOGGLE_HOTKEY = 'Alt+Shift+V'

function setVadEnabledState(enabled: boolean, emitToRenderer = false): boolean {
  if (vadEnabled === enabled && !emitToRenderer) return vadEnabled
  vadEnabled = enabled
  const cfg = getConfig()
  cfg.vad = {
    enabled: vadEnabled,
    speechThreshold: cfg.vad?.speechThreshold ?? 0.03,
    silenceTimeoutMs: cfg.vad?.silenceTimeoutMs ?? 800,
    minSpeechDurationMs: cfg.vad?.minSpeechDurationMs ?? 300,
  }
  saveConfig(cfg)
  if (emitToRenderer) {
    mainWindow?.webContents.send('toggle-vad', vadEnabled)
  }
  updateTrayMenu()
  return vadEnabled
}

// ── 窗口创建 ──

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea
  // 初始化浮窗默认落点在右下角
  floatPos = { x: sw - FLOAT_WIDTH - 40, y: sh - FLOAT_HEIGHT - 40 }

  mainWindow = new BrowserWindow({
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
    x: floatPos.x,
    y: floatPos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 开发模式加载 vite dev server，生产模式加载打包文件
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'))
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── 系统托盘 ──

function createTray() {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('Logene Voice Input')
  updateTrayMenu()
}

function updateTrayMenu() {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? '隐藏窗口' : '显示窗口',
      click: () => {
        if (mainWindow?.isVisible()) mainWindow.hide()
        else mainWindow?.show()
        updateTrayMenu()
      },
    },
    {
      label: vadEnabled ? '关闭 VAD 智能模式' : '开启 VAD 智能模式',
      click: () => {
        setVadEnabledState(!vadEnabled, true)
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

// ── 热键解析 ──

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

// 将按键名称映射到 uiohook-napi keycode
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
    // 字母键
    A: UiohookKey.A, B: UiohookKey.B, C: UiohookKey.C, D: UiohookKey.D,
    E: UiohookKey.E, F: UiohookKey.F, G: UiohookKey.G, H: UiohookKey.H,
    I: UiohookKey.I, J: UiohookKey.J, K: UiohookKey.K, L: UiohookKey.L,
    M: UiohookKey.M, N: UiohookKey.N, O: UiohookKey.O, P: UiohookKey.P,
    Q: UiohookKey.Q, R: UiohookKey.R, S: UiohookKey.S, T: UiohookKey.T,
    U: UiohookKey.U, V: UiohookKey.V, W: UiohookKey.W, X: UiohookKey.X,
    Y: UiohookKey.Y, Z: UiohookKey.Z,
  }
  return map[name] ?? 0
}

// ── 全局热键（按住录音，松开识别）──

function registerHotkey() {
  const config = getConfig()
  const parsed = parseHotkey(config.hotkey.record)

  if (!parsed.keycode) {
    console.error('[热键] 无法解析热键:', config.hotkey.record)
    return
  }

  let isRecording = false
  let prevApp: string | null = null

  // 按下热键 → 开始录音
  uIOhook.on('keydown', async (e) => {
    if (isRecording) return
    if (e.keycode !== parsed.keycode) return
    if (e.altKey !== parsed.alt) return
    if (e.ctrlKey !== parsed.ctrl) return
    if (e.shiftKey !== parsed.shift) return
    if (e.metaKey !== parsed.meta) return

    isRecording = true
    prevApp = await getFrontmostApp()
    console.log('[热键] 按下，开始录音，前台应用:', prevApp)
    mainWindow?.webContents.send('hotkey-state', 'recording')
  })

  // 松开主键 → 停止录音并识别
  uIOhook.on('keyup', (e) => {
    if (!isRecording) return
    if (e.keycode !== parsed.keycode) return

    isRecording = false
    console.log('[热键] 松开，触发识别')
    mainWindow?.webContents.send('hotkey-stop-recording', prevApp)
  })

  uIOhook.start()

  // 注册全局快捷键，拦截系统冒泡，避免如 Alt+Space 在长按期间一直给焦点应用输入空格
  const registered = globalShortcut.register(config.hotkey.record, async () => {
    // 这仅用于消费和拦截按键，如果不小心 uiohook 没拿到 keydown 也可以在此处补偿
    if (!isRecording) {
      isRecording = true
      prevApp = await getFrontmostApp()
      console.log('[热键/拦截网] 捕获按下，开始录音，前台应用:', prevApp)
      mainWindow?.webContents.send('hotkey-state', 'recording')
    }
  })

  if (registered) {
    console.log('[热键] 已注册拦截:', config.hotkey.record)
  } else {
    console.error('[热键] 拦截注册失败，被其它应用占用或系统不允许:', config.hotkey.record)
  }

  const vadToggleRegistered = globalShortcut.register(VAD_TOGGLE_HOTKEY, () => {
    const enabled = setVadEnabledState(!vadEnabled, true)
    logger.info(`[VAD] 通过快捷键 ${VAD_TOGGLE_HOTKEY} 切换为 ${enabled ? '开启' : '关闭'}`)
  })
  if (vadToggleRegistered) {
    console.log('[VAD] 已注册切换快捷键:', VAD_TOGGLE_HOTKEY)
  } else {
    console.error('[VAD] 切换快捷键注册失败:', VAD_TOGGLE_HOTKEY)
  }
}

// ── IPC 处理 ──

function setupIpc() {
  const config = getConfig()
  vadEnabled = Boolean(config.vad?.enabled)

  ipcMain.handle('get-config', () => getConfig())

  ipcMain.handle('save-config', (_event, cfg: AppConfig) => {
    const current = getConfig()
    // 统一状态入口：普通配置保存不修改 vad.enabled，仅由 set-vad-enabled 控制
    const merged: AppConfig = {
      ...current,
      ...cfg,
      server: { ...current.server, ...cfg.server },
      hotkey: { ...current.hotkey, ...cfg.hotkey },
      input: { ...current.input, ...cfg.input },
      vad: { ...current.vad, ...cfg.vad, enabled: vadEnabled },
      voiceCommands: cfg.voiceCommands ?? current.voiceCommands,
      hotwords: cfg.hotwords ?? current.hotwords,
      asr: { ...current.asr, ...cfg.asr },
    }
    saveConfig(merged)
    updateTrayMenu()
  })

  ipcMain.handle('get-vad-enabled', () => vadEnabled)

  ipcMain.handle('set-vad-enabled', (_event, enabled: boolean) => {
    return setVadEnabledState(Boolean(enabled))
  })

  // 渲染进程完成录音，发来 WAV ArrayBuffer，主进程负责 ASR + 输入
  ipcMain.handle('recognize-wav', async (_event, wavBuffer: ArrayBuffer, prevAppId: string | null) => {
    const cfg = getConfig()
    const buf = Buffer.from(wavBuffer)
    const asrMode = cfg.asr?.mode ?? 'api'
    logger.info(`[ASR] 收到 WAV，大小 ${buf.byteLength} 字节，模式: ${asrMode}`)

    let text: string
    try {
      if (asrMode === 'local') {
        // 本地模型识别
        const modelId = cfg.asr?.localModel ?? 'paraformer-zh-small'
        if (!isModelDownloaded(modelId)) {
          throw new Error(`模型 ${modelId} 尚未下载，请先在设置中下载`)
        }
        await initLocalRecognizer(modelId)
        text = await recognizeLocal(buf)
      } else {
        // 远程 API 识别
        text = await recognize(cfg.server.url, cfg.server.asrConfigId, buf)
      }
    } catch (e) {
      logger.error(`[ASR] 识别失败: ${e}`)
      throw e
    }

    logger.info(`[ASR] 识别结果: "${text}"`)
    if (!text.trim()) return ''

    const result = matchVoiceCommand(text, cfg.voiceCommands)
    await restoreFocus(prevAppId)

    if (result.type === 'command') {
      logger.info(`[ASR] 语音指令: ${text.trim()} → ${result.shortcut}`)
      await sendShortcut(result.shortcut)
      return `${text.trim()} ⌨ ${result.shortcut}`
    } else {
      logger.info(`[ASR] 输入文字: ${result.text}`)
      await typeText(result.text)
      return result.text
    }
  })

  // ── 模型管理 IPC ──
  ipcMain.handle('get-model-statuses', () => getModelStatuses())

  ipcMain.handle('download-model', async (_event, modelId: string) => {
    logger.info(`开始下载模型: ${modelId}`)
    try {
      await downloadModel(modelId, (percent) => {
        mainWindow?.webContents.send('model-download-progress', { modelId, percent })
      })
      return { success: true }
    } catch (e) {
      logger.error(`模型下载失败: ${e}`)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('delete-model', (_event, modelId: string) => {
    deleteModel(modelId)
    // 如果删除的是当前使用的模型，释放识别器
    const cfg = getConfig()
    if (cfg.asr?.localModel === modelId) disposeLocalRecognizer()
  })

  // ── 日志 IPC ──
  ipcMain.handle('get-logs', () => getLogBuffer())

  // 接收前端页面切换尺寸调用的 IPC
  ipcMain.handle('switch-mode', (_event, mode: 'float' | 'dashboard') => {
    if (!mainWindow) return
    if (mode === 'float') {
      mainWindow.setResizable(false)
      mainWindow.setSize(FLOAT_WIDTH, FLOAT_HEIGHT, false)
      mainWindow.setPosition(floatPos.x, floatPos.y, false)
      mainWindow.setAlwaysOnTop(true)
      mainWindow.setHasShadow(false)
      mainWindow.setBackgroundColor('#00000000')
    } else if (mode === 'dashboard') {
      const [x, y] = mainWindow.getPosition()
      if (mainWindow.getSize()[0] === FLOAT_WIDTH) {
        floatPos = { x, y }
      }
      mainWindow.setSize(800, 600, false)
      mainWindow.setResizable(true)
      mainWindow.setAlwaysOnTop(false)
      mainWindow.setHasShadow(true)
      // 主面板恢复白色底以防 macOS 的亚克力特效异常并引发返回时的黑白底色残片
      mainWindow.setBackgroundColor('#ffffff')
      mainWindow.center()
    }
  })

  ipcMain.handle('get-window-position', () => mainWindow?.getPosition() || [0, 0])
  ipcMain.handle('set-window-position', (_event, x: number, y: number) => {
    if (mainWindow) {
      mainWindow.setPosition(Math.round(x), Math.round(y), false)
      if (mainWindow.getSize()[0] === FLOAT_WIDTH) {
        floatPos = { x: Math.round(x), y: Math.round(y) }
      }
    }
  })
}

// ── 应用生命周期 ──

app.whenReady().then(() => {
  // 初始化日志，推送到渲染进程
  initLogger((entry) => {
    mainWindow?.webContents.send('log-entry', entry)
  })
  logger.info('应用启动')

  setupIpc()
  createWindow()
  createTray()
  registerHotkey()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  disposeLocalRecognizer()
  uIOhook.stop()
  globalShortcut.unregisterAll()
})
