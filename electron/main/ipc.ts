import { ipcMain, clipboard, BrowserWindow, IpcMainInvokeEvent, app, Menu, screen } from 'electron'
import * as path from 'path'
import { getConfig, saveConfig, AppConfig } from './config'
import { recognize } from './asr'
import { recognizeLocal, initLocalRecognizer, disposeLocalRecognizer } from './local-asr'
import { getModelInfoList, inspectLocalModelStatus, deleteModelCache } from './model-manager'
import { logger, getLogBuffer, clearLogs } from './logger'
import { matchVoiceCommand } from './voice-commands'
import { typeText, sendShortcut, probePasteTarget, refinePasteTargetProbe } from './input-sim'
import { normalizeAsrText, applyTextRules } from './asr-text'
import { optimizeAsrTextWithLlm, generateDailySummary } from './llm-service'
import { FocusController } from './focus-controller'
import { checkPermissionsAndGuide } from './permissions'
import { insertRecognition, getStats, getRecentHistory, getAllHistory, getRecordsByDate } from './db'
import {
  mainWindow,
  dashboardWindow,
  setDashboardWindow,
  vadEnabled,
  floatPos,
  setFloatPos,
  FLOAT_WIDTH,
  FLOAT_HEIGHT,
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

interface FloatPasteFallbackPayload {
  requestId: number
  text: string
  targetAppId: string | null
  reason: 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret' | 'type-failed'
  precheckReason: 'ok' | 'unknown' | 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret'
}

interface FloatLayoutMetrics {
  width: number
  height: number
  anchorX: number
  anchorY: number
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

const VAD_THRESHOLD_MIN = 0.01
const VAD_THRESHOLD_MAX = 0.2

function clampVadThreshold(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : VAD_THRESHOLD_MIN
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, value))
}

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
  let floatExpanded = false
  let floatLayout: FloatLayoutMetrics = {
    width: FLOAT_WIDTH,
    height: FLOAT_HEIGHT,
    anchorX: 0,
    anchorY: 0,
  }
  // vadEnabled is set externally via app-context

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isHardNoFocusReason = (reason: 'ok' | 'unknown' | 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret') => (
    reason === 'no-foreground-window' || reason === 'no-focused-control'
  )
  const readPasteTargetProbe = async () => {
    const baseProbe = probePasteTarget()
    return refinePasteTargetProbe(baseProbe)
  }
  const hasRefineError = (probe: { refineOutcome?: 'writable' | 'non-writable' | 'error' }) => (
    probe.refineOutcome === 'error'
  )
  // 探测策略：
  // - 明确无焦点/不可写时不重试，直接返回，避免无意义等待拉长识别路径。
  // - 仅在 UIA 复核异常时做少量重试，吸收瞬时系统抖动。
  const probePasteTargetStable = async (stage: 'before' | 'after') => {
    let last = await readPasteTargetProbe()
    for (let i = 2; i <= 3; i += 1) {
      if (last.ok) return last
      if (isHardNoFocusReason(last.reason)) return last
      if (!hasRefineError(last)) return last
      await sleep(stage === 'before' ? 25 : 20)
      last = await readPasteTargetProbe()
    }
    return last
  }

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

  function normalizeFloatLayout(layout: FloatLayoutMetrics): FloatLayoutMetrics {
    const width = Math.max(FLOAT_WIDTH, Math.round(layout.width || 0))
    const height = Math.max(FLOAT_HEIGHT, Math.round(layout.height || 0))
    const anchorX = Math.max(0, Math.min(width - 1, Math.round(layout.anchorX || 0)))
    const anchorY = Math.max(0, Math.min(height - 1, Math.round(layout.anchorY || 0)))
    return { width, height, anchorX, anchorY }
  }

  function applyFloatLayout(layout: FloatLayoutMetrics, reason = 'unknown') {
    const win = mainWindow
    if (!win || win.isDestroyed()) {
      logger.warn(`[Float] layout skipped reason=${reason} win-unavailable`)
      return
    }

    const nextLayout = normalizeFloatLayout(layout)
    const oldBounds = win.getBounds()
    const anchorScreenX = oldBounds.x + floatLayout.anchorX
    const anchorScreenY = oldBounds.y + floatLayout.anchorY
    let nextX = anchorScreenX - nextLayout.anchorX
    let nextY = anchorScreenY - nextLayout.anchorY

    const display = screen.getDisplayMatching(oldBounds)
    const area = display.workArea
    nextX = Math.max(area.x, Math.min(nextX, area.x + area.width - nextLayout.width))
    nextY = Math.max(area.y, Math.min(nextY, area.y + area.height - nextLayout.height))

    const roundedBounds = {
      x: Math.round(nextX),
      y: Math.round(nextY),
      width: nextLayout.width,
      height: nextLayout.height,
    }
    const changed = roundedBounds.x !== oldBounds.x
      || roundedBounds.y !== oldBounds.y
      || roundedBounds.width !== oldBounds.width
      || roundedBounds.height !== oldBounds.height
    if (changed) {
      win.setBounds(roundedBounds, false)
    }
    const newBounds = win.getBounds()

    if (process.platform === 'win32') {
      win.setAlwaysOnTop(true, 'screen-saver', 1)
      win.moveTop()
    } else {
      win.setAlwaysOnTop(true, 'floating', 1)
    }
    floatLayout = nextLayout
    setFloatPos({
      x: newBounds.x + nextLayout.anchorX,
      y: newBounds.y + nextLayout.anchorY,
    })
    const scaleFactor = display.scaleFactor
    logger.info(
      `[Float] layout reason=${reason} expanded=${floatExpanded} ` +
      `old=(${oldBounds.x},${oldBounds.y},${oldBounds.width},${oldBounds.height}) ` +
      `new=(${newBounds.x},${newBounds.y},${newBounds.width},${newBounds.height}) ` +
      `anchor=(${nextLayout.anchorX},${nextLayout.anchorY}) ` +
      `workArea=(${area.x},${area.y},${area.width},${area.height}) scale=${scaleFactor}`,
    )
  }

  function emitFloatPasteFallback(payload: FloatPasteFallbackPayload) {
    logger.warn(
      `[FloatFallback] emit req=${payload.requestId} reason=${payload.reason} ` +
      `precheck=${payload.precheckReason} target=${payload.targetAppId ?? 'null'} textLen=${payload.text.length}`,
    )
    floatExpanded = true
    mainWindow?.webContents.send('float-paste-fallback', payload)
  }

  handle('get-config', () => getConfig())
  handle('get-app-version', () => app.getVersion())
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
    const syncedVadThreshold = clampVadThreshold(merged.vad?.speechThreshold)
    mainWindow?.webContents.send('vad-threshold-updated', syncedVadThreshold)
    dashboardWindow?.webContents.send('vad-threshold-updated', syncedVadThreshold)
    mainWindow?.webContents.send('float-debug-bounds-updated', Boolean(merged.logging?.showFloatBounds))
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

  handle('check-mic-permission', async () => {
    return checkPermissionsAndGuide('麦克风访问失败', true)
  })

  handle('get-vad-enabled', () => vadEnabled)
  handle('set-vad-enabled', (_event, enabled: boolean) => {
    return setVadEnabledState(Boolean(enabled))
  })
  handle('set-vad-threshold', (_event, threshold: number) => {
    const normalizedThreshold = clampVadThreshold(threshold)
    const cfg = getConfig()
    cfg.vad = {
      ...cfg.vad,
      speechThreshold: normalizedThreshold,
    }
    saveConfig(cfg)
    mainWindow?.webContents.send('vad-threshold-updated', normalizedThreshold)
    dashboardWindow?.webContents.send('vad-threshold-updated', normalizedThreshold)
    return normalizedThreshold
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

    const isMac = process.platform === 'darwin'
    const isWin = process.platform === 'win32'
    const win = new BrowserWindow({
      width: 1120,
      height: 720,
      minWidth: 940,
      minHeight: 620,
      title: '朗珈语音输入法 - 控制台',
      icon: app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(__dirname, '../../build/icons/icon.png'),
      frame: !isWin,
      ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } } : {}),
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
  handle('close-dashboard', () => {
    dashboardWindow?.close()
  })

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

    const wavPayloadBytes = Math.max(0, buf.byteLength - 44)
    const pcmSampleCount = Math.floor(wavPayloadBytes / 2)
    const audioDurationMs = Math.round((pcmSampleCount / 16000) * 1000)
    if (pcmSampleCount <= 0) {
      logger.info(`[ASR#${reqId}] WAV 无有效 PCM 数据，跳过识别`)
      return ''
    }
    if (audioDurationMs < 90) {
      logger.info(`[ASR#${reqId}] 音频时长过短 (${audioDurationMs}ms < 90ms)，跳过识别`)
      return ''
    }

    // 检测音频能量，静音或极低活跃度时跳过识别（避免模型幻觉）
    const pcmData = new Int16Array(buf.buffer, buf.byteOffset + 44, pcmSampleCount)
    let sumSq = 0
    let activeSamples = 0
    const ACTIVE_SAMPLE_ABS_THRESHOLD = 220
    for (let i = 0; i < pcmData.length; i++) {
      const sample = pcmData[i]
      const abs = Math.abs(sample)
      if (abs >= ACTIVE_SAMPLE_ABS_THRESHOLD) activeSamples += 1
      sumSq += sample * sample
    }
    const rms = Math.sqrt(sumSq / pcmData.length)
    const activeRatio = activeSamples / pcmData.length
    const SILENCE_RMS_THRESHOLD = 75
    const MIN_ACTIVE_SAMPLE_RATIO = 0.008
    if (rms < SILENCE_RMS_THRESHOLD && activeRatio < MIN_ACTIVE_SAMPLE_RATIO) {
      logger.info(
        `[ASR#${reqId}] 音频活跃度过低 (durationMs=${audioDurationMs}, rms=${rms.toFixed(1)}, ` +
        `activeRatio=${activeRatio.toFixed(4)}), 跳过识别`,
      )
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
    let focusTarget = prevAppId || fallbackTarget
    if (!focusTarget) {
      focusTarget = await focusController.captureSnapshot(`asr#${reqId}-pre-restore`)
    }
    await focusController.restore(focusTarget, `asr#${reqId}`)

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

      const pasteTarget = focusTarget || focusController.getLastExternalAppId()
      const probeBefore = await probePasteTargetStable('before')
      logger.info(
        `[ASR#${reqId}] 输入文字: ${outputText} (precheck=${probeBefore.reason}, target=${pasteTarget ?? 'null'})`,
      )
      try {
        await typeText(outputText)
        logger.info(`[ASR#${reqId}] 粘贴动作已发送（未抛错）`)
        const probeAfter = await probePasteTargetStable('after')
        // 仅在“前后都明确不可写/无焦点”时才判定为静默失败。
        // focused-control-without-caret 属于歧义态，已由 UIA 复核，但仍不作为直接失败信号。
        const likelySilentFailure = !probeBefore.ok && !probeAfter.ok
          && isHardNoFocusReason(probeBefore.reason)
          && isHardNoFocusReason(probeAfter.reason)
        if (likelySilentFailure) {
          logger.warn(
            `[ASR#${reqId}] 粘贴已发送但前后均无可写焦点，触发浮球回显 before=${probeBefore.reason} after=${probeAfter.reason}`,
          )
          emitFloatPasteFallback({
            requestId: reqId,
            text: outputText,
            targetAppId: pasteTarget,
            reason: probeAfter.reason,
            precheckReason: probeBefore.reason,
          })
        } else if (!probeBefore.ok || !probeAfter.ok) {
          logger.warn(
            `[ASR#${reqId}] 探测存在歧义，先不弹回显 before=${probeBefore.reason} after=${probeAfter.reason}`,
          )
        }
      } catch (e) {
        logger.warn(`[ASR#${reqId}] 直接粘贴失败，转浮球回显: ${String(e)}`)
        emitFloatPasteFallback({
          requestId: reqId,
          text: outputText,
          targetAppId: pasteTarget,
          reason: 'type-failed',
          precheckReason: probeBefore.reason,
        })
      }
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
      const nextX = Math.round(x)
      const nextY = Math.round(y)
      mainWindow.setPosition(nextX, nextY, false)
      setFloatPos({
        x: nextX + floatLayout.anchorX,
        y: nextY + floatLayout.anchorY,
      })
    }
  })

  handle('set-float-expanded', (_event, expanded: boolean) => {
    floatExpanded = Boolean(expanded)
  })

  handle('sync-float-layout', (_event, layout: FloatLayoutMetrics) => {
    applyFloatLayout(layout, 'renderer-layout')
  })

  handle('retry-float-paste', async (_event, text: string, targetAppId: string | null) => {
    const output = String(text ?? '')
    if (!output.trim()) {
      return { success: false, reason: 'empty-text' }
    }
    const fallbackTarget = focusController.getLastExternalAppId()
    const focusTarget = targetAppId || fallbackTarget
    await focusController.restore(focusTarget, 'float-retry')
    const probe = await refinePasteTargetProbe(probePasteTarget())
    if (!probe.ok) {
      return { success: false, reason: probe.reason }
    }
    try {
      await typeText(output)
      return { success: true, reason: 'ok' }
    } catch (e) {
      logger.warn(`[Float] retry paste failed: ${String(e)}`)
      return { success: false, reason: 'type-failed' }
    }
  })

  handle('set-ignore-mouse-events', (_event, ignore: boolean, opts?: { forward: boolean }) => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(ignore, opts)
    }
  })
}
