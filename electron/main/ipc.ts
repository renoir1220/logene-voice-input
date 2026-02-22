import { ipcMain, clipboard, BrowserWindow, IpcMainInvokeEvent, app, Menu } from 'electron'
import * as path from 'path'
import { getConfig, saveConfig, AppConfig } from './config'
import { recognize } from './asr'
import { recognizeLocal, initLocalRecognizer, disposeLocalRecognizer } from './local-asr'
import { getModelInfoList, inspectLocalModelStatus, deleteModelCache } from './model-manager'
import { logger, getLogBuffer, clearLogs } from './logger'
import { matchVoiceCommand } from './voice-commands'
import { typeText, sendShortcut } from './input-sim'
import { normalizeAsrText, applyTextRules } from './asr-text'
import { optimizeAsrTextWithLlm, generateDailySummary } from './llm-service'
import { FocusController } from './focus-controller'
import { insertRecognition, getStats, getRecentHistory, getAllHistory, getRecordsByDate } from './db'
import {
  mainWindow,
  dashboardWindow,
  setDashboardWindow,
  vadEnabled,
  floatPos,
  setFloatPos,
  FLOAT_WIDTH,
  DEFAULT_LOCAL_MODEL_ID,
  stringifyErrorLike,
  attachWebContentsDiagnostics,
} from './app-context'

type AsrRuntimePhase = 'idle' | 'starting' | 'ready' | 'error'
interface AsrRuntimeStatus {
  phase: AsrRuntimePhase
  modelId: string | null
  progress: number
  message: string
  updatedAt: string
}

let asrRuntimeStatus: AsrRuntimeStatus = {
  phase: 'idle',
  modelId: null,
  progress: 0,
  message: '',
  updatedAt: new Date().toISOString(),
}
let asrRequestSeq = 0
let localAsrInitPromise: Promise<void> | null = null
let localAsrInitModelId: string | null = null

export function emitAsrRuntimeStatus() {
  mainWindow?.webContents.send('asr-runtime-status', asrRuntimeStatus)
  dashboardWindow?.webContents.send('asr-runtime-status', asrRuntimeStatus)
}

function setAsrRuntimeStatus(next: Partial<AsrRuntimeStatus>) {
  asrRuntimeStatus = {
    ...asrRuntimeStatus,
    ...next,
    updatedAt: new Date().toISOString(),
  }
  emitAsrRuntimeStatus()
}

export async function ensureLocalRecognizerReady(reason: string): Promise<void> {
  const cfg = getConfig()
  const mode = cfg.asr?.mode ?? 'api'
  if (mode !== 'local') {
    setAsrRuntimeStatus({
      phase: 'idle',
      modelId: null,
      progress: 0,
      message: '当前为远程识别模式',
    })
    return
  }

  const modelId = cfg.asr?.localModel || DEFAULT_LOCAL_MODEL_ID
  if (asrRuntimeStatus.phase === 'ready' && asrRuntimeStatus.modelId === modelId && !localAsrInitPromise) {
    return
  }

  if (localAsrInitPromise) {
    if (localAsrInitModelId === modelId) {
      await localAsrInitPromise
      return
    }
    try {
      await localAsrInitPromise
    } catch {
      // ignore previous init failure
    }
  }

  localAsrInitModelId = modelId
  setAsrRuntimeStatus({
    phase: 'starting',
    modelId,
    progress: 0,
    message: '正在启动本地识别...',
  })

  localAsrInitPromise = initLocalRecognizer(modelId, (data) => {
    const progress = typeof data.progress === 'number'
      ? Math.max(0, Math.min(100, Math.round(data.progress)))
      : asrRuntimeStatus.progress
    const status = typeof data.status === 'string' && data.status.trim()
      ? data.status.trim()
      : `正在启动本地识别${progress > 0 ? ` (${progress}%)` : '...'}`
    setAsrRuntimeStatus({
      phase: 'starting',
      modelId,
      progress,
      message: status,
    })
  })
    .then(() => {
      setAsrRuntimeStatus({
        phase: 'ready',
        modelId,
        progress: 100,
        message: '本地识别已就绪',
      })
      logger.info(`[ASR] 本地识别已就绪(model=${modelId}, reason=${reason})`)
    })
    .catch((e) => {
      const detail = e instanceof Error ? e.message : String(e)
      setAsrRuntimeStatus({
        phase: 'error',
        modelId,
        progress: 0,
        message: detail,
      })
      logger.error(`[ASR] 本地识别启动失败(model=${modelId}, reason=${reason}): ${detail}`)
      throw e
    })
    .finally(() => {
      localAsrInitPromise = null
      localAsrInitModelId = null
    })

  await localAsrInitPromise
}

export function setupIpc(
  focusController: FocusController,
  setVadEnabledState: (enabled: boolean, emit?: boolean) => boolean,
  updateTrayMenu: () => void,
) {
  const config = getConfig()
  // vadEnabled is set externally via app-context

  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>,
  ) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args)
      } catch (e) {
        logger.error(`[IPC:${channel}] ${stringifyErrorLike(e)}`)
        throw e
      }
    })
  }

  handle('get-config', () => getConfig())
  handle('get-frontmost-app', async () => {
    return focusController.captureSnapshot('ipc-get-frontmost')
  })
  handle('capture-focus-snapshot', async (_event, reason: string | undefined) => {
    return focusController.captureSnapshot(reason ? `ipc-capture:${reason}` : 'ipc-capture')
  })
  handle('restore-focus', async (_event, appId: string | null) => {
    await focusController.restore(appId, 'ipc-restore')
  })

  handle('save-config', (_event, cfg: AppConfig) => {
    const current = getConfig()
    const merged: AppConfig = {
      ...current,
      ...cfg,
      server: { ...current.server, ...cfg.server },
      hotkey: { ...current.hotkey, ...cfg.hotkey },
      input: { ...current.input, ...cfg.input },
      audioCapture: {
        ...current.audioCapture,
        ...cfg.audioCapture,
        inputConstraints: {
          ...current.audioCapture.inputConstraints,
          ...(cfg.audioCapture?.inputConstraints ?? {}),
        },
      },
      vad: { ...current.vad, ...cfg.vad, enabled: vadEnabled },
      voiceCommands: cfg.voiceCommands ?? current.voiceCommands,
      hotwords: cfg.hotwords ?? current.hotwords,
      textRules: cfg.textRules ? {
        ...current.textRules,
        ...cfg.textRules,
        rules: Array.isArray(cfg.textRules.rules) ? cfg.textRules.rules : current.textRules.rules,
      } : current.textRules,
      asr: { ...current.asr, ...cfg.asr },
      onboarding: cfg.onboarding
        ? { ...current.onboarding, ...cfg.onboarding }
        : current.onboarding,
      logging: { ...current.logging, ...cfg.logging },
      llm: cfg.llm ? {
        ...current.llm,
        ...cfg.llm,
        models: cfg.llm.models ?? current.llm.models,
        taskBindings: {
          ...current.llm.taskBindings,
          ...(cfg.llm.taskBindings ?? {}),
        },
        prompts: {
          ...current.llm.prompts,
          ...(cfg.llm.prompts ?? {}),
          rewrite: {
            ...current.llm.prompts.rewrite,
            ...(cfg.llm.prompts?.rewrite ?? {}),
          },
          asrPostProcess: {
            ...current.llm.prompts.asrPostProcess,
            ...(cfg.llm.prompts?.asrPostProcess ?? {}),
          },
          dailySummary: {
            ...current.llm.prompts.dailySummary,
            ...(cfg.llm.prompts?.dailySummary ?? {}),
          },
        },
      } : current.llm,
    }
    saveConfig(merged)
    updateTrayMenu()
    if ((merged.asr?.mode ?? 'api') === 'local') {
      void ensureLocalRecognizerReady('config-save').catch(() => { })
    } else {
      setAsrRuntimeStatus({
        phase: 'idle',
        modelId: null,
        progress: 0,
        message: '当前为远程识别模式',
      })
    }
  })

  handle('get-vad-enabled', () => vadEnabled)
  handle('set-vad-enabled', (_event, enabled: boolean) => {
    return setVadEnabledState(Boolean(enabled))
  })

  handle('get-asr-runtime-status', () => asrRuntimeStatus)

  handle('report-renderer-error', (_event, payload: unknown) => {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const kind = typeof data.kind === 'string' ? data.kind : 'unknown'
    const message = typeof data.message === 'string' ? data.message : ''
    const source = typeof data.source === 'string' ? data.source : ''
    const line = typeof data.lineno === 'number' ? data.lineno : 0
    const col = typeof data.colno === 'number' ? data.colno : 0
    const reason = typeof data.reason === 'string' ? data.reason : ''
    const stack = typeof data.stack === 'string' ? data.stack : ''

    logger.error(
      `[Renderer] kind=${kind} message=${message || 'unknown'} ` +
      `source=${source || 'unknown'} line=${line} col=${col} reason=${reason || ''}`.trim(),
    )
    if (stack) {
      logger.error(`[Renderer] stack: ${stack}`)
    }
    return true
  })

  function openDashboardWindow() {
    if (dashboardWindow) {
      if (dashboardWindow.isMinimized()) dashboardWindow.restore()
      dashboardWindow.show()
      dashboardWindow.focus()
      return
    }

    const win = new BrowserWindow({
      width: 800,
      height: 600,
      minWidth: 640,
      minHeight: 480,
      title: '朗珈语音输入法 - 控制台',
      icon: app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(__dirname, '../../build/icons/icon.png'),
      titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 14 } }
        : { titleBarOverlay: { color: '#f1f5f9', symbolColor: '#64748b', height: 36 } }),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    setDashboardWindow(win)
    attachWebContentsDiagnostics(win, 'dashboard')

    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/dashboard`)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'dashboard' })
    }
    win.webContents.on('did-finish-load', () => {
      emitAsrRuntimeStatus()
    })

    win.on('closed', () => {
      setDashboardWindow(null)
    })
  }

  handle('show-float-context-menu', () => {
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
      { type: 'separator' },
      { label: '打开控制台', click: () => { openDashboardWindow() } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
    if (mainWindow) menu.popup({ window: mainWindow })
  })

  handle('open-dashboard', () => openDashboardWindow())

  handle('restart-app', () => {
    logger.info('[App] 收到重启请求')
    app.relaunch()
    app.exit(0)
    return true
  })

  handle('recognize-wav', async (_event, wavBuffer: ArrayBuffer, prevAppId: string | null) => {
    const reqId = ++asrRequestSeq
    const cfg = getConfig()
    const buf = Buffer.from(wavBuffer)
    const asrMode = cfg.asr?.mode ?? 'api'
    logger.info(`[ASR#${reqId}] 收到 WAV，大小 ${buf.byteLength} 字节，模式: ${asrMode}`)

    // 音频过短（< 0.5s）时跳过识别，避免模型对静音产生幻觉输出
    // 16kHz 16-bit mono: 32000 字节/秒，0.5s = 16000 字节 + 44 字节 WAV 头
    const MIN_WAV_BYTES = 16044
    if (buf.byteLength < MIN_WAV_BYTES) {
      logger.info(`[ASR#${reqId}] WAV 过短 (${buf.byteLength} < ${MIN_WAV_BYTES})，跳过识别`)
      return ''
    }

    // 检测音频能量，静音或极低能量时跳过识别（避免模型幻觉）
    const pcmData = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.byteLength - 44) / 2)
    let sumSq = 0
    for (let i = 0; i < pcmData.length; i++) sumSq += pcmData[i] * pcmData[i]
    const rms = Math.sqrt(sumSq / pcmData.length)
    const SILENCE_RMS_THRESHOLD = 80  // 16-bit PCM，低于此值视为静音
    if (rms < SILENCE_RMS_THRESHOLD) {
      logger.info(`[ASR#${reqId}] 音频能量过低 (rms=${rms.toFixed(1)} < ${SILENCE_RMS_THRESHOLD})，跳过识别`)
      return ''
    }

    let rawText: unknown
    try {
      if (asrMode === 'local') {
        await ensureLocalRecognizerReady(`recognize#${reqId}`)
        rawText = await recognizeLocal(buf)
      } else {
        rawText = await recognize(cfg.server.url, cfg.server.asrConfigId, buf)
      }
    } catch (e) {
      logger.error(`[ASR#${reqId}] 识别失败: ${e}`)
      throw e
    }

    const normalizedText = normalizeAsrText(rawText)
    const text = applyTextRules(normalizedText, cfg.textRules)
    logger.info(`[ASR#${reqId}] 识别结果: "${text}"`)
    if (!text.trim()) return ''

    const result = matchVoiceCommand(text, cfg.voiceCommands)
    const fallbackTarget = focusController.getLastExternalAppId()
    const focusTarget = prevAppId || fallbackTarget
    // Windows 上 isSelfAppId 始终返回 false，跳过 PowerShell 调用直接尝试还原焦点
    const selfFrontmost = process.platform !== 'win32'
      ? await focusController.isSelfAppFrontmost(`asr#${reqId}`)
      : false
    if (selfFrontmost) {
      logger.debug(
        `[ASR#${reqId}] skip restore because self app is frontmost prev=${prevAppId ?? 'null'} lastExternal=${fallbackTarget ?? 'null'}`,
      )
    } else {
      logger.debug(
        `[ASR#${reqId}] focus target prev=${prevAppId ?? 'null'} lastExternal=${fallbackTarget ?? 'null'} chosen=${focusTarget ?? 'null'}`,
      )
      await focusController.restore(focusTarget, `asr#${reqId}`)
    }

    if (result.type === 'command') {
      logger.info(`[ASR#${reqId}] 语音指令: ${text.trim()} → ${result.shortcut}`)
      await sendShortcut(result.shortcut)
      try {
        insertRecognition({ text: text.trim(), mode: asrMode, isCommand: true, commandShortcut: result.shortcut })
        dashboardWindow?.webContents.send('recognition-added')
      } catch (e) {
        logger.error(`[ASR#${reqId}] 写入识别记录失败: ${e}`)
      }
      return `${text.trim()} ⌨ ${result.shortcut}`
    } else {
      let outputText = result.text
      const llmCfg = cfg.llm
      const shouldOptimizeByLlm = !Boolean(cfg.vad?.enabled)
        && outputText.trim().length > 8
        && Boolean(llmCfg?.enabled)
        && Boolean(llmCfg?.asrPostProcessEnabled)
        && Array.isArray(llmCfg?.models)
        && llmCfg.models.length > 0

      if (shouldOptimizeByLlm) {
        try {
          const optimized = (await optimizeAsrTextWithLlm(outputText)).trim()
          if (optimized) {
            logger.info(`[ASR#${reqId}] LLM 后处理: "${outputText}" -> "${optimized}"`)
            outputText = optimized
          }
        } catch (e) {
          logger.warn(`[ASR#${reqId}] LLM 后处理失败，回退原识别文本: ${String(e)}`)
        }
      }

      logger.info(`[ASR#${reqId}] 输入文字: ${outputText}`)
      await typeText(outputText)
      try {
        insertRecognition({ text: outputText, mode: asrMode, isCommand: false })
        dashboardWindow?.webContents.send('recognition-added')
      } catch (e) {
        logger.error(`[ASR#${reqId}] 写入识别记录失败: ${e}`)
      }
      return outputText
    }
  })

  // ── 统计与历史 IPC ──
  handle('get-stats', async () => getStats())
  handle('get-recent-history', async (_event, limit?: number) => getRecentHistory(limit))
  handle('get-all-history', async (_event, offset?: number, limit?: number) => getAllHistory(offset, limit))
  handle('generate-daily-summary', async (_event, date: string) => {
    const records = getRecordsByDate(date)
    return generateDailySummary(records)
  })

  // ── 模型管理 IPC ──
  handle('get-model-statuses', async () => {
    const startedAt = Date.now()
    try {
      const models = getModelInfoList()
      if (!Array.isArray(models) || models.length === 0) {
        logger.warn('[Model] get-model-statuses: 模型列表为空')
        return []
      }
      const results = models.map((m) => {
        const status = inspectLocalModelStatus(m)
        return { ...m, downloaded: status.downloaded, incomplete: status.incomplete, dependencies: status.dependencies }
      })
      logger.debug(`[Model] get-model-statuses done: count=${results.length}, cost=${Date.now() - startedAt}ms`)
      return results
    } catch (e) {
      logger.error(`[Model] get-model-statuses failed: ${e instanceof Error ? (e.stack || e.message) : String(e)}`)
      throw e
    }
  })

  handle('get-model-catalog', () => {
    const startedAt = Date.now()
    const models = getModelInfoList()
    const result = Array.isArray(models) ? models : []
    logger.debug(`[Model] get-model-catalog done: count=${result.length}, cost=${Date.now() - startedAt}ms`)
    return result
  })

  handle('download-model', async (_event, modelId: string) => {
    logger.info(`准备模型: ${modelId}`)
    const sendProgress = (data: { progress: number; status?: string }) => {
      const msg = { modelId, percent: data.progress, status: data.status }
      mainWindow?.webContents.send('model-download-progress', msg)
      dashboardWindow?.webContents.send('model-download-progress', msg)
    }
    sendProgress({ progress: 0, status: '启动中...' })
    try {
      await initLocalRecognizer(modelId, sendProgress)
      const cfg = getConfig()
      if ((cfg.asr?.mode ?? 'api') === 'local' && (cfg.asr?.localModel ?? DEFAULT_LOCAL_MODEL_ID) === modelId) {
        setAsrRuntimeStatus({
          phase: 'ready',
          modelId,
          progress: 100,
          message: '本地识别已就绪',
        })
      }
      return { success: true }
    } catch (e) {
      logger.error(`模型准备失败(modelId=${modelId}): ${e instanceof Error ? (e.stack || e.message) : String(e)}`)
      return { success: false, error: String(e) }
    }
  })

  handle('delete-model', (_event, modelId: string) => {
    logger.info(`[Model] 删除模型: ${modelId}`)
    try {
      deleteModelCache(modelId)
      disposeLocalRecognizer()
      setAsrRuntimeStatus({ phase: 'idle', modelId: null, progress: 0, message: '模型已删除' })
    } catch (e) {
      logger.error(`[Model] 删除失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  // ── 日志 IPC ──
  handle('get-logs', () => getLogBuffer())
  handle('clear-logs', () => clearLogs())
  handle('copy-to-clipboard', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  handle('get-window-position', () => mainWindow?.getPosition() || [0, 0])
  handle('set-window-position', (_event, x: number, y: number) => {
    if (mainWindow) {
      mainWindow.setPosition(Math.round(x), Math.round(y), false)
      if (mainWindow.getSize()[0] === FLOAT_WIDTH) {
        setFloatPos({ x: Math.round(x), y: Math.round(y) })
      }
    }
  })
}
