import { encodeWav } from './wav'

// 通过 preload 暴露的 electronAPI 与主进程通信
declare global {
  interface Window {
    electronAPI: {
      getConfig: () => Promise<AppConfig>
      saveConfig: (config: AppConfig) => Promise<void>
      getFrontmostApp: () => Promise<string | null>
      captureFocusSnapshot: (reason?: string) => Promise<string | null>
      restoreFocus: (appId: string | null) => Promise<void>
      getVadEnabled: () => Promise<boolean>
      setVadEnabled: (enabled: boolean) => Promise<boolean>
      recognizeWav: (wavBuffer: ArrayBuffer, prevAppId: string | null) => Promise<string>
      openDashboard: () => Promise<void>
      getWindowPosition: () => Promise<[number, number]>
      setWindowPosition: (x: number, y: number) => Promise<void>
      getModelStatuses: () => Promise<ModelStatus[]>
      getModelCatalog: () => Promise<Array<{
        id: string
        name: string
        description: string
        size: string
      }>>
      downloadModel: (modelId: string) => Promise<{ success: boolean; error?: string }>
      deleteModel: (modelId: string) => Promise<void>
      getLogs: () => Promise<LogEntry[]>
      clearLogs: () => Promise<void>
      copyToClipboard: (text: string) => Promise<boolean>
      onHotkeyState: (cb: (state: string) => void) => void
      onHotkeyResult: (cb: (result: string) => void) => void
      onToggleVad: (cb: (enabled: boolean) => void) => void
      onHotkeyStopRecording: (cb: (prevAppId: string | null) => void) => void
      onModelDownloadProgress: (cb: (data: { modelId: string; percent: number; status?: string }) => void) => void
      onLogEntry: (cb: (entry: LogEntry) => void) => void
      onPermissionWarning: (cb: (message: string) => void) => void

      // 重写专用通道
      closeRewrite: () => Promise<void>
      executeRewrite: (text: string, instruction: string) => Promise<string>
      replaceText: (newText: string) => Promise<void>
      onInitRewrite: (cb: (text: string) => void) => void
      onRewriteChunk: (cb: (chunk: string) => void) => void
    }
  }
}

interface HotwordScene {
  name: string
  words: string[]
}

interface ModelStatus {
  id: string
  name: string
  description: string
  size: string
  downloaded: boolean
  incomplete?: boolean
  dependencies?: Array<{
    role: string
    modelName: string
    backend: string
    quantize: boolean
    cached: boolean
    complete: boolean
    missingFiles?: string[]
    issue?: string
  }>
}

interface ModelCatalogItem {
  id: string
  name: string
  description: string
  size: string
}

interface LogEntry {
  time: string
  level: string
  msg: string
}

// 配置类型（与主进程保持一致）
interface AppConfig {
  server: { url: string; asrConfigId: string }
  hotkey: { record: string }
  input: { useClipboard: boolean }
  vad: { enabled: boolean; speechThreshold: number; silenceTimeoutMs: number; minSpeechDurationMs: number }
  voiceCommands: Record<string, string>
  hotwords: HotwordScene[]
  asr: { mode: 'api' | 'local'; localModel: string }
  llm: { enabled: boolean; baseUrl: string; apiKey: string; model: string }
}

type RecordState = 'idle' | 'recording' | 'recognizing' | 'success'

let state: RecordState = 'idle'
let recordBtn: HTMLButtonElement
let vadToggleBtn: HTMLButtonElement | null
let statusText: HTMLSpanElement | null
let vadIndicator: HTMLSpanElement | null
let dashboardVadToggle: HTMLInputElement | null
let errorBar: HTMLDivElement | null
let errorTimer: ReturnType<typeof setTimeout> | null = null
let floatCapsuleView: HTMLDivElement
let mainDashboardView: HTMLDivElement
let currentMode: 'float' | 'dashboard' = 'float'

// ── 录音相关 ──

let audioCtx: AudioContext | null = null
let mediaStream: MediaStream | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let pcmSamples: Float32Array[] = []
let isCapturing = false
// 追踪 startCapture 的 Promise，防止 stopCapture 在它完成前被调用
let startCapturePromise: Promise<void> | null = null
// 单一焦点快照：录音开始时记录原前台应用，用于识别后恢复光标焦点
let focusSnapshotAppId: string | null = null

function uiTrace(event: string, extra: Record<string, unknown> = {}) {
  void event
  void extra
}

async function captureFocusSnapshot(reason: string): Promise<string | null> {
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

// 初始化麦克风
async function initMic(): Promise<void> {
  if (mediaStream) return
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
}

// 开始采集 PCM
async function startCapture(): Promise<void> {
  await initMic()
  audioCtx = new AudioContext({ sampleRate: 16000 })
  // AudioContext 默认 suspended，必须 resume 才能触发 onaudioprocess
  await audioCtx.resume()
  const source = audioCtx.createMediaStreamSource(mediaStream!)
  scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1)
  pcmSamples = []
  isCapturing = true

  scriptProcessor.onaudioprocess = (e) => {
    if (!isCapturing) return
    const data = e.inputBuffer.getChannelData(0)
    pcmSamples.push(new Float32Array(data))
  }

  source.connect(scriptProcessor)
  scriptProcessor.connect(audioCtx.destination)
  console.log('[录音] 开始采集，AudioContext state:', audioCtx.state)
}

// 停止采集，返回 WAV ArrayBuffer
function stopCapture(): ArrayBuffer {
  isCapturing = false
  scriptProcessor?.disconnect()
  audioCtx?.close()
  scriptProcessor = null
  audioCtx = null
  const wav = encodeWav(pcmSamples)
  console.log(`[录音] 停止采集，chunks=${pcmSamples.length}，WAV 大小=${wav.byteLength} 字节`)
  return wav
}

// ── VAD（渲染进程实现） ──

interface VadState {
  enabled: boolean
  threshold: number
  silenceMs: number
  minSpeechMs: number
}

let vadState: VadState = { enabled: false, threshold: 0.03, silenceMs: 800, minSpeechMs: 300 }
let vadAudioCtx: AudioContext | null = null
let vadAnalyser: AnalyserNode | null = null
let vadStream: MediaStream | null = null
let vadTimer: ReturnType<typeof setInterval> | null = null
let vadSpeakingStart = 0
let vadSilenceStart = 0
let vadIsSpeaking = false
let vadIsProcessing = false
let vadCapturePromise: Promise<void> | null = null
let vadSyncVersion = 0
// VAD 自动识别时记录原前台应用，用于识别后恢复光标焦点
let vadPrevAppId: string | null = null

async function startVad(): Promise<void> {
  if (!vadState.enabled || vadIsProcessing || vadTimer) return
  if (!vadStream) {
    vadStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  }
  vadAudioCtx = new AudioContext({ sampleRate: 16000 })
  await vadAudioCtx.resume()
  vadAnalyser = vadAudioCtx.createAnalyser()
  vadAnalyser.fftSize = 2048
  const source = vadAudioCtx.createMediaStreamSource(vadStream)
  source.connect(vadAnalyser)

  const dataArray = new Float32Array(vadAnalyser.fftSize)

  vadTimer = setInterval(() => {
    if (!vadAnalyser || vadIsProcessing) return
    if (!vadIsSpeaking && state !== 'idle') return
    vadAnalyser.getFloatTimeDomainData(dataArray)
    // 计算 RMS 能量
    let sum = 0
    for (const v of dataArray) sum += v * v
    const rms = Math.sqrt(sum / dataArray.length)

    const now = Date.now()
    if (rms > vadState.threshold) {
      if (!vadIsSpeaking) {
        vadIsSpeaking = true
        vadSpeakingStart = now
        vadSilenceStart = now
        void captureFocusSnapshot('vad-speech-start')
          .then((appId) => { if (vadIsSpeaking) vadPrevAppId = appId })
          .catch(() => { if (vadIsSpeaking) vadPrevAppId = null })
        // 开始录音
        vadCapturePromise = startCapture().catch((e) => {
          vadIsSpeaking = false
          vadCapturePromise = null
          vadPrevAppId = null
          setState('idle')
          showError(String(e))
          throw e
        })
        setState('recording')
      }
      vadSilenceStart = now
    } else if (vadIsSpeaking) {
      if (now - vadSilenceStart > vadState.silenceMs) {
        // 静音超时，触发识别
        vadIsSpeaking = false
        const speechDuration = vadSilenceStart - vadSpeakingStart
        const captureReady = vadCapturePromise
        const prevAppId = vadPrevAppId
        vadCapturePromise = null
        vadPrevAppId = null
        vadIsProcessing = true
        Promise.resolve(captureReady)
          .catch(() => null)
          .then(() => {
            if (speechDuration < vadState.minSpeechMs) {
              stopCapture()
              setState('idle')
              return
            }
            setState('recognizing')
            const wav = stopCapture()
            return window.electronAPI.recognizeWav(wav, prevAppId)
              .then(result => {
                setState('idle')
                if (result) showResult(result)
              })
              .catch(e => {
                setState('idle')
                showError(String(e))
              })
          })
          .finally(() => {
            vadIsProcessing = false
          })
      }
    }
  }, 50)
}

function stopVad(): void {
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null }
  vadAudioCtx?.close()
  vadAudioCtx = null
  vadAnalyser = null
  if (vadIsSpeaking) {
    stopCapture()
  }
  vadCapturePromise = null
  vadPrevAppId = null
  vadSpeakingStart = 0
  vadSilenceStart = 0
  vadIsSpeaking = false
  vadIsProcessing = false
}

// ── UI 状态 ──

function setState(newState: RecordState, text?: string) {
  state = newState
  recordBtn.classList.remove('recording', 'recognizing', 'success')

  switch (newState) {
    case 'idle':
      if (statusText) {
        statusText.textContent = text || '就绪'
        statusText.classList.remove('result')
      }
      break
    case 'recording':
      recordBtn.classList.add('recording')
      if (statusText) {
        statusText.textContent = '录音中...'
        statusText.classList.remove('result')
      }
      hideError()
      break
    case 'recognizing':
      recordBtn.classList.add('recognizing')
      if (statusText) {
        statusText.textContent = '识别中...'
        statusText.classList.remove('result')
      }
      break
    case 'success':
      recordBtn.classList.add('success')
      if (statusText) {
        statusText.textContent = '完成！'
      }
      setTimeout(() => {
        if (state === 'success') setState('idle')
      }, 1000)
      break
  }
}

function showError(msg: string) {
  const text = String(msg).replace(/^Error:\s*/i, '')
  if (errorBar) {
    errorBar.textContent = text
    errorBar.title = text
    errorBar.classList.add('visible')
  }
  if (statusText) {
    statusText.textContent = '出错了'
    statusText.classList.remove('result')
  }
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(hideError, 10000)
}

function hideError() {
  if (errorBar) {
    errorBar.classList.remove('visible')
    errorBar.textContent = ''
  }
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null }
}

function showResult(text: string) {
  hideError()
  setState('success') // 触发浮窗球极简发光成功状态
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

// ── 录音按钮点击 ──

async function onRecordClick() {
  uiTrace('record-click.enter')
  if (state === 'recognizing') {
    uiTrace('record-click.skip', { reason: 'recognizing' })
    return
  }

  if (state === 'idle') {
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
    setState('recognizing')
    try {
      // 等待 startCapture 完成（防止 race condition）
      if (startCapturePromise) {
        await startCapturePromise.catch(() => { })
        startCapturePromise = null
      }
      const wav = stopCapture()
      console.log('[识别] 发送 WAV 到主进程，大小:', wav.byteLength)
      // 30 秒超时保护，防止 fetch 挂住导致永远卡在识别中
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('识别超时（30s）')), 30000),
      )
      const prevAppId = focusSnapshotAppId
      focusSnapshotAppId = null
      uiTrace('record-click.stop-capture.begin-recognize', { wavBytes: wav.byteLength, prevAppId })
      const result = await Promise.race([
        window.electronAPI.recognizeWav(wav, prevAppId),
        timeout,
      ])
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

function syncVadUi(enabled: boolean) {
  vadToggleBtn?.classList.toggle('active', enabled)
  vadToggleBtn?.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  vadIndicator?.classList.toggle('active', enabled)
  if (dashboardVadToggle) dashboardVadToggle.checked = enabled
  const cfgVadToggle = document.getElementById('cfg-vad') as HTMLInputElement | null
  if (cfgVadToggle) cfgVadToggle.checked = enabled
}

async function applyVadEnabled(enabled: boolean, showHint: boolean) {
  if (enabled) {
    const cfg = await window.electronAPI.getConfig()
    vadState = {
      enabled: true,
      threshold: cfg.vad.speechThreshold,
      silenceMs: cfg.vad.silenceTimeoutMs,
      minSpeechMs: cfg.vad.minSpeechDurationMs,
    }
    try {
      await startVad()
      syncVadUi(true)
    } catch (e) {
      vadState.enabled = false
      stopVad()
      syncVadUi(false)
      try {
        await window.electronAPI.setVadEnabled(false)
      } catch (_) { }
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

async function initVad() {
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

async function setVadEnabled(enabled: boolean) {
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

// 移除原有的前端单窗体大小 toggle 函数

function initTabs() {
  const tabBtns = document.querySelectorAll<HTMLButtonElement>('.menu-item')
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      document.querySelectorAll<HTMLDivElement>('.tab-pane').forEach((tc) => tc.classList.remove('active'))
      const target = btn.dataset.tab!
      document.getElementById(`tab-${target}`)!.classList.add('active')
    })
  })
}

async function loadConfigToForm() {
  const urlInput = document.getElementById('cfg-url') as HTMLInputElement | null
  if (!urlInput) return // 不在该路由视图内

  try {
    const cfg = await window.electronAPI.getConfig()
      ; urlInput.value = cfg.server?.url || ''
      ; (document.getElementById('cfg-hotkey') as HTMLInputElement).value = cfg.hotkey?.record || ''
      ; (document.getElementById('cfg-clipboard') as HTMLInputElement).checked = cfg.input?.useClipboard || false
      ; (document.getElementById('cfg-vad') as HTMLInputElement).checked = cfg.vad?.enabled || false
      ; (document.getElementById('dashboard-vad-toggle') as HTMLInputElement).checked = cfg.vad?.enabled || false
      ; (document.getElementById('cfg-llm-enabled') as HTMLInputElement).checked = cfg.llm?.enabled || false
      ; (document.getElementById('cfg-llm-baseurl') as HTMLInputElement).value = cfg.llm?.baseUrl || ''
      ; (document.getElementById('cfg-llm-apikey') as HTMLInputElement).value = cfg.llm?.apiKey || ''
      ; (document.getElementById('cfg-llm-model') as HTMLInputElement).value = cfg.llm?.model || ''
    // ASR 模式
    const asrMode = cfg.asr?.mode ?? 'api'
      ; (document.getElementById('asr-mode-api') as HTMLInputElement).checked = asrMode === 'api'
      ; (document.getElementById('asr-mode-local') as HTMLInputElement).checked = asrMode === 'local'
    updateAsrModeUI(asrMode)
    await renderModelList(cfg.asr?.localModel)
  } catch (_) { }
}

async function renderCommandList() {
  const list = document.getElementById('cmd-list')
  if (!list) return
  list.innerHTML = ''
  try {
    const cfg = await window.electronAPI.getConfig()
    const cmds: Record<string, string> = cfg.voiceCommands || {}
    const entries = Object.entries(cmds).sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    for (const [name, key] of entries) {
      const nameEl = document.createElement('span')
      nameEl.className = 'cmd-name'
      nameEl.textContent = name
      const keyEl = document.createElement('span')
      keyEl.className = 'cmd-key'
      keyEl.textContent = key
      list.appendChild(nameEl)
      list.appendChild(keyEl)
    }
  } catch (_) { }
}

// 渲染语音指令编辑器（可增删改）
async function renderCommandEditor() {
  const editorList = document.getElementById('cmd-editor-list')
  if (!editorList) return
  editorList.innerHTML = ''
  try {
    const cfg = await window.electronAPI.getConfig()
    const cmds: Record<string, string> = cfg.voiceCommands || {}
    const entries = Object.entries(cmds).sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    for (const [name, key] of entries) {
      appendCommandRow(editorList, name, key)
    }
  } catch (_) { }
}

// 在编辑器列表末尾追加一行
function appendCommandRow(container: HTMLElement, name = '', key = '') {
  const row = document.createElement('div')
  row.className = 'cmd-editor-row'

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'cmd-input cmd-name-input'
  nameInput.placeholder = '语音词'
  nameInput.value = name

  const keyInput = document.createElement('input')
  keyInput.type = 'text'
  keyInput.className = 'cmd-input cmd-key-input'
  keyInput.placeholder = '快捷键（如 ALT+R）'
  keyInput.value = key

  const delBtn = document.createElement('button')
  delBtn.className = 'cmd-del-btn'
  delBtn.textContent = '×'
  delBtn.title = '删除'
  delBtn.addEventListener('click', () => row.remove())

  row.appendChild(nameInput)
  row.appendChild(keyInput)
  row.appendChild(delBtn)
  container.appendChild(row)
}

// 保存语音指令配置
async function saveCommands() {
  const hint = document.getElementById('cmd-save-hint')!
  try {
    const cfg = await window.electronAPI.getConfig()
    const rows = document.querySelectorAll<HTMLDivElement>('#cmd-editor-list .cmd-editor-row')
    const newCmds: Record<string, string> = {}
    for (const row of rows) {
      const name = (row.querySelector('.cmd-name-input') as HTMLInputElement).value.trim()
      const key = (row.querySelector('.cmd-key-input') as HTMLInputElement).value.trim()
      if (name && key) newCmds[name] = key
    }
    cfg.voiceCommands = newCmds
    await window.electronAPI.saveConfig(cfg)
    hint.textContent = '已保存'
    hint.style.color = '#4ade80'
    // 同步刷新说明 Tab 的只读列表
    renderCommandList()
    setTimeout(() => { hint.textContent = '' }, 2000)
  } catch (e) {
    hint.textContent = '保存失败: ' + String(e)
    hint.style.color = '#f87171'
  }
}

async function saveConfig() {
  const hint = document.getElementById('save-hint')!
  const llmHint = document.getElementById('llm-save-hint')
  try {
    const cfg = await window.electronAPI.getConfig()
    cfg.server.url = (document.getElementById('cfg-url') as HTMLInputElement).value.trim()
    cfg.hotkey.record = (document.getElementById('cfg-hotkey') as HTMLInputElement).value.trim()
    cfg.input.useClipboard = (document.getElementById('cfg-clipboard') as HTMLInputElement).checked
    // ASR 模式
    const asrMode = (document.getElementById('asr-mode-local') as HTMLInputElement).checked ? 'local' : 'api'
    cfg.asr = { ...cfg.asr, mode: asrMode }
    // LLM 配置
    cfg.llm = {
      enabled: (document.getElementById('cfg-llm-enabled') as HTMLInputElement).checked,
      baseUrl: (document.getElementById('cfg-llm-baseurl') as HTMLInputElement).value.trim(),
      apiKey: (document.getElementById('cfg-llm-apikey') as HTMLInputElement).value.trim(),
      model: (document.getElementById('cfg-llm-model') as HTMLInputElement).value.trim()
    }
    await window.electronAPI.saveConfig(cfg)
    hint.textContent = '已保存，部分设置重启后生效'
    hint.style.color = '#4ade80'
    if (llmHint) {
      llmHint.textContent = '应用已持久化'
      llmHint.style.color = '#4ade80'
    }
  } catch (e) {
    hint.textContent = '保存失败: ' + String(e)
    hint.style.color = '#f87171'
    if (llmHint) {
      llmHint.textContent = '保存失败'
      llmHint.style.color = '#f87171'
    }
  }
}

// ── 热词管理 ──

let hotwordScenes: HotwordScene[] = [{ name: '全局', words: [] }]
let activeSceneIndex = 0
let hotwordSearchQuery = ''

// 从配置加载热词
async function loadHotwords() {
  const tabsContainer = document.getElementById('scene-tabs')
  if (!tabsContainer) return

  try {
    const cfg = await window.electronAPI.getConfig()
    hotwordScenes = cfg.hotwords ?? [{ name: '全局', words: [] }]
    activeSceneIndex = 0
    hotwordSearchQuery = ''
    const searchInput = document.getElementById('hotword-search') as HTMLInputElement
    if (searchInput) searchInput.value = ''
    renderSceneTabs()
    renderHotwordTags()
  } catch (_) { }
}

// 渲染场景 pill tabs
function renderSceneTabs() {
  const container = document.getElementById('scene-tabs')!
  container.innerHTML = ''
  hotwordScenes.forEach((scene, i) => {
    const tab = document.createElement('button')
    tab.className = 'scene-tab' + (i === activeSceneIndex ? ' active' : '')
    tab.textContent = scene.name
    tab.addEventListener('click', () => switchScene(i))
    // 非全局场景可删除
    if (i > 0) {
      const del = document.createElement('button')
      del.className = 'scene-tab-del'
      del.textContent = '×'
      del.title = '删除场景'
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteScene(i) })
      tab.appendChild(del)
    }
    container.appendChild(tab)
  })
}

function switchScene(index: number) {
  activeSceneIndex = index
  renderSceneTabs()
  renderHotwordTags()
}

// 拼音排序（零依赖）
function sortByPinyin(words: string[]): string[] {
  return [...words].sort((a, b) => a.localeCompare(b, 'zh'))
}

// 子串匹配过滤
function filterHotwords(words: string[], query: string): string[] {
  if (!query) return words
  return words.filter(w => w.includes(query))
}

// 渲染热词 Tag
function renderHotwordTags() {
  const container = document.getElementById('hotword-tags')!
  container.innerHTML = ''
  const scene = hotwordScenes[activeSceneIndex]
  if (!scene) return
  const sorted = sortByPinyin(scene.words)
  const filtered = filterHotwords(sorted, hotwordSearchQuery)
  if (filtered.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'hotword-empty'
    empty.textContent = hotwordSearchQuery ? '没有匹配的热词' : '暂无热词，请在上方输入框添加'
    container.appendChild(empty)
    return
  }
  for (const word of filtered) {
    const tag = document.createElement('span')
    tag.className = 'hotword-tag'
    tag.textContent = word
    const del = document.createElement('button')
    del.className = 'hotword-tag-del'
    del.textContent = '×'
    del.addEventListener('click', () => removeHotword(word))
    tag.appendChild(del)
    container.appendChild(tag)
  }
}

// 添加热词（去重）
function addHotword(word: string) {
  const trimmed = word.trim()
  if (!trimmed) return
  const scene = hotwordScenes[activeSceneIndex]
  if (!scene || scene.words.includes(trimmed)) return
  scene.words.push(trimmed)
  renderHotwordTags()
}

// 删除热词
function removeHotword(word: string) {
  const scene = hotwordScenes[activeSceneIndex]
  if (!scene) return
  scene.words = scene.words.filter(w => w !== word)
  renderHotwordTags()
}

// 新增场景
function addScene() {
  const name = prompt('请输入场景名称：')
  if (!name || !name.trim()) return
  const trimmed = name.trim()
  // 检查重名
  if (hotwordScenes.some(s => s.name === trimmed)) {
    alert('场景名称已存在')
    return
  }
  hotwordScenes.push({ name: trimmed, words: [] })
  activeSceneIndex = hotwordScenes.length - 1
  renderSceneTabs()
  renderHotwordTags()
}

// 删除场景（全局不可删）
function deleteScene(index: number) {
  if (index === 0) return
  if (!confirm(`确定删除场景「${hotwordScenes[index].name}」？`)) return
  hotwordScenes.splice(index, 1)
  if (activeSceneIndex >= hotwordScenes.length) activeSceneIndex = hotwordScenes.length - 1
  renderSceneTabs()
  renderHotwordTags()
}

// 保存热词到配置
async function saveHotwords() {
  const hint = document.getElementById('hotword-save-hint')!
  try {
    const cfg = await window.electronAPI.getConfig()
    cfg.hotwords = hotwordScenes
    await window.electronAPI.saveConfig(cfg)
    hint.textContent = '已保存'
    hint.style.color = '#4ade80'
    setTimeout(() => { hint.textContent = '' }, 2000)
  } catch (e) {
    hint.textContent = '保存失败: ' + String(e)
    hint.style.color = '#f87171'
  }
}

// ── ASR 模式切换 ──

function updateAsrModeUI(mode: string) {
  const apiSettings = document.getElementById('api-settings')!
  const localSettings = document.getElementById('local-model-settings')!
  apiSettings.style.display = mode === 'api' ? '' : 'none'
  localSettings.style.display = mode === 'local' ? '' : 'none'
}

// ── 模型管理 ──

let currentSelectedModel = 'paraformer-zh-contextual-quant'

function getBrokenDeps(model: ModelStatus): Array<{ role: string; issue: string }> {
  return (model.dependencies || [])
    .filter(dep => !dep.complete)
    .map(dep => ({ role: dep.role, issue: dep.issue || '模型文件不完整' }))
}

function updateModelIntegrityIndicators(models: ModelStatus[]) {
  const brokenModels = models.filter(m => Boolean(m.incomplete))
  const warningIcon = document.getElementById('settings-model-warning') as HTMLSpanElement | null
  if (warningIcon) {
    warningIcon.hidden = brokenModels.length === 0
    warningIcon.title = brokenModels.length
      ? `检测到 ${brokenModels.length} 个本地模型不完整，请进入首选项重新下载`
      : ''
  }

  const tip = document.getElementById('model-integrity-tip') as HTMLDivElement | null
  if (!tip) return
  if (brokenModels.length === 0) {
    tip.style.display = 'none'
    tip.textContent = ''
    return
  }
  const names = brokenModels.map(m => m.name).join('、')
  tip.style.display = ''
  tip.textContent = `检测到模型文件不完整：${names}。请点击“重新下载”修复。`
}

function setModelListHint(message = '', withRetry = false) {
  const hint = document.getElementById('model-list-hint') as HTMLDivElement | null
  if (!hint) return
  if (!message) {
    hint.style.display = 'none'
    hint.textContent = ''
    return
  }
  hint.style.display = ''
  hint.innerHTML = ''
  const text = document.createElement('span')
  text.textContent = message
  hint.appendChild(text)
  if (withRetry) {
    const retry = document.createElement('button')
    retry.className = 'btn-sm btn-sm-select'
    retry.textContent = '重试'
    retry.addEventListener('click', () => { void renderModelList() })
    hint.appendChild(retry)
  }
}

function mapCatalogToStatuses(catalog: ModelCatalogItem[]): ModelStatus[] {
  return catalog.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    size: item.size,
    downloaded: false,
    incomplete: false,
    dependencies: [],
  }))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout (${timeoutMs}ms)`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

async function fetchModelStatusesWithFallback(): Promise<{ models: ModelStatus[]; fallbackUsed: boolean }> {
  const statuses = await withTimeout(window.electronAPI.getModelStatuses(), 4000, 'get-model-statuses')
  if (Array.isArray(statuses) && statuses.length > 0) {
    return { models: statuses, fallbackUsed: false }
  }
  const catalog = await withTimeout(window.electronAPI.getModelCatalog(), 2000, 'get-model-catalog')
  if (Array.isArray(catalog) && catalog.length > 0) {
    return { models: mapCatalogToStatuses(catalog), fallbackUsed: true }
  }
  return { models: [], fallbackUsed: true }
}

async function renderModelList(selectedModel?: string) {
  const container = document.getElementById('model-list')
  if (!container) return
  if (selectedModel) currentSelectedModel = selectedModel
  container.innerHTML = ''
  setModelListHint('正在加载模型列表...')
  try {
    const { models, fallbackUsed } = await fetchModelStatusesWithFallback()
    if (models.length === 0) {
      updateModelIntegrityIndicators([])
      setModelListHint('模型列表加载失败，请重试。', true)
      return
    }
    if (fallbackUsed) {
      setModelListHint('模型状态读取失败，已显示基础模型列表。你仍可点击“准备模型”继续。', true)
    } else {
      setModelListHint('')
    }
    updateModelIntegrityIndicators(models)
    for (const m of models) {
      const item = document.createElement('div')
      item.className = 'model-item' + (m.id === currentSelectedModel ? ' active' : '')

      const info = document.createElement('div')
      info.className = 'model-info'
      info.innerHTML = `<div class="model-name">${m.name}</div><div class="model-desc">${m.description}</div><div class="model-size">${m.size}</div>`
      if (m.incomplete) {
        const broken = getBrokenDeps(m)
        if (broken.length > 0) {
          const note = document.createElement('div')
          note.className = 'model-integrity-note'
          note.textContent = `不完整项：${broken.map((d) => `${d.role}(${d.issue})`).join('；')}`
          info.appendChild(note)
        }
      }

      const actions = document.createElement('div')
      actions.className = 'model-actions'

      if (m.incomplete) {
        const status = document.createElement('span')
        status.className = 'model-status model-status-warn'
        status.textContent = '下载不完整'
        actions.appendChild(status)

        const retryBtn = document.createElement('button')
        retryBtn.className = 'btn-sm btn-sm-primary'
        retryBtn.textContent = '重新下载'
        retryBtn.id = `dl-btn-${m.id}`
        retryBtn.addEventListener('click', () => downloadModelUI(m.id))
        actions.appendChild(retryBtn)

        const progress = document.createElement('span')
        progress.className = 'model-progress'
        progress.id = `dl-progress-${m.id}`
        actions.appendChild(progress)

        const delBtn = document.createElement('button')
        delBtn.className = 'btn-sm btn-sm-danger'
        delBtn.textContent = '删除'
        delBtn.addEventListener('click', () => deleteModelUI(m.id))
        actions.appendChild(delBtn)
      } else if (m.downloaded) {
        const status = document.createElement('span')
        status.className = 'model-status'
        status.textContent = '已下载'
        actions.appendChild(status)

        if (m.id !== currentSelectedModel) {
          const selectBtn = document.createElement('button')
          selectBtn.className = 'btn-sm btn-sm-select'
          selectBtn.textContent = '使用'
          selectBtn.addEventListener('click', () => selectModel(m.id))
          actions.appendChild(selectBtn)
        } else {
          const badge = document.createElement('span')
          badge.className = 'model-status'
          badge.textContent = '当前'
          badge.style.color = '#0ea5e9'
          actions.appendChild(badge)
        }

        const delBtn = document.createElement('button')
        delBtn.className = 'btn-sm btn-sm-danger'
        delBtn.textContent = '删除'
        delBtn.addEventListener('click', () => deleteModelUI(m.id))
        actions.appendChild(delBtn)
      } else {
        const dlBtn = document.createElement('button')
        dlBtn.className = 'btn-sm btn-sm-primary'
        dlBtn.textContent = '准备模型'
        dlBtn.id = `dl-btn-${m.id}`
        dlBtn.addEventListener('click', () => downloadModelUI(m.id))
        actions.appendChild(dlBtn)

        const progress = document.createElement('span')
        progress.className = 'model-progress'
        progress.id = `dl-progress-${m.id}`
        actions.appendChild(progress)
      }

      item.appendChild(info)
      item.appendChild(actions)
      container.appendChild(item)
    }
  } catch (e) {
    updateModelIntegrityIndicators([])
    setModelListHint(`模型列表加载失败：${String(e)}`, true)
  }
}

async function selectModel(modelId: string) {
  currentSelectedModel = modelId
  const cfg = await window.electronAPI.getConfig()
  cfg.asr = { ...cfg.asr, localModel: modelId }
  await window.electronAPI.saveConfig(cfg)
  await renderModelList()
}

async function downloadModelUI(modelId: string) {
  const btn = document.getElementById(`dl-btn-${modelId}`) as HTMLButtonElement
  const progress = document.getElementById(`dl-progress-${modelId}`)
  if (btn) { btn.disabled = true; btn.textContent = '准备中...' }
  if (progress) progress.textContent = '正在检查并准备模型文件，请耐心等待...'
  const result = await window.electronAPI.downloadModel(modelId)
  if (result.success) {
    await renderModelList()
  } else {
    if (btn) { btn.disabled = false; btn.textContent = '准备模型' }
    if (progress) progress.textContent = ''
    alert('准备失败: ' + (result.error || '未知错误'))
  }
}

async function deleteModelUI(modelId: string) {
  if (!confirm('确定删除此模型？')) return
  await window.electronAPI.deleteModel(modelId)
  await renderModelList()
}

// ── 日志 ──

function appendLogEntry(entry: LogEntry) {
  const container = document.getElementById('log-container')
  if (!container) return
  const div = document.createElement('div')
  div.className = 'log-entry'
  const time = entry.time.slice(11, 23)
  const levelClass = `log-level-${entry.level}`
  div.innerHTML = `<span class="log-time">${time}</span> <span class="${levelClass}">[${entry.level.toUpperCase()}]</span> <span class="log-msg">${escapeHtml(entry.msg)}</span>`
  container.appendChild(div)
  // 自动滚动到底部
  container.scrollTop = container.scrollHeight
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function loadLogs() {
  const container = document.getElementById('log-container')
  if (!container) return
  container.innerHTML = ''
  try {
    const logs = await window.electronAPI.getLogs()
    for (const entry of logs) appendLogEntry(entry)
  } catch (_) { }
}

function logsToPlainText(logs: LogEntry[]): string {
  return logs
    .map((entry) => `${entry.time} [${entry.level.toUpperCase()}] ${entry.msg}`)
    .join('\n')
}

async function copyLogsToClipboard() {
  const logs = await window.electronAPI.getLogs()
  const text = logsToPlainText(logs)
  if (!text.trim()) {
    throw new Error('当前没有可复制的日志')
  }
  const ok = await window.electronAPI.copyToClipboard(text)
  if (!ok) {
    throw new Error('系统剪贴板不可用')
  }
}

// ── 初始化 ──

window.addEventListener('DOMContentLoaded', () => {
  // --- 边界拦截与单页面路由 (hash路由分发) ---
  if (window.location.hash.includes('rewrite')) {
    initRewriteUI()
    return
  }
  if (window.location.hash.includes('dashboard')) {
    initDashboardUI()
    return
  }

  // 默认进入浮窗模式
  initFloatCapsuleUI()
})

// ======================================
//        FLOAT CAPSULE (主悬浮窗)
// ======================================
function initFloatCapsuleUI() {
  document.getElementById('float-capsule-view')!.classList.add('active')
  document.getElementById('main-dashboard-view')!.classList.remove('active')

  recordBtn = document.getElementById('record-btn') as HTMLButtonElement
  vadToggleBtn = document.getElementById('vad-toggle-btn') as HTMLButtonElement | null
  statusText = document.getElementById('status-text') as HTMLSpanElement | null
  vadIndicator = document.getElementById('vad-indicator') as HTMLSpanElement | null
  errorBar = document.getElementById('error-bar') as HTMLDivElement | null

  // 悬浮球纯 JS 拖动兼顾单击双击兼容 (绕过 -webkit-app-region)
  let isDragging = false
  let dragMoved = false
  let pointerId = -1
  let startX = 0, startY = 0
  let winStartX = 0, winStartY = 0

  recordBtn.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return
    uiTrace('record-btn.pointerdown', { button: e.button, pointerId: e.pointerId })
    isDragging = true
    dragMoved = false
    pointerId = e.pointerId
    recordBtn.setPointerCapture(pointerId)

    try {
      startX = e.screenX
      startY = e.screenY
      const snapshotPromise = captureFocusSnapshot('record-pointerdown')
      const pos = await window.electronAPI.getWindowPosition()
      winStartX = pos[0]
      winStartY = pos[1]
      await snapshotPromise
      uiTrace('record-btn.pointerdown.ready', { focusSnapshotAppId, winStartX, winStartY })
    } catch (err) {
      uiTrace('record-btn.pointerdown.error', { error: String(err) })
    }
  })

  recordBtn.addEventListener('pointermove', (e) => {
    if (!isDragging) return
    const dx = e.screenX - startX
    const dy = e.screenY - startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true
    if (dragMoved) {
      window.electronAPI.setWindowPosition(winStartX + dx, winStartY + dy)
    }
  })

  recordBtn.addEventListener('pointerup', (e) => {
    if (!isDragging) return
    isDragging = false
    recordBtn.releasePointerCapture(pointerId)
    uiTrace('record-btn.pointerup', { pointerId: e.pointerId, dragMoved })
  })

  // 悬浮球事件（单击录音，双击/右键呼出面板）
  // 用延时区分单击和双击，避免双击时误触发录音
  let clickTimer: ReturnType<typeof setTimeout> | null = null
  recordBtn.addEventListener('click', (e) => {
    if (dragMoved) {
      uiTrace('record-btn.click.ignored', { reason: 'drag-moved' })
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (clickTimer) return // 等待双击判定中，忽略第二次 click
    clickTimer = setTimeout(() => {
      clickTimer = null
      uiTrace('record-btn.click')
      onRecordClick()
    }, 250)
  })
  recordBtn.addEventListener('dblclick', (e) => {
    if (dragMoved) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    window.electronAPI.openDashboard()
  })
  recordBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!dragMoved) window.electronAPI.openDashboard()
  })

  // 悬浮球 VAD 按钮：点击切换
  vadToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    uiTrace('vad-btn.click', { targetEnabled: !vadState.enabled })
    setVadEnabled(!vadState.enabled)
  })

  // 监听热键状态（主进程推送）
  window.electronAPI.onHotkeyState((s) => {
    if (s === 'recording') {
      if (state !== 'idle') return
      setState('recording')
      // 保存 promise，供 onHotkeyStopRecording 等待
      startCapturePromise = startCapture()
      startCapturePromise.catch(e => showError(String(e)))
    } else if (s === 'recognizing') {
      setState('recognizing')
    } else {
      setState('idle')
    }
  })

  // 热键触发停止录音（toggle 模式：主进程通知渲染进程停止采集并识别）
  window.electronAPI.onHotkeyStopRecording(async (prevAppId) => {
    if (state !== 'recording') return
    setState('recognizing')
    try {
      // 等待 startCapture 完成，防止 race condition
      if (startCapturePromise) {
        await startCapturePromise.catch(() => { })
        startCapturePromise = null
      }
      const wav = stopCapture()
      console.log('[热键识别] 发送 WAV，大小:', wav.byteLength)
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('识别超时（30s）')), 30000),
      )
      const result = await Promise.race([
        window.electronAPI.recognizeWav(wav, prevAppId),
        timeout,
      ])
      console.log('[热键识别] 结果:', result)
      setState('idle')
      if (result) showResult(result)
    } catch (e) {
      console.error('[热键识别] 失败:', e)
      setState('idle')
      showError(String(e))
    }
  })

  // 托盘 VAD 切换
  window.electronAPI.onToggleVad((enabled) => {
    applyVadEnabled(Boolean(enabled), true).catch((e) => showError(String(e)))
  })
  window.electronAPI.onPermissionWarning((message) => {
    if (!message) return
    showError(message)
    console.warn('[权限提醒]', message)
  })

  initVad()
}

// ======================================
//        DASHBOARD (控制台设置窗)
// ======================================
function initDashboardUI() {
  document.getElementById('float-capsule-view')!.classList.remove('active')
  document.getElementById('main-dashboard-view')!.classList.add('active')

  dashboardVadToggle = document.getElementById('dashboard-vad-toggle') as HTMLInputElement | null

  document.getElementById('close-dashboard-btn')!.addEventListener('click', () => {
    window.close() // 直接关闭独立子窗口
  })
  document.getElementById('save-btn')!.addEventListener('click', saveConfig)
  document.getElementById('llm-save-btn')?.addEventListener('click', saveConfig)
  document.getElementById('add-cmd-btn')!.addEventListener('click', () => {
    appendCommandRow(document.getElementById('cmd-editor-list')!)
  })
  document.getElementById('save-cmd-btn')!.addEventListener('click', saveCommands)
  // 热词事件绑定
  document.getElementById('hotword-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = e.target as HTMLInputElement
      addHotword(input.value)
      input.value = ''
    }
  })
  document.getElementById('hotword-search')!.addEventListener('input', (e) => {
    hotwordSearchQuery = (e.target as HTMLInputElement).value
    renderHotwordTags()
  })
  document.getElementById('add-scene-btn')!.addEventListener('click', () => {
    const name = prompt('请输入新场景名称:')
    if (name) {
      hotwordScenes.push({ name, words: [] })
      activeSceneIndex = hotwordScenes.length - 1
      renderSceneTabs()
    }
  })
  document.getElementById('save-hotwords-btn')!.addEventListener('click', saveHotwords)

  // ASR 模式切换
  document.querySelectorAll<HTMLInputElement>('input[name="asr-mode"]').forEach(radio => {
    radio.addEventListener('change', () => updateAsrModeUI(radio.value))
  })
  document.getElementById('asr-mode-api')!.addEventListener('change', () => updateAsrModeUI('api'))
  document.getElementById('asr-mode-local')!.addEventListener('change', () => updateAsrModeUI('local'))

  // 日志清空
  document.getElementById('log-clear-btn')?.addEventListener('click', async () => {
    await window.electronAPI.clearLogs()
    document.getElementById('log-container')!.innerHTML = ''
  })
  document.getElementById('log-copy-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('log-copy-btn') as HTMLButtonElement | null
    if (!btn) return
    const oldText = btn.textContent || '复制'
    try {
      await copyLogsToClipboard()
      btn.textContent = '已复制'
    } catch (e) {
      btn.textContent = '复制失败'
      showError(`复制日志失败: ${String(e)}`)
    } finally {
      setTimeout(() => { btn.textContent = oldText }, 1500)
    }
  })

  dashboardVadToggle?.addEventListener('change', () => {
    setVadEnabled(Boolean(dashboardVadToggle?.checked))
  })

  // 模型下载进度
  window.electronAPI.onModelDownloadProgress((data) => {
    const el = document.getElementById(`dl-progress-${data.modelId}`)
    if (el) {
      if (data.status) {
        el.textContent = data.percent > 0 ? `${data.status} (${data.percent}%)` : data.status
      } else if (data.percent >= 0) {
        el.textContent = `${data.percent}%`
      }
    }
  })

  // 实时日志推送
  window.electronAPI.onLogEntry((entry) => appendLogEntry(entry))

  initTabs()
  loadConfigToForm()
  renderCommandEditor()
  loadHotwords()
  loadLogs()
}

// ── 智能划词重写窗体专用逻辑 ──
function initRewriteUI() {
  document.getElementById('float-capsule-view')!.style.display = 'none'
  document.getElementById('main-dashboard-view')!.style.display = 'none'
  document.getElementById('rewrite-view')!.classList.add('active')

  const originalEl = document.getElementById('rw-original-text') as HTMLTextAreaElement
  const instructEl = document.getElementById('rw-instruction') as HTMLInputElement
  const resultEl = document.getElementById('rw-result-text') as HTMLTextAreaElement
  const statusEl = document.getElementById('rw-status-indicator') as HTMLSpanElement
  const copyBtn = document.getElementById('rw-copy-btn') as HTMLButtonElement
  const replaceBtn = document.getElementById('rw-replace-btn') as HTMLButtonElement
  const cancelBtn = document.getElementById('rw-cancel-btn') as HTMLButtonElement
  const closeBtn = document.getElementById('rw-close-btn') as HTMLButtonElement
  const submitBtn = document.getElementById('rw-submit-btn') as HTMLButtonElement

  window.electronAPI.onInitRewrite((text: string) => {
    originalEl.value = text
    instructEl.value = ''
    resultEl.value = ''
    statusEl.textContent = '等待指令'
    replaceBtn.disabled = true
    instructEl.focus()
  })

  window.electronAPI.onRewriteChunk((chunk: string) => {
    resultEl.value += chunk
    resultEl.scrollTop = resultEl.scrollHeight
  })

  async function doRewrite() {
    const text = originalEl.value
    const instruction = instructEl.value.trim()
    if (!instruction) return

    statusEl.textContent = '生成中...'
    resultEl.value = ''
    submitBtn.disabled = true

    try {
      await window.electronAPI.executeRewrite(text, instruction)
      statusEl.textContent = '生成完成'
      replaceBtn.disabled = false
      replaceBtn.focus()
    } catch (e: any) {
      statusEl.textContent = '出错'
      resultEl.value = '调用错误: ' + String(e)
    } finally {
      submitBtn.disabled = false
    }
  }

  submitBtn.addEventListener('click', doRewrite)
  instructEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRewrite()
  })

  replaceBtn.addEventListener('click', () => {
    window.electronAPI.replaceText(resultEl.value)
  })

  copyBtn.addEventListener('click', () => {
    if (!resultEl.value) return
    window.electronAPI.copyToClipboard(resultEl.value).then(() => {
      const oldText = copyBtn.textContent
      copyBtn.textContent = '已复制!'
      setTimeout(() => { copyBtn.textContent = oldText }, 2000)
    }).catch((e) => {
      showError(`复制失败: ${String(e)}`)
    })
  })

  cancelBtn.addEventListener('click', () => window.electronAPI.closeRewrite())
  closeBtn.addEventListener('click', () => window.electronAPI.closeRewrite())

  // 全局热键干预
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.electronAPI.closeRewrite()
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (!replaceBtn.disabled) {
        window.electronAPI.replaceText(resultEl.value)
      }
    }
  })
}
