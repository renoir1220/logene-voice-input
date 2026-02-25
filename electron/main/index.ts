import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  screen,
} from 'electron'
import * as path from 'path'
import { uIOhook } from 'uiohook-napi'
import { getConfig, saveConfig } from './config'
import { disposeLocalRecognizer } from './local-asr'
import { initLogger, logger } from './logger'
import { FocusController } from './focus-controller'
import { closeDb, initDb } from './db'
import { isSelfAppId } from './self-app'
import { initRewriteWindow } from './rewrite-window'
import {
  mainWindow,
  dashboardWindow,
  setMainWindow,
  setTray,
  tray,
  vadEnabled,
  setVadEnabled,
  floatPos,
  setFloatPos,
  FLOAT_WIDTH,
  FLOAT_HEIGHT,
  registerProcessErrorHooks,
  attachWebContentsDiagnostics,
} from './app-context'
import { checkPermissionsAndGuide, emitPermissionWarning } from './permissions'
import { registerHotkey } from './hotkeys'
import { setupIpc, emitAsrRuntimeStatus, ensureLocalRecognizerReady } from './ipc'

// ── 共享实例 ──

const focusController = new FocusController({
  isSelfAppId: (appId) => isSelfAppId(appId, process.platform, app),
})

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function setVadEnabledState(enabled: boolean, emitToRenderer = false): boolean {
  if (vadEnabled === enabled && !emitToRenderer) return vadEnabled
  setVadEnabled(enabled)
  const cfg = getConfig()
  cfg.vad = {
    enabled,
    speechThreshold: cfg.vad?.speechThreshold ?? 0.06,
    silenceTimeoutMs: cfg.vad?.silenceTimeoutMs ?? 800,
    minSpeechDurationMs: cfg.vad?.minSpeechDurationMs ?? 300,
  }
  saveConfig(cfg)
  if (emitToRenderer) {
    mainWindow?.webContents.send('toggle-vad', enabled)
  }
  updateTrayMenu()
  return enabled
}

function revealMainInterface(source: string) {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.showInactive()
    updateTrayMenu()
    logger.info(`[App] second-instance 激活主窗口 (${source})`)
    return
  }
  if (dashboardWindow) {
    if (dashboardWindow.isMinimized()) dashboardWindow.restore()
    dashboardWindow.show()
    dashboardWindow.focus()
    logger.info(`[App] second-instance 激活控制台窗口 (${source})`)
    return
  }
  logger.info(`[App] second-instance 到达，但主窗口尚未初始化 (${source})`)
}

// ── 窗口创建 ──

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workArea
  setFloatPos({ x: sw - FLOAT_WIDTH - 40, y: sh - FLOAT_HEIGHT - 40 })

  const win = new BrowserWindow({
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
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
      backgroundThrottling: false,
    },
  })
  setMainWindow(win)
  attachWebContentsDiagnostics(win, 'main')

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // 窗口透明，无需等 ready-to-show，立即显示避免启动延迟
  win.showInactive()
  updateTrayMenu()

  win.setFocusable(false)
  win.setAlwaysOnTop(true, 'floating', 1)
  win.once('ready-to-show', () => {
    logger.info('[Window] ready-to-show')
  })
  win.webContents.on('did-finish-load', () => {
    logger.info('[Window] did-finish-load')
    emitAsrRuntimeStatus()
  })
  win.on('closed', () => { setMainWindow(null) })
}

// ── 系统托盘 ──

function getIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png')
  }
  return path.join(__dirname, '../../build/icons/icon.png')
}

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 })
  const t = new Tray(icon)
  setTray(t)
  t.setToolTip('朗珈语音输入法')
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

// ── 应用生命周期 ──

registerProcessErrorHooks(app)

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    revealMainInterface('second-instance')
  })
}

// Windows 渲染性能优化：
// 1. 禁用代理自动检测，避免加载 localhost 时 10-30 秒的代理探测延迟
// 2. 禁用 CalculateNativeWinOcclusion，避免 focusable:false 窗口被节流
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    const t0 = Date.now()
    const ts = () => `+${Date.now() - t0}ms`

    initLogger((entry) => {
      mainWindow?.webContents.send('log-entry', entry)
      dashboardWindow?.webContents.send('log-entry', entry)
    })
    logger.info('应用启动')

    logger.info(`[Startup] initDb ${ts()}`)
    await initDb()

    logger.info(`[Startup] setupIpc ${ts()}`)
    const config = getConfig()
    setVadEnabled(Boolean(config.vad?.enabled))
    setupIpc(focusController, setVadEnabledState, updateTrayMenu)

    logger.info(`[Startup] initRewriteWindow ${ts()}`)
    initRewriteWindow()
    logger.info(`[Startup] createWindow ${ts()}`)
    createWindow()
    logger.info(`[Startup] createTray ${ts()}`)
    createTray()
    logger.info(`[Startup] startFocusTracker ${ts()}`)
    focusController.startTracking()
    logger.info(`[Startup] checkPermissions ${ts()}`)
    const permissionsReady = await checkPermissionsAndGuide('startup', true)
    logger.info(`[Startup] checkPermissions done ${ts()}`)
    if (permissionsReady) {
      logger.info(`[Startup] registerHotkey ${ts()}`)
      try {
        registerHotkey(focusController, setVadEnabledState)
      } catch (e) {
        logger.error(String(e))
        emitPermissionWarning(`热键初始化失败：${String(e)} 请确认系统权限已授权，然后重启应用。`)
      }
    } else {
      logger.warn('[Startup] 权限未就绪，热键与焦点控制功能暂停。请授权后重启应用。')
    }
    logger.info(`[Startup] ready ${ts()}`)

    // 提前 spawn sidecar 进程（不等模型加载），与渲染进程并行预热
    if ((getConfig().asr?.mode ?? 'api') === 'local') {
      void ensureLocalRecognizerReady('startup').catch(() => { })
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    closeDb()
    disposeLocalRecognizer()
    focusController.stopTracking()
    try {
      uIOhook.stop()
    } catch {
      // ignore
    }
    globalShortcut.unregisterAll()
  })
}
