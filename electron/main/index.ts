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

function setVadEnabledState(enabled: boolean, emitToRenderer = false): boolean {
  if (vadEnabled === enabled && !emitToRenderer) return vadEnabled
  setVadEnabled(enabled)
  const cfg = getConfig()
  cfg.vad = {
    enabled,
    speechThreshold: cfg.vad?.speechThreshold ?? 0.03,
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
    },
  })
  setMainWindow(win)
  attachWebContentsDiagnostics(win, 'main')

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.setFocusable(false)
  win.setAlwaysOnTop(true, 'floating', 1)
  win.once('ready-to-show', () => {
    logger.info('[Window] ready-to-show')
    mainWindow?.showInactive()
    updateTrayMenu()
  })
  win.webContents.on('did-finish-load', () => {
    logger.info('[Window] did-finish-load')
    emitAsrRuntimeStatus()
  })
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      logger.warn('[Window] ready-to-show timeout, fallback showInactive')
      mainWindow.showInactive()
      updateTrayMenu()
    }
  }, 1800)

  win.on('closed', () => { setMainWindow(null) })
}

// ── 系统托盘 ──

function createTray() {
  const icon = nativeImage.createEmpty()
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

app.whenReady().then(async () => {
  initLogger((entry) => {
    mainWindow?.webContents.send('log-entry', entry)
  })
  logger.info('应用启动')

  logger.info('[Startup] initDb')
  await initDb()

  logger.info('[Startup] setupIpc')
  const config = getConfig()
  setVadEnabled(Boolean(config.vad?.enabled))
  setupIpc(focusController, setVadEnabledState, updateTrayMenu)

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
      registerHotkey(focusController, setVadEnabledState)
    } catch (e) {
      logger.error(String(e))
      emitPermissionWarning(`热键初始化失败：${String(e)} 请确认系统权限已授权，然后重启应用。`)
    }
  } else {
    logger.warn('[Startup] 权限未就绪，热键与焦点控制功能暂停。请授权后重启应用。')
  }
  logger.info('[Startup] ready')

  if ((getConfig().asr?.mode ?? 'api') === 'local') {
    void ensureLocalRecognizerReady('startup').catch(() => { })
  } else {
    // emit idle status for remote mode
    emitAsrRuntimeStatus()
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
