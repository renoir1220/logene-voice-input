import { contextBridge, ipcRenderer } from 'electron'

// 通过 contextBridge 暴露安全的 IPC API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 渲染进程 → 主进程（invoke，有返回值）
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  getFrontmostApp: () => ipcRenderer.invoke('get-frontmost-app'),
  captureFocusSnapshot: (reason?: string) => ipcRenderer.invoke('capture-focus-snapshot', reason),
  restoreFocus: (appId: string | null) => ipcRenderer.invoke('restore-focus', appId),
  getVadEnabled: () => ipcRenderer.invoke('get-vad-enabled'),
  setVadEnabled: (enabled: boolean) => ipcRenderer.invoke('set-vad-enabled', enabled),
  getAsrRuntimeStatus: () => ipcRenderer.invoke('get-asr-runtime-status'),
  recognizeWav: (wavBuffer: ArrayBuffer, prevAppId: string | null) =>
    ipcRenderer.invoke('recognize-wav', wavBuffer, prevAppId),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x: number, y: number) => ipcRenderer.invoke('set-window-position', x, y),
  setIgnoreMouseEvents: (ignore: boolean, opts?: { forward: boolean }) =>
    ipcRenderer.invoke('set-ignore-mouse-events', ignore, opts),

  // 模型管理
  getModelStatuses: () => ipcRenderer.invoke('get-model-statuses'),
  getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
  downloadModel: (modelId: string) => ipcRenderer.invoke('download-model', modelId),
  deleteModel: (modelId: string) => ipcRenderer.invoke('delete-model', modelId),

  // 日志
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text),

  // 统计与历史
  getStats: () => ipcRenderer.invoke('get-stats'),
  getRecentHistory: (limit?: number) => ipcRenderer.invoke('get-recent-history', limit),
  getAllHistory: (offset?: number, limit?: number) => ipcRenderer.invoke('get-all-history', offset, limit),
  generateDailySummary: (date: string) => ipcRenderer.invoke('generate-daily-summary', date),
  reportRendererError: (payload: {
    kind: string
    message: string
    stack?: string
    source?: string
    lineno?: number
    colno?: number
    reason?: string
  }) => ipcRenderer.invoke('report-renderer-error', payload),
  checkMicPermission: () => ipcRenderer.invoke('check-mic-permission'),
  restartApp: () => ipcRenderer.invoke('restart-app'),

  // 重写专用通道
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  closeRewrite: () => ipcRenderer.invoke('close-rewrite'),
  executeRewrite: (text: string, instruction: string) => ipcRenderer.invoke('execute-rewrite', text, instruction),
  replaceText: (newText: string) => ipcRenderer.invoke('replace-text', newText),

  // 主进程 → 渲染进程（on，事件监听）
  onHotkeyState: (cb: (state: string) => void) => {
    ipcRenderer.on('hotkey-state', (_e, state) => cb(state))
  },
  onToggleVad: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('toggle-vad', (_e, enabled) => cb(Boolean(enabled)))
  },
  onAsrRuntimeStatus: (cb: (status: {
    phase: 'idle' | 'starting' | 'ready' | 'error'
    modelId: string | null
    progress: number
    message: string
    updatedAt: string
  }) => void) => {
    ipcRenderer.on('asr-runtime-status', (_e, status) => cb(status))
  },
  // 热键触发停止录音（toggle 模式）
  onHotkeyStopRecording: (cb: (prevAppId: string | null) => void) => {
    ipcRenderer.on('hotkey-stop-recording', (_e, prevAppId) => cb(prevAppId))
  },
  // 模型下载进度
  onModelDownloadProgress: (cb: (data: { modelId: string; percent: number }) => void) => {
    ipcRenderer.on('model-download-progress', (_e, data) => cb(data))
  },
  // 实时日志推送
  onLogEntry: (cb: (entry: { time: string; level: string; msg: string }) => void) => {
    ipcRenderer.on('log-entry', (_e, entry) => cb(entry))
  },
  onPermissionWarning: (cb: (message: string) => void) => {
    ipcRenderer.on('permission-warning', (_e, message) => cb(String(message || '')))
  },
  // 重写界面事件
  onInitRewrite: (cb: (text: string) => void) => {
    ipcRenderer.on('init-rewrite', (_e, text) => cb(text))
  },
  onRewriteChunk: (cb: (chunk: string) => void) => {
    ipcRenderer.on('rewrite-chunk', (_e, chunk) => cb(chunk))
  },
  // 识别记录新增通知
  onRecognitionAdded: (cb: () => void) => {
    ipcRenderer.on('recognition-added', () => cb())
  }
})
