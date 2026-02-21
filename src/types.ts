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
      getAsrRuntimeStatus: () => Promise<AsrRuntimeStatus>
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
      reportRendererError: (payload: {
        kind: string
        message: string
        stack?: string
        source?: string
        lineno?: number
        colno?: number
        reason?: string
      }) => Promise<boolean>
      onHotkeyState: (cb: (state: string) => void) => void
      onHotkeyResult: (cb: (result: string) => void) => void
      onToggleVad: (cb: (enabled: boolean) => void) => void
      onAsrRuntimeStatus: (cb: (status: AsrRuntimeStatus) => void) => void
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

export interface HotwordScene {
  name: string
  words: string[]
}

export interface ModelStatus {
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

export interface ModelCatalogItem {
  id: string
  name: string
  description: string
  size: string
}

export interface LogEntry {
  time: string
  level: string
  msg: string
}

export interface AsrRuntimeStatus {
  phase: 'idle' | 'starting' | 'ready' | 'error'
  modelId: string | null
  progress: number
  message: string
  updatedAt: string
}

// 配置类型（与主进程保持一致）
export interface AppConfig {
  server: { url: string; asrConfigId: string }
  hotkey: { record: string }
  input: { useClipboard: boolean }
  vad: { enabled: boolean; speechThreshold: number; silenceTimeoutMs: number; minSpeechDurationMs: number }
  voiceCommands: Record<string, string>
  hotwords: HotwordScene[]
  asr: { mode: 'api' | 'local'; localModel: string }
  llm: { enabled: boolean; baseUrl: string; apiKey: string; model: string }
}

export type RecordState = 'idle' | 'recording' | 'recognizing' | 'success'
