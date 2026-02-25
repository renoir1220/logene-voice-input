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
      setVadThreshold: (threshold: number) => Promise<number>
      getAsrRuntimeStatus: () => Promise<AsrRuntimeStatus>
      recognizeWav: (wavBuffer: ArrayBuffer, prevAppId: string | null) => Promise<string>
      openDashboard: () => Promise<void>
      showFloatContextMenu: () => Promise<void>
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
      getStats: () => Promise<DailyStats>
      getRecentHistory: (limit?: number) => Promise<RecognitionRecord[]>
      getAllHistory: (offset?: number, limit?: number) => Promise<RecognitionRecord[]>
      generateDailySummary: (date: string) => Promise<string>
      reportRendererError: (payload: {
        kind: string
        message: string
        stack?: string
        source?: string
        lineno?: number
        colno?: number
        reason?: string
      }) => Promise<boolean>
      restartApp: () => Promise<boolean>
      onHotkeyState: (cb: (state: string) => void) => void
      onToggleVad: (cb: (enabled: boolean) => void) => void
      onVadThresholdUpdated: (cb: (threshold: number) => void) => void
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
      onRecognitionAdded: (cb: () => void) => void
    }
  }
}

export interface HotwordScene {
  name: string
  words: string[]
}

export interface SizeExpressionRuleOptions {
  multiplicationWords: string[]
  rangeWords: string[]
  outputUnit: string
}

export interface TextRuleConfig {
  id: string
  name: string
  enabled: boolean
  type: 'sizeExpressionNormalize'
  options: SizeExpressionRuleOptions
}

export interface TextRulesConfig {
  enabled: boolean
  rules: TextRuleConfig[]
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

export interface LlmModelConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

export interface LlmConfig {
  enabled: boolean
  asrPostProcessEnabled: boolean
  models: LlmModelConfig[]
  taskBindings: {
    rewrite: string
    asrPostProcess: string
    dailySummary: string
  }
  prompts: {
    rewrite: LlmTaskPromptConfig
    asrPostProcess: LlmTaskPromptConfig
    dailySummary: LlmTaskPromptConfig
  }
}

export interface LlmTaskPromptConfig {
  systemPrompt: string
  userPromptTemplate: string
}

export interface AudioInputConstraintsConfig {
  channelCount: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  deviceId?: string
}

export interface AudioCaptureConfig {
  inputConstraints: AudioInputConstraintsConfig
  postRollMs: number
  tailSilenceMs: number
  workletFlushTimeoutMs: number
}

export interface OnboardingConfig {
  completed: boolean
  completedAt: string
  version: number
}

// 配置类型（与主进程保持一致）
export interface AppConfig {
  server: { url: string; asrConfigId: string }
  hotkey: { record: string }
  input: { useClipboard: boolean }
  audioCapture: AudioCaptureConfig
  vad: { enabled: boolean; speechThreshold: number; silenceTimeoutMs: number; minSpeechDurationMs: number }
  voiceCommands: Record<string, string>
  hotwords: HotwordScene[]
  textRules: TextRulesConfig
  asr: { mode: 'api' | 'local'; localModel: string; puncEnabled: boolean }
  onboarding?: OnboardingConfig
  llm: LlmConfig
  logging: { enableDebug: boolean }
}

export type RecordState = 'idle' | 'recording' | 'recognizing' | 'success'

export interface DailyStats {
  todayCount: number
  todayChars: number
  totalCount: number
  totalChars: number
}

export interface RecognitionRecord {
  id: number
  created_at: string
  text: string
  char_count: number
  mode: string
  is_command: number
  command_shortcut: string | null
}
