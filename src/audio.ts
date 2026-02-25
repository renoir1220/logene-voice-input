import { encodeWav } from './wav'
import type { AudioCaptureConfig } from './types'

let audioCtx: AudioContext | null = null
let mediaStream: MediaStream | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let captureSource: MediaStreamAudioSourceNode | null = null
let captureWorkletNode: AudioWorkletNode | null = null
let pcmSamples: Float32Array[] = []
let isCapturing = false
let captureStopPromise: Promise<ArrayBuffer> | null = null
let workletModuleReady = false
let pendingCaptureFlushResolve: ((elapsedMs: number) => void) | null = null

const CAPTURE_BUFFER_SIZE = 1024
const CAPTURE_WORKLET_NAME = 'pcm-capture-processor'
const PCM_SAMPLE_RATE = 16000

const VAD_SAMPLE_INTERVAL_MS = 50
const VAD_RMS_EMA_ALPHA = 0.28
const VAD_STOP_HYSTERESIS_RATIO = 0.72
const VAD_START_TRIGGER_MS = 100
const VAD_RELEASE_TRIGGER_MS = 120
const VAD_ENDPOINT_HANGOVER_MS = 120

const DEFAULT_AUDIO_CAPTURE_CONFIG: AudioCaptureConfig = {
  inputConstraints: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  postRollMs: 200,
  tailSilenceMs: 120,
  workletFlushTimeoutMs: 220,
}

type AudioCaptureConfigInput = Partial<AudioCaptureConfig> & {
  inputConstraints?: Partial<AudioCaptureConfig['inputConstraints']>
}

let runtimeAudioCaptureConfig: AudioCaptureConfig = cloneAudioCaptureConfig(DEFAULT_AUDIO_CAPTURE_CONFIG)
let inputConstraintVersion = 0
let mediaStreamConstraintVersion = -1
let vadStreamConstraintVersion = -1

function cloneAudioCaptureConfig(config: AudioCaptureConfig): AudioCaptureConfig {
  return {
    inputConstraints: {
      channelCount: config.inputConstraints.channelCount,
      echoCancellation: config.inputConstraints.echoCancellation,
      noiseSuppression: config.inputConstraints.noiseSuppression,
      autoGainControl: config.inputConstraints.autoGainControl,
    },
    postRollMs: config.postRollMs,
    tailSilenceMs: config.tailSilenceMs,
    workletFlushTimeoutMs: config.workletFlushTimeoutMs,
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)))
}

function normalizeAudioCaptureConfig(raw: AudioCaptureConfigInput | null | undefined): AudioCaptureConfig {
  const source = raw ?? {}
  const input = source.inputConstraints ?? {}
  return {
    inputConstraints: {
      channelCount: clampInt(
        Number.isFinite(Number(input.channelCount)) ? Number(input.channelCount) : DEFAULT_AUDIO_CAPTURE_CONFIG.inputConstraints.channelCount,
        1,
        2,
      ),
      echoCancellation: typeof input.echoCancellation === 'boolean'
        ? input.echoCancellation
        : DEFAULT_AUDIO_CAPTURE_CONFIG.inputConstraints.echoCancellation,
      noiseSuppression: typeof input.noiseSuppression === 'boolean'
        ? input.noiseSuppression
        : DEFAULT_AUDIO_CAPTURE_CONFIG.inputConstraints.noiseSuppression,
      autoGainControl: typeof input.autoGainControl === 'boolean'
        ? input.autoGainControl
        : DEFAULT_AUDIO_CAPTURE_CONFIG.inputConstraints.autoGainControl,
    },
    postRollMs: clampInt(
      Number.isFinite(Number(source.postRollMs)) ? Number(source.postRollMs) : DEFAULT_AUDIO_CAPTURE_CONFIG.postRollMs,
      0,
      1200,
    ),
    tailSilenceMs: clampInt(
      Number.isFinite(Number(source.tailSilenceMs)) ? Number(source.tailSilenceMs) : DEFAULT_AUDIO_CAPTURE_CONFIG.tailSilenceMs,
      0,
      1200,
    ),
    workletFlushTimeoutMs: clampInt(
      Number.isFinite(Number(source.workletFlushTimeoutMs))
        ? Number(source.workletFlushTimeoutMs)
        : DEFAULT_AUDIO_CAPTURE_CONFIG.workletFlushTimeoutMs,
      80,
      2000,
    ),
  }
}

function hasInputConstraintChanged(prev: AudioCaptureConfig, next: AudioCaptureConfig): boolean {
  const a = prev.inputConstraints
  const b = next.inputConstraints
  return a.channelCount !== b.channelCount
    || a.echoCancellation !== b.echoCancellation
    || a.noiseSuppression !== b.noiseSuppression
    || a.autoGainControl !== b.autoGainControl
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try { track.stop() } catch { /* ignore */ }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function buildAudioConstraints(config: AudioCaptureConfig): MediaTrackConstraints {
  const channelCount = config.inputConstraints.channelCount
  const constraints: MediaTrackConstraints = {
    channelCount: channelCount === 1 ? { ideal: 1, max: 1 } : { ideal: channelCount },
    echoCancellation: config.inputConstraints.echoCancellation,
    noiseSuppression: config.inputConstraints.noiseSuppression,
    autoGainControl: config.inputConstraints.autoGainControl,
  }
  if (config.inputConstraints.deviceId) {
    constraints.deviceId = { exact: config.inputConstraints.deviceId }
  }
  return constraints
}

function applySpeechContentHint(stream: MediaStream, reason: 'capture' | 'vad'): void {
  const track = stream.getAudioTracks()[0]
  if (!track) return

  const withHint = track as MediaStreamTrack & { contentHint?: string }
  try {
    withHint.contentHint = 'speech-recognition'
  } catch {
    try {
      withHint.contentHint = 'speech'
    } catch {
      // ignore unsupported contentHint
    }
  }

  console.debug(`[录音] 已设置 contentHint (${reason}): ${withHint.contentHint || 'N/A'}`)
}

function logTrackDiagnostics(stream: MediaStream, reason: 'capture' | 'vad', requested: MediaTrackConstraints): void {
  const track = stream.getAudioTracks()[0]
  if (!track) return
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  const constraints = typeof track.getConstraints === 'function' ? track.getConstraints() : {}
  const withHint = track as MediaStreamTrack & { contentHint?: string }
  console.debug(
    `[录音] ${reason} 音轨参数: requested=${safeJson(requested)}, ` +
    `constraints=${safeJson(constraints)}, settings=${safeJson(settings)}, ` +
    `contentHint=${withHint.contentHint || 'N/A'}`,
  )
}

export function setAudioCaptureConfig(raw: AudioCaptureConfigInput | null | undefined): void {
  const next = normalizeAudioCaptureConfig(raw)
  const prev = runtimeAudioCaptureConfig
  const constraintsChanged = hasInputConstraintChanged(prev, next)

  runtimeAudioCaptureConfig = next

  if (constraintsChanged) {
    inputConstraintVersion += 1
    if (!isCapturing) {
      stopStream(mediaStream)
      mediaStream = null
      mediaStreamConstraintVersion = -1
    }
    if (!vadTimer) {
      stopStream(vadStream)
      vadStream = null
      vadStreamConstraintVersion = -1
    }
  }

  console.debug(
    `[录音] 采集配置已更新: postRollMs=${next.postRollMs}, tailSilenceMs=${next.tailSilenceMs}, ` +
    `flushTimeoutMs=${next.workletFlushTimeoutMs}, input=${safeJson(next.inputConstraints)}`,
  )
}

// 初始化麦克风
async function initMic(): Promise<void> {
  if (mediaStream && mediaStreamConstraintVersion === inputConstraintVersion) return
  if (mediaStream) {
    stopStream(mediaStream)
    mediaStream = null
  }

  const constraints = buildAudioConstraints(runtimeAudioCaptureConfig)
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  } catch (e) {
    const err = e as DOMException
    console.error(`[录音] 麦克风初始化失败: ${err.name}: ${err.message}`)
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      throw new Error('未检测到麦克风设备，请连接麦克风后重试')
    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error('麦克风权限被拒绝，请在系统设置中允许访问麦克风')
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      throw new Error('麦克风被其他应用占用或无法读取，请关闭其他录音程序后重试')
    } else {
      throw new Error(`麦克风初始化失败: ${err.message || err.name}`)
    }
  }
  mediaStreamConstraintVersion = inputConstraintVersion
  applySpeechContentHint(mediaStream, 'capture')
  logTrackDiagnostics(mediaStream, 'capture', constraints)
}

async function initVadMic(): Promise<void> {
  if (vadStream && vadStreamConstraintVersion === inputConstraintVersion) return
  if (vadStream) {
    stopStream(vadStream)
    vadStream = null
  }

  const constraints = buildAudioConstraints(runtimeAudioCaptureConfig)
  vadStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
  vadStreamConstraintVersion = inputConstraintVersion
  applySpeechContentHint(vadStream, 'vad')
  logTrackDiagnostics(vadStream, 'vad', constraints)
}

// 开始采集 PCM
export async function startCapture(): Promise<void> {
  if (captureStopPromise) {
    try { await captureStopPromise } catch { /* ignore */ }
  }
  if (isCapturing) return

  await initMic()

  // 复用已有 AudioContext，避免 Windows 上每次重建的延迟
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
    workletModuleReady = false
  }
  await audioCtx.resume()
  captureSource = audioCtx.createMediaStreamSource(mediaStream!)
  pcmSamples = []
  isCapturing = true

  captureWorkletNode = await createCaptureWorkletNode(audioCtx)
  if (captureWorkletNode) {
    captureSource.connect(captureWorkletNode)
  } else {
    // Fallback: 在不支持 AudioWorklet 的环境退回 ScriptProcessor。
    scriptProcessor = audioCtx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1)
    scriptProcessor.onaudioprocess = (e) => {
      if (!isCapturing) return
      const data = e.inputBuffer.getChannelData(0)
      pcmSamples.push(new Float32Array(data))
    }
    captureSource.connect(scriptProcessor)
    scriptProcessor.connect(audioCtx.destination)
  }

  console.log('[录音] 开始采集，AudioContext state:', audioCtx.state)
}

function countSamples(chunks: Float32Array[]): number {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  return total
}

// 停止采集，返回 WAV ArrayBuffer
export async function stopCapture(): Promise<ArrayBuffer> {
  if (captureStopPromise) return captureStopPromise

  captureStopPromise = (async () => {
    const stopStartAt = Date.now()
    const processor = scriptProcessor
    const source = captureSource
    const ctx = audioCtx
    const workletNode = captureWorkletNode
    const captureCfg = cloneAudioCaptureConfig(runtimeAudioCaptureConfig)

    if (!ctx) {
      isCapturing = false
      scriptProcessor = null
      captureSource = null
      captureWorkletNode = null
      audioCtx = null
      const chunks = pcmSamples
      pcmSamples = []
      const chunksWithTail = appendTailSilence(chunks, PCM_SAMPLE_RATE, captureCfg.tailSilenceMs)
      const wav = encodeWav(chunksWithTail)
      const durationMs = Math.round((countSamples(chunksWithTail) / PCM_SAMPLE_RATE) * 1000)
      console.log(
        `[录音] 停止采集(空上下文)，chunks=${chunks.length}，durationMs=${durationMs}，` +
        `tailSilenceMs=${captureCfg.tailSilenceMs}，WAV=${wav.byteLength} 字节`,
      )
      return wav
    }

    // 为句尾保留短暂 post-roll，降低最后字被截断的概率。
    if (captureCfg.postRollMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, captureCfg.postRollMs))
    }

    let flushWaitMs = 0
    if (workletNode) {
      flushWaitMs = await requestCaptureWorkletFlush(workletNode, captureCfg.workletFlushTimeoutMs)
    }
    isCapturing = false

    // 先清空旧 worklet 的消息处理器，防止延迟消息污染下次录音
    if (workletNode) workletNode.port.onmessage = null
    try { source?.disconnect() } catch { /* ignore */ }
    try { workletNode?.disconnect() } catch { /* ignore */ }
    try { processor?.disconnect() } catch { /* ignore */ }
    scriptProcessor = null
    captureSource = null
    captureWorkletNode = null
    // AudioContext 保留复用，不关闭（避免 Windows 上重建延迟）

    const chunks = pcmSamples
    pcmSamples = []
    const chunksWithTail = appendTailSilence(chunks, PCM_SAMPLE_RATE, captureCfg.tailSilenceMs)
    const wav = encodeWav(chunksWithTail)
    const durationMs = Math.round((countSamples(chunksWithTail) / PCM_SAMPLE_RATE) * 1000)
    const stopElapsedMs = Date.now() - stopStartAt
    console.log(
      `[录音] 停止采集，chunks=${chunks.length}，durationMs=${durationMs}，` +
      `postRollMs=${captureCfg.postRollMs}，tailSilenceMs=${captureCfg.tailSilenceMs}，` +
      `flushWaitMs=${flushWaitMs}，stopElapsedMs=${stopElapsedMs}，WAV=${wav.byteLength} 字节`,
    )
    return wav
  })().finally(() => {
    captureStopPromise = null
  })

  return captureStopPromise
}

function appendTailSilence(chunks: Float32Array[], sampleRate: number, tailSilenceMs: number): Float32Array[] {
  if (chunks.length === 0) return chunks
  const tailSamples = Math.max(0, Math.round((sampleRate * tailSilenceMs) / 1000))
  if (tailSamples <= 0) return chunks
  return [...chunks, new Float32Array(tailSamples)]
}

async function createCaptureWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function') {
    return null
  }

  try {
    if (!workletModuleReady) {
      await ctx.audioWorklet.addModule('/worklets/pcm-capture-processor.js')
      workletModuleReady = true
    }
    const node = new AudioWorkletNode(ctx, CAPTURE_WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: {
        chunkSize: CAPTURE_BUFFER_SIZE,
      },
    })
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      const payload = event.data
      if (payload && typeof payload === 'object' && (payload as { type?: string }).type === 'flushed') {
        pendingCaptureFlushResolve?.(Date.now())
        return
      }
      if (!isCapturing) return
      if (payload instanceof Float32Array) {
        pcmSamples.push(payload)
      }
    }
    return node
  } catch (e) {
    console.warn(`[录音] AudioWorklet 初始化失败，回退 ScriptProcessor: ${String(e)}`)
    return null
  }
}

async function requestCaptureWorkletFlush(node: AudioWorkletNode, timeoutMs: number): Promise<number> {
  if (pendingCaptureFlushResolve) {
    pendingCaptureFlushResolve(Date.now())
  }

  return new Promise<number>((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const finish = (finishedAt: number) => {
      if (settled) return
      settled = true
      if (pendingCaptureFlushResolve === finish) {
        pendingCaptureFlushResolve = null
      }
      clearTimeout(timer)
      resolve(Math.max(0, finishedAt - startedAt))
    }
    const timer = setTimeout(() => finish(Date.now()), timeoutMs)
    pendingCaptureFlushResolve = finish
    try {
      node.port.postMessage({ type: 'flush' })
    } catch {
      finish(Date.now())
    }
  })
}

// ── VAD（渲染进程实现） ──

export interface VadState {
  enabled: boolean
  threshold: number
  silenceMs: number
  minSpeechMs: number
}

export interface VadCallbacks {
  getState: () => string
  setState: (state: string, text?: string) => void
  showError: (msg: string) => void
  showResult: (text: string) => void
  captureFocusSnapshot: (reason: string) => Promise<string | null>
  recognizeWav: (wav: ArrayBuffer, prevAppId: string | null) => Promise<string>
}

let vadAudioCtx: AudioContext | null = null
let vadAnalyser: AnalyserNode | null = null
let vadSource: MediaStreamAudioSourceNode | null = null
let vadStream: MediaStream | null = null
let vadTimer: ReturnType<typeof setInterval> | null = null
let vadSpeakingStart = 0
let vadSilenceStart = 0
let vadIsSpeaking = false
let vadIsProcessing = false
let vadCapturePromise: Promise<void> | null = null
let vadPrevAppId: string | null = null
let vadSmoothedRms = 0
let vadAboveThresholdSince = 0
let vadBelowThresholdSince = 0

export async function startVad(vadState: VadState, cb: VadCallbacks): Promise<void> {
  if (!vadState.enabled || vadIsProcessing || vadTimer) return

  await initVadMic()
  vadAudioCtx = new AudioContext({ sampleRate: PCM_SAMPLE_RATE })
  await vadAudioCtx.resume()
  vadAnalyser = vadAudioCtx.createAnalyser()
  vadAnalyser.fftSize = 2048
  vadSource = vadAudioCtx.createMediaStreamSource(vadStream!)
  vadSource.connect(vadAnalyser)

  const dataArray = new Float32Array(vadAnalyser.fftSize)

  vadTimer = setInterval(() => {
    if (!vadAnalyser || vadIsProcessing) return
    if (!vadIsSpeaking && cb.getState() !== 'idle') return

    vadAnalyser.getFloatTimeDomainData(dataArray)
    let sum = 0
    for (const v of dataArray) sum += v * v
    const rms = Math.sqrt(sum / dataArray.length)
    vadSmoothedRms = vadSmoothedRms === 0
      ? rms
      : vadSmoothedRms + VAD_RMS_EMA_ALPHA * (rms - vadSmoothedRms)

    const now = Date.now()
    const startThreshold = Math.max(0.0001, vadState.threshold)
    const stopThreshold = Math.max(0.00005, startThreshold * VAD_STOP_HYSTERESIS_RATIO)

    if (!vadIsSpeaking) {
      if (vadSmoothedRms > startThreshold) {
        if (!vadAboveThresholdSince) vadAboveThresholdSince = now
        if (now - vadAboveThresholdSince >= VAD_START_TRIGGER_MS) {
          vadIsSpeaking = true
          vadSpeakingStart = now
          vadSilenceStart = now
          vadAboveThresholdSince = 0
          vadBelowThresholdSince = 0

          void cb.captureFocusSnapshot('vad-speech-start')
            .then((appId) => { if (vadIsSpeaking) vadPrevAppId = appId })
            .catch(() => { if (vadIsSpeaking) vadPrevAppId = null })

          vadCapturePromise = startCapture().catch((e) => {
            vadIsSpeaking = false
            vadCapturePromise = null
            vadPrevAppId = null
            cb.setState('idle')
            cb.showError(String(e))
            throw e
          })
          cb.setState('recording')
        }
      } else {
        vadAboveThresholdSince = 0
      }
      return
    }

    if (vadSmoothedRms > stopThreshold) {
      vadSilenceStart = now
      vadBelowThresholdSince = 0
      return
    }

    if (!vadBelowThresholdSince) {
      vadBelowThresholdSince = now
      return
    }
    if (now - vadBelowThresholdSince < VAD_RELEASE_TRIGGER_MS) {
      return
    }

    const effectiveSilenceMs = vadState.silenceMs + VAD_ENDPOINT_HANGOVER_MS
    if (now - vadSilenceStart <= effectiveSilenceMs) {
      return
    }

    vadIsSpeaking = false
    vadBelowThresholdSince = 0
    const speechDuration = vadSilenceStart - vadSpeakingStart
    const captureReady = vadCapturePromise
    const prevAppId = vadPrevAppId
    vadCapturePromise = null
    vadPrevAppId = null
    vadIsProcessing = true

    Promise.resolve(captureReady)
      .catch(() => null)
      .then(async () => {
        if (speechDuration < vadState.minSpeechMs) {
          await stopCapture()
          cb.setState('idle')
          return
        }
        cb.setState('recognizing')
        const wav = await stopCapture()
        return cb.recognizeWav(wav, prevAppId)
          .then(result => {
            cb.setState('idle')
            if (result) cb.showResult(result)
          })
          .catch(e => {
            cb.setState('idle')
            cb.showError(String(e))
          })
      })
      .finally(() => {
        vadIsProcessing = false
      })
  }, VAD_SAMPLE_INTERVAL_MS)
}

// 重置 VAD 语音状态（手动点击停止录音时调用，避免 VAD 状态机卡死）
export function resetVadSpeakingState(): void {
  if (!vadIsSpeaking && !vadIsProcessing) return
  vadIsSpeaking = false
  vadIsProcessing = false
  vadCapturePromise = null
  vadPrevAppId = null
  vadSpeakingStart = 0
  vadSilenceStart = 0
  vadSmoothedRms = 0
  vadAboveThresholdSince = 0
  vadBelowThresholdSince = 0
}

export function stopVad(): void {
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null }
  try { vadSource?.disconnect() } catch { /* ignore */ }
  vadSource = null
  void vadAudioCtx?.close()
  vadAudioCtx = null
  vadAnalyser = null
  if (vadIsSpeaking) {
    void stopCapture().catch(() => { })
  }
  vadCapturePromise = null
  vadPrevAppId = null
  vadSpeakingStart = 0
  vadSilenceStart = 0
  vadIsSpeaking = false
  vadIsProcessing = false
  vadSmoothedRms = 0
  vadAboveThresholdSince = 0
  vadBelowThresholdSince = 0
}
