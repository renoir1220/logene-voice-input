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
  recognizeWav: (wavBuffer: ArrayBuffer, prevAppId: string | null) =>
    ipcRenderer.invoke('recognize-wav', wavBuffer, prevAppId),
  switchMode: (mode: 'float' | 'dashboard') => ipcRenderer.invoke('switch-mode', mode),
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x: number, y: number) => ipcRenderer.invoke('set-window-position', x, y),

  // 模型管理
  getModelStatuses: () => ipcRenderer.invoke('get-model-statuses'),
  getModelCatalog: () => ipcRenderer.invoke('get-model-catalog'),
  downloadModel: (modelId: string) => ipcRenderer.invoke('download-model', modelId),
  deleteModel: (modelId: string) => ipcRenderer.invoke('delete-model', modelId),

  // 日志
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text),

  // 重写专用通道
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  closeRewrite: () => ipcRenderer.invoke('close-rewrite'),
  executeRewrite: (text: string, instruction: string) => ipcRenderer.invoke('execute-rewrite', text, instruction),
  replaceText: (newText: string) => ipcRenderer.invoke('replace-text', newText),

  // 主进程 → 渲染进程（on，事件监听）
  onHotkeyState: (cb: (state: string) => void) => {
    ipcRenderer.on('hotkey-state', (_e, state) => cb(state))
  },
  onHotkeyResult: (cb: (result: string) => void) => {
    ipcRenderer.on('hotkey-result', (_e, result) => cb(result))
  },
  onToggleVad: (cb: (enabled: boolean) => void) => {
    ipcRenderer.on('toggle-vad', (_e, enabled) => cb(Boolean(enabled)))
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
  }
})
