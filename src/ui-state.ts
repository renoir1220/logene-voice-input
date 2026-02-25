import type { RecordState, AsrRuntimeStatus, AppConfig } from './types'
import { startCapture, stopCapture, startVad, stopVad, resetVadSpeakingState, setAudioCaptureConfig, VadState, VadCallbacks } from './audio'

// ── 共享 UI 状态 ──

let state: RecordState = 'idle'
export let recordBtn: HTMLButtonElement
export let vadToggleBtn: HTMLButtonElement | null = null
export let statusText: HTMLSpanElement | null = null
export let vadIndicator: HTMLSpanElement | null = null
export let dashboardVadToggle: HTMLInputElement | null = null
export let errorBar: HTMLDivElement | null = null
let errorTimer: ReturnType<typeof setTimeout> | null = null
let successFlashTimer: ReturnType<typeof setTimeout> | null = null
const SUCCESS_FLASH_MS = 180

let startCapturePromise: Promise<void> | null = null
let focusSnapshotAppId: string | null = null

const VAD_THRESHOLD_MIN = 0.01
const VAD_THRESHOLD_MAX = 0.2
const VAD_DEFAULT_THRESHOLD = 0.06

let asrRuntimeStatus: AsrRuntimeStatus = {
  phase: 'idle',
  modelId: null,
  progress: 0,
  message: '',
  updatedAt: '',
}
let lastAsrRuntimeError = ''

export let vadState: VadState = { enabled: false, threshold: VAD_DEFAULT_THRESHOLD, silenceMs: 800, minSpeechMs: 300 }
let vadSyncVersion = 0

export function getState(): RecordState { return state }
export function getStartCapturePromise() { return startCapturePromise }
export function setStartCapturePromise(p: Promise<void> | null) { startCapturePromise = p }
export function getFocusSnapshotAppId() { return focusSnapshotAppId }

export function initFloatElements() {
  recordBtn = document.getElementById('record-btn') as HTMLButtonElement
  vadToggleBtn = document.getElementById('vad-toggle-btn') as HTMLButtonElement | null
  statusText = document.getElementById('status-text') as HTMLSpanElement | null
  vadIndicator = document.getElementById('vad-indicator') as HTMLSpanElement | null
  errorBar = document.getElementById('error-bar') as HTMLDivElement | null
}

export function initDashboardElements() {
  dashboardVadToggle = document.getElementById('dashboard-vad-toggle') as HTMLInputElement | null
}

// ── Trace (no-op placeholder) ──

export function uiTrace(_event: string, _extra: Record<string, unknown> = {}) {
  // intentionally empty
}

// ── Focus snapshot ──

export async function captureFocusSnapshot(reason: string): Promise<string | null> {
  try {
    const appId = await window.electronAPI.captureFocusSnapshot(reason)
    focusSnapshotAppId = appId
    uiTrace('focus.snapshot', { reason, appId })
    return appId
  } catch (e) {
    focusSnapshotAppId = null
    uiTrace('focus.snapshot.error', { reason, error: String(e) })
    return null
  }
}

// ── UI 状态 ──

export function setState(newState: RecordState | string, text?: string) {
  state = newState as RecordState
  recordBtn?.classList.remove('recording', 'recognizing', 'success')

  switch (newState) {
    case 'idle':
      if (statusText) {
        statusText.textContent = text || '就绪'
        statusText.classList.remove('result', 'command')
      }
      break
    case 'recording':
      recordBtn?.classList.add('recording')
      if (statusText) {
        statusText.textContent = '录音中...'
        statusText.classList.remove('result', 'command')
      }
      hideError()
      break
    case 'recognizing':
      recordBtn?.classList.add('recognizing')
      if (statusText) {
        statusText.textContent = '识别中...'
        statusText.classList.remove('result', 'command')
      }
      break
  }
}

export function showError(msg: string) {
  const text = String(msg).replace(/^Error:\s*/i, '')
  // errorBar 可能尚未通过 initFloatElements 初始化，动态查找
  const bar = errorBar || document.getElementById('error-bar') as HTMLDivElement | null
  const st = statusText || document.getElementById('status-text') as HTMLSpanElement | null
  if (bar) {
    bar.textContent = text
    bar.title = text
    bar.classList.add('visible')
  }
  if (st) {
    st.textContent = '出错了'
    st.classList.remove('result')
  }
  // 无论 UI 元素是否存在，都输出到控制台确保可追踪
  console.warn(`[showError] ${text}`)
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(hideError, 10000)
}

export function hideError() {
  const bar = errorBar || document.getElementById('error-bar') as HTMLDivElement | null
  if (bar) {
    bar.classList.remove('visible')
    bar.textContent = ''
  }
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null }
}

export function showResult(text: string) {
  hideError()
  if (state !== 'idle') {
    setState('idle')
  }
  flashSuccessState()
  const isCommand = text.includes('⌨')
  if (statusText) {
    statusText.textContent = text || '（空）'
    statusText.title = text || ''
    statusText.classList.remove('result', 'command')
    statusText.classList.add(isCommand ? 'command' : 'result')
    setTimeout(() => {
      if (state === 'idle' && statusText) {
        statusText.textContent = '就绪'
        statusText.title = ''
        statusText.classList.remove('result', 'command')
      }
    }, 3000)
  }
}

function flashSuccessState() {
  if (!recordBtn) return
  if (successFlashTimer) {
    clearTimeout(successFlashTimer)
    successFlashTimer = null
  }
  recordBtn.classList.remove('success')
  recordBtn.classList.add('success')
  successFlashTimer = setTimeout(() => {
    recordBtn.classList.remove('success')
    successFlashTimer = null
  }, SUCCESS_FLASH_MS)
}

// ── ASR Runtime Status ──

export function applyAsrRuntimeStatus(status: AsrRuntimeStatus) {
  asrRuntimeStatus = status
  if (state !== 'idle') return

  if (status.phase === 'starting') {
    const suffix = status.progress > 0 ? ` (${status.progress}%)` : ''
    setState('idle', `正在启动${suffix}`)
    return
  }

  if (status.phase === 'error') {
    const msg = status.message || '本地识别启动失败'
    setState('idle', '启动失败')
    if (msg !== lastAsrRuntimeError) {
      lastAsrRuntimeError = msg
      showError(`本地识别启动失败：${msg}`)
    }
    return
  }

  lastAsrRuntimeError = ''
  if (status.phase === 'ready') {
    setState('idle', '就绪')
  }
}

export async function refreshAsrRuntimeStatus() {
  try {
    const status = await window.electronAPI.getAsrRuntimeStatus()
    applyAsrRuntimeStatus(status)
  } catch (e) {
    console.warn('[ASR] getAsrRuntimeStatus failed:', e)
  }
}

export async function ensureAsrReadyBeforeCapture(): Promise<boolean> {
  let cfg = null
  try {
    cfg = await window.electronAPI.getConfig()
    applyAudioCaptureFromConfig(cfg)
  } catch {
    return true
  }
  if ((cfg.asr?.mode ?? 'api') !== 'local') return true

  if (asrRuntimeStatus.phase !== 'ready') {
    const suffix = asrRuntimeStatus.progress > 0 ? ` (${asrRuntimeStatus.progress}%)` : ''
    const msg = asrRuntimeStatus.message || `本地识别正在启动${suffix}`
    setState('idle', `正在启动${suffix}`)
    showError(msg)
    return false
  }
  return true
}

function applyAudioCaptureFromConfig(cfg: Pick<AppConfig, 'audioCapture'> | null | undefined) {
  if (!cfg) return
  setAudioCaptureConfig(cfg.audioCapture)
}

function clampVadThreshold(raw: number): number {
  if (!Number.isFinite(raw)) return VAD_DEFAULT_THRESHOLD
  return Math.min(VAD_THRESHOLD_MAX, Math.max(VAD_THRESHOLD_MIN, raw))
}

export function applyVadThreshold(threshold: number): number {
  const next = clampVadThreshold(threshold)
  vadState.threshold = next
  const thresholdSlider = document.getElementById('cfg-vad-threshold') as HTMLInputElement | null
  const thresholdDisplay = document.getElementById('vad-threshold-display')
  if (thresholdSlider) thresholdSlider.value = String(next)
  if (thresholdDisplay) thresholdDisplay.textContent = next.toFixed(2)
  return next
}

// ── 录音按钮点击 ──

export async function onRecordClick() {
  uiTrace('record-click.enter')
  if (state === 'recognizing') {
    uiTrace('record-click.skip', { reason: 'recognizing' })
    return
  }

  if (state === 'idle') {
    if (!await ensureAsrReadyBeforeCapture()) return
    try {
      uiTrace('record-click.start-capture.begin')
      if (!focusSnapshotAppId) {
        await captureFocusSnapshot('record-start')
      }
      uiTrace('record-click.start-capture.prev-app', { focusSnapshotAppId })
      startCapturePromise = startCapture()
      await startCapturePromise
      uiTrace('record-click.start-capture.ready')
      setState('recording')
    } catch (e) {
      startCapturePromise = null
      focusSnapshotAppId = null
      uiTrace('record-click.start-capture.error', { error: String(e) })
      showError(String(e))
    }
  } else if (state === 'recording') {
    // 手动点击停止录音时，重置 VAD 内部状态，避免状态机卡死
    if (vadState.enabled) resetVadSpeakingState()
    setState('recognizing')
    try {
      if (startCapturePromise) {
        await startCapturePromise.catch(() => { })
        startCapturePromise = null
      }
      const wav = await stopCapture()
      console.log('[识别] 发送 WAV 到主进程，大小:', wav.byteLength)
      const prevAppId = focusSnapshotAppId
      focusSnapshotAppId = null
      uiTrace('record-click.stop-capture.begin-recognize', { wavBytes: wav.byteLength, prevAppId })
      const result = await window.electronAPI.recognizeWav(wav, prevAppId)
      console.log('[识别] 结果:', result)
      uiTrace('record-click.stop-capture.result', { result })
      setState('idle')
      if (result) showResult(result)
      else setState('idle')
    } catch (e) {
      console.error('[识别] 失败:', e)
      setState('idle')
      focusSnapshotAppId = null
      uiTrace('record-click.stop-capture.error', { error: String(e) })
      showError(String(e))
    }
  }
}

// ── VAD 切换 ──

export function syncVadUi(enabled: boolean) {
  vadToggleBtn?.classList.toggle('active', enabled)
  vadToggleBtn?.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  vadIndicator?.classList.toggle('active', enabled)
  if (dashboardVadToggle) dashboardVadToggle.checked = enabled
  const cfgVadToggle = document.getElementById('cfg-vad') as HTMLInputElement | null
  if (cfgVadToggle) cfgVadToggle.checked = enabled
}

function makeVadCallbacks(): VadCallbacks {
  return {
    getState: () => state,
    setState,
    showError,
    showResult,
    captureFocusSnapshot,
    recognizeWav: (wav, prevAppId) => window.electronAPI.recognizeWav(wav, prevAppId),
  }
}

export async function applyVadEnabled(enabled: boolean, showHint: boolean) {
  if (enabled) {
    const cfg = await window.electronAPI.getConfig()
    applyAudioCaptureFromConfig(cfg)
    vadState = {
      enabled: true,
      threshold: VAD_DEFAULT_THRESHOLD,
      silenceMs: cfg.vad.silenceTimeoutMs,
      minSpeechMs: cfg.vad.minSpeechDurationMs,
    }
    applyVadThreshold(cfg.vad.speechThreshold)
    try {
      await startVad(vadState, makeVadCallbacks())
      syncVadUi(true)
    } catch (e) {
      vadState.enabled = false
      stopVad()
      syncVadUi(false)
      try {
        await window.electronAPI.setVadEnabled(false)
      } catch (syncErr) {
        console.warn('[VAD] rollback setVadEnabled(false) failed:', syncErr)
      }
      throw e
    }
  } else {
    vadState.enabled = false
    stopVad()
    syncVadUi(false)
  }

  if (showHint && statusText) {
    statusText.textContent = enabled ? 'VAD 已开启' : 'VAD 已关闭'
    setTimeout(() => {
      if (state === 'idle' && statusText) statusText.textContent = '就绪'
    }, 2000)
  }
}

export async function initVad() {
  const version = ++vadSyncVersion
  let lastError: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      const enabled = await window.electronAPI.getVadEnabled()
      if (version !== vadSyncVersion) return
      await applyVadEnabled(enabled, false)
      return
    } catch (e) {
      lastError = e
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  if (lastError) {
    showError(`初始化 VAD 失败: ${String(lastError)}`)
  }
}

export async function setVadEnabled(enabled: boolean) {
  const version = ++vadSyncVersion
  uiTrace('vad-toggle.request', { enabled, version })
  try {
    const result = await window.electronAPI.setVadEnabled(enabled)
    if (version !== vadSyncVersion) return
    uiTrace('vad-toggle.applied', { requested: enabled, result, version })
    await applyVadEnabled(result, true)
  } catch (e) {
    uiTrace('vad-toggle.error', { enabled, error: String(e) })
    showError(String(e))
  }
}

// ── Error reporting ──

function toShortErrorText(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function reportRendererError(payload: {
  kind: string
  message: string
  stack?: string
  source?: string
  lineno?: number
  colno?: number
  reason?: string
}) {
  void window.electronAPI.reportRendererError(payload).catch(() => { })
}

let rendererErrorHooksInstalled = false

export function installRendererErrorHooks() {
  if (rendererErrorHooksInstalled) return
  rendererErrorHooksInstalled = true

  const originalConsoleError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args)
    const message = args.map((item) => toShortErrorText(item)).join(' ').slice(0, 4000)
    reportRendererError({
      kind: 'console.error',
      message: message || 'console.error called with empty args',
    })
  }

  window.addEventListener('error', (event) => {
    const err = event.error
    reportRendererError({
      kind: 'window.error',
      message: err instanceof Error ? err.message : (event.message || 'unknown error'),
      stack: err instanceof Error ? err.stack : '',
      source: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
    })
    // 确保用户能看到错误
    const msg = err instanceof Error ? err.message : (event.message || '未知错误')
    showError(msg)
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    reportRendererError({
      kind: 'window.unhandledrejection',
      message: reason instanceof Error ? reason.message : 'Unhandled promise rejection',
      stack: reason instanceof Error ? reason.stack : '',
      reason: toShortErrorText(reason).slice(0, 4000),
    })
    // 确保用户能看到错误
    const msg = reason instanceof Error ? reason.message : String(reason)
    showError(msg)
  })
}
