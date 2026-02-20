import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
  shell,
  systemPreferences,
  clipboard,
} from 'electron'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { uIOhook, UiohookKey } from 'uiohook-napi'
import { getConfig, saveConfig, AppConfig } from './config'
import { recognize } from './asr'
import { recognizeLocal, initLocalRecognizer, disposeLocalRecognizer } from './local-asr'
import { getModelInfoList, inspectLocalModelStatus } from './model-manager'
import { initLogger, logger, getLogBuffer, clearLogs } from './logger'
import { matchVoiceCommand } from './voice-commands'
import { typeText, sendShortcut } from './input-sim'
import { FocusController } from './focus-controller'
import { normalizeAsrText } from './asr-text'
import { isSelfAppId } from './self-app'
import { initRewriteWindow, triggerRewrite } from './rewrite-window'

const execAsync = promisify(exec)
let mainWindow: BrowserWindow | null = null
let dashboardWindow: BrowserWindow | null = null
let tray: Tray | null = null
// VAD 是否启用（运行时状态，与配置同步）
let vadEnabled = false
let asrRequestSeq = 0
let permissionWarned = false
let permissionCheckInFlight = false
let hotkeysRegistered = false
let lastPermissionCheckAt = 0
// 记录悬浮球当前物理坐标（确保收起时回到原位）
let floatPos = { x: 0, y: 0 }
const FLOAT_WIDTH = 116
const FLOAT_HEIGHT = 46
const VAD_TOGGLE_HOTKEY = 'Alt+Shift+V'
const PERMISSION_CHECK_INTERVAL_MS = 30_000

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
    // 传 true 会触发系统引导弹窗，并让应用进入辅助功能候选列表。
    const trusted = systemPreferences.isTrustedAccessibilityClient(true)
    logger.info(`[Permission] 辅助功能授权状态: ${trusted ? 'granted' : 'missing'}`)
  } catch (e) {
    logger.warn(`[Permission] 请求辅助功能权限失败: ${String(e)}`)
  }
}

function emitPermissionWarning(message: string) {
  logger.warn(`[Permission] ${message}`)
  mainWindow?.webContents.send('permission-warning', message)
  dashboardWindow?.webContents.send('permission-warning', message)
}

function formatPermissionGuide(reason: string, issues: PermissionIssue[]): string {
  const lines = issues.map((item) => `${item.title}：${item.guide}`)
  return `权限检查(${reason})发现缺失：${lines.join(' ')} 如在系统设置里看不到本应用，请先将 App 拖到“应用程序”目录后重启再授权。授权后请重启应用。`
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
      guide: '系统尚未弹出麦克风授权，请在弹窗中点击“允许”。若未出现弹窗，请重启应用后重试。',
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

async function checkPermissionsAndGuide(reason: string, forcePrompt = false): Promise<boolean> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return true
  const now = Date.now()
  if (permissionCheckInFlight) return true
  if (!forcePrompt && now - lastPermissionCheckAt < PERMISSION_CHECK_INTERVAL_MS) return true
  permissionCheckInFlight = true
  lastPermissionCheckAt = now
  try {
    if (process.platform === 'darwin' && forcePrompt) {
      await requestMacPermissionsIfNeeded()
    }
    const issues = await collectPermissionIssues()
    if (issues.length === 0) {
      permissionWarned = false
      logger.info(`[Permission] 权限检查通过 (${reason})`)
      return true
    }
    const message = formatPermissionGuide(reason, issues)
    if (!permissionWarned || forcePrompt) {
      emitPermissionWarning(message)
      permissionWarned = true
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
    permissionCheckInFlight = false
  }
}

const focusController = new FocusController({
  isSelfAppId: (appId) => isSelfAppId(appId, process.platform, app),
})

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
    type: process.platform === 'darwin' ? 'panel' : 'toolbar', // 关键！Mac上的 panel 或 win 上的 toolbar 才能真正在系统级避免抢走编辑器的焦点
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
    x: floatPos.x,
    y: floatPos.y,
    frame: false,
    transparent: true,
    show: false,
    focusable: false,
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
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 关键：让悬浮球点击时不夺走系统焦点，保持用户原有文本框/选区不被打断。
  // 结合上方的 type: 'panel'，此时 macOS 上点击浮窗按钮已可避免 Input/Textarea 脱焦。
  mainWindow.setFocusable(false)
  mainWindow.setAlwaysOnTop(true, 'floating', 1)
  mainWindow.once('ready-to-show', () => {
    logger.info('[Window] ready-to-show')
    mainWindow?.showInactive()
    updateTrayMenu()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('[Window] did-finish-load')
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    logger.error(`[Window] did-fail-load code=${code} desc=${desc} url=${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Window] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      logger.warn('[Window] ready-to-show timeout, fallback showInactive')
      mainWindow.showInactive()
      updateTrayMenu()
    }
  }, 1800)

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
        else mainWindow?.showInactive()
        updateTrayMenu()
      },
    },
    {
      label: vadEnabled ? '关闭 VAD 智能模式' : '开启 VAD 智能模式',
      click: () => {
        setVadEnabledState(!vadEnabled, true)
      },
    },
    {
      label: '检查权限并引导',
      click: () => {
        void checkPermissionsAndGuide('tray-manual-check', true)
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
  // 按下热键 → 开始录音
  uIOhook.on('keydown', async (e) => {
    if (isRecording) return
    if (e.keycode !== parsed.keycode) return
    if (e.altKey !== parsed.alt) return
    if (e.ctrlKey !== parsed.ctrl) return
    if (e.shiftKey !== parsed.shift) return
    if (e.metaKey !== parsed.meta) return

    isRecording = true
    prevApp = await focusController.captureSnapshot('hotkey-keydown')
    logger.info(`[热键] 按下，开始录音，前台应用: ${prevApp ?? 'null'}`)
    mainWindow?.webContents.send('hotkey-state', 'recording')
  })

  // 松开主键 → 停止录音并识别
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

  // 注册全局快捷键，拦截系统冒泡，避免如 Alt+Space 在长按期间一直给焦点应用输入空格
  const registered = globalShortcut.register(config.hotkey.record, async () => {
    // 仅用于消费和拦截按键，如果 uiohook 丢事件则在此补偿。
    if (!isRecording) {
      isRecording = true
      prevApp = await focusController.captureSnapshot('hotkey-shortcut-fallback')
      console.log('[热键/拦截网] 捕获按下，开始录音，前台应用:', prevApp)
      mainWindow?.webContents.send('hotkey-state', 'recording')
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

  // 划词重写功能热键
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
  hotkeysRegistered = true
  logger.info('[热键] 注册流程完成')
}

// ── IPC 处理 ──

function setupIpc() {
  const config = getConfig()
  vadEnabled = Boolean(config.vad?.enabled)

  ipcMain.handle('get-config', () => getConfig())
  ipcMain.handle('get-frontmost-app', async () => {
    return focusController.captureSnapshot('ipc-get-frontmost')
  })
  ipcMain.handle('capture-focus-snapshot', async (_event, reason: string | undefined) => {
    return focusController.captureSnapshot(reason ? `ipc-capture:${reason}` : 'ipc-capture')
  })
  ipcMain.handle('restore-focus', async (_event, appId: string | null) => {
    await focusController.restore(appId, 'ipc-restore')
  })

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
      llm: cfg.llm ? { ...current.llm, ...cfg.llm } : current.llm,
    }
    saveConfig(merged)
    updateTrayMenu()
  })

  ipcMain.handle('get-vad-enabled', () => vadEnabled)

  ipcMain.handle('set-vad-enabled', (_event, enabled: boolean) => {
    return setVadEnabledState(Boolean(enabled))
  })

  // 独立的 Dashboard 设置窗体控制
  ipcMain.handle('open-dashboard', () => {
    if (dashboardWindow) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore()
      dashboardWindow.show()
      dashboardWindow.focus()
      return
    }

    dashboardWindow = new BrowserWindow({
      width: 800,
      height: 600,
      title: 'Logene Voice Input - 控制台',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      dashboardWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/dashboard`)
    } else {
      dashboardWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'dashboard' })
    }

    dashboardWindow.on('closed', () => {
      dashboardWindow = null
    })
  })

  // 渲染进程完成录音，发来 WAV ArrayBuffer，主进程负责 ASR + 输入
  ipcMain.handle('recognize-wav', async (_event, wavBuffer: ArrayBuffer, prevAppId: string | null) => {
    const reqId = ++asrRequestSeq
    const cfg = getConfig()
    const buf = Buffer.from(wavBuffer)
    const asrMode = cfg.asr?.mode ?? 'api'
    logger.info(`[ASR#${reqId}] 收到 WAV，大小 ${buf.byteLength} 字节，模式: ${asrMode}`)

    let rawText: unknown
    let localModelId = cfg.asr?.localModel ?? 'paraformer-zh-contextual-quant'
    try {
      if (asrMode === 'local') {
        // 本地模型识别
        await initLocalRecognizer(localModelId)
        rawText = await recognizeLocal(buf)
      } else {
        // 远程 API 识别
        rawText = await recognize(cfg.server.url, cfg.server.asrConfigId, buf)
      }
    } catch (e) {
      logger.error(`[ASR#${reqId}] 识别失败: ${e}`)
      throw e
    }

    const text = normalizeAsrText(rawText)
    logger.info(`[ASR#${reqId}] 识别结果: "${text}"`)
    if (!text.trim()) return ''

    const result = matchVoiceCommand(text, cfg.voiceCommands)
    const fallbackTarget = focusController.getLastExternalAppId()
    const focusTarget = prevAppId || fallbackTarget
    logger.info(`[ASR#${reqId}] focus target prev=${prevAppId ?? 'null'} lastExternal=${fallbackTarget ?? 'null'} chosen=${focusTarget ?? 'null'}`)
    await focusController.restore(focusTarget, `asr#${reqId}`)

    if (result.type === 'command') {
      logger.info(`[ASR#${reqId}] 语音指令: ${text.trim()} → ${result.shortcut}`)
      await sendShortcut(result.shortcut)
      return `${text.trim()} ⌨ ${result.shortcut}`
    } else {
      logger.info(`[ASR#${reqId}] 输入文字: ${result.text}`)
      await typeText(result.text)
      return result.text
    }
  })

  // ── 模型管理 IPC ──
  ipcMain.handle('get-model-statuses', async () => {
    const models = getModelInfoList()
    if (!Array.isArray(models) || models.length === 0) {
      logger.warn('[Model] get-model-statuses: 模型列表为空')
      return []
    }
    const results = models.map((m) => {
      const status = inspectLocalModelStatus(m)
      return { ...m, downloaded: status.downloaded, incomplete: status.incomplete, dependencies: status.dependencies }
    })
    return results
  })

  ipcMain.handle('get-model-catalog', () => {
    const models = getModelInfoList()
    return Array.isArray(models) ? models : []
  })

  ipcMain.handle('download-model', async (_event, modelId: string) => {
    logger.info(`准备模型: ${modelId}`)
    const sendProgress = (data: { progress: number; status?: string }) => {
      const msg = { modelId, percent: data.progress, status: data.status }
      mainWindow?.webContents.send('model-download-progress', msg)
      dashboardWindow?.webContents.send('model-download-progress', msg)
    }
    sendProgress({ progress: 0, status: '启动中...' })
    try {
      await initLocalRecognizer(modelId, sendProgress)
      return { success: true }
    } catch (e) {
      logger.error(`模型准备失败(modelId=${modelId}): ${e instanceof Error ? (e.stack || e.message) : String(e)}`)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('delete-model', (_event, _modelId: string) => {
    // FunASR 模型由 ModelScope 缓存管理，不再手动删除
    logger.info('FunASR 模型由 ModelScope 缓存管理，如需清理请手动删除 ~/.cache/modelscope')
  })

  // ── 日志 IPC ──
  ipcMain.handle('get-logs', () => getLogBuffer())
  ipcMain.handle('clear-logs', () => clearLogs())
  ipcMain.handle('copy-to-clipboard', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
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

app.whenReady().then(async () => {
  // 初始化日志，推送到渲染进程
  initLogger((entry) => {
    mainWindow?.webContents.send('log-entry', entry)
  })
  logger.info('应用启动')

  logger.info('[Startup] setupIpc')
  setupIpc()
  logger.info('[Startup] initRewriteWindow')
  initRewriteWindow()
  logger.info('[Startup] createWindow')
  createWindow()
  logger.info('[Startup] createTray')
  createTray()
  logger.info('[Startup] startFocusTracker')
  focusController.startTracking()
  logger.info('[Startup] checkPermissions')
  const permissionsReady = await checkPermissionsAndGuide('startup', true)
  if (permissionsReady) {
    logger.info('[Startup] registerHotkey')
    try {
      registerHotkey()
    } catch (e) {
      logger.error(String(e))
      emitPermissionWarning(`热键初始化失败：${String(e)} 请确认系统权限已授权，然后重启应用。`)
    }
  } else {
    logger.warn('[Startup] 权限未就绪，热键与焦点控制功能暂停。请授权后重启应用。')
  }
  logger.info('[Startup] ready')

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  disposeLocalRecognizer()
  focusController.stopTracking()
  try {
    uIOhook.stop()
  } catch {
    // ignore
  }
  globalShortcut.unregisterAll()
})
