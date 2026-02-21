import { encodeWav } from './wav'

let audioCtx: AudioContext | null = null
let mediaStream: MediaStream | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let pcmSamples: Float32Array[] = []
let isCapturing = false

// 初始化麦克风
async function initMic(): Promise<void> {
  if (mediaStream) return
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
}

// 开始采集 PCM
export async function startCapture(): Promise<void> {
  await initMic()
  audioCtx = new AudioContext({ sampleRate: 16000 })
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
export function stopCapture(): ArrayBuffer {
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
let vadStream: MediaStream | null = null
let vadTimer: ReturnType<typeof setInterval> | null = null
let vadSpeakingStart = 0
let vadSilenceStart = 0
let vadIsSpeaking = false
let vadIsProcessing = false
let vadCapturePromise: Promise<void> | null = null
let vadPrevAppId: string | null = null

export async function startVad(vadState: VadState, cb: VadCallbacks): Promise<void> {
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
    if (!vadIsSpeaking && cb.getState() !== 'idle') return
    vadAnalyser.getFloatTimeDomainData(dataArray)
    let sum = 0
    for (const v of dataArray) sum += v * v
    const rms = Math.sqrt(sum / dataArray.length)

    const now = Date.now()
    if (rms > vadState.threshold) {
      if (!vadIsSpeaking) {
        vadIsSpeaking = true
        vadSpeakingStart = now
        vadSilenceStart = now
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
      vadSilenceStart = now
    } else if (vadIsSpeaking) {
      if (now - vadSilenceStart > vadState.silenceMs) {
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
              cb.setState('idle')
              return
            }
            cb.setState('recognizing')
            const wav = stopCapture()
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
      }
    }
  }, 50)
}

export function stopVad(): void {
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
