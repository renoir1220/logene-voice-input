import {
  initDashboardElements,
  setVadEnabled,
  applyAsrRuntimeStatus,
  refreshAsrRuntimeStatus,
  showError,
} from '../ui-state'
import {
  initTabs,
  loadConfigToForm,
  saveConfig,
  appendCommandRow,
  saveCommands,
  renderCommandEditor,
  loadHotwords,
  addHotword,
  addScene,
  renderHotwordTags,
  saveHotwords,
  updateAsrModeUI,
  setHotwordSearchQuery,
} from '../dashboard-config'
import {
  appendLogEntry,
  loadLogs,
  copyLogsToClipboard,
  setModelListHint,
} from '../dashboard-models'

export function initDashboardUI() {
  document.getElementById('float-capsule-view')!.classList.remove('active')
  document.getElementById('main-dashboard-view')!.classList.add('active')

  initDashboardElements()

  const dashboardVadToggle = document.getElementById('dashboard-vad-toggle') as HTMLInputElement | null

  document.getElementById('close-dashboard-btn')!.addEventListener('click', () => {
    window.close()
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
    setHotwordSearchQuery((e.target as HTMLInputElement).value)
    renderHotwordTags()
  })
  document.getElementById('add-scene-btn')!.addEventListener('click', () => {
    addScene()
  })
  document.getElementById('save-hotwords-btn')!.addEventListener('click', saveHotwords)

  // ASR 模式切换
  document.querySelectorAll<HTMLInputElement>('input[name="asr-mode"]').forEach(radio => {
    radio.addEventListener('change', () => updateAsrModeUI(radio.value))
  })
  document.getElementById('asr-mode-api')!.addEventListener('change', () => updateAsrModeUI('api'))
  document.getElementById('asr-mode-local')!.addEventListener('change', () => updateAsrModeUI('local'))

  // 日志
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
  window.electronAPI.onAsrRuntimeStatus((status) => {
    applyAsrRuntimeStatus(status)
    if (status.phase === 'starting') {
      const suffix = status.progress > 0 ? ` (${status.progress}%)` : ''
      setModelListHint(`本地识别启动中${suffix}：${status.message || '请稍候'}`)
    } else if (status.phase === 'error') {
      setModelListHint(`本地识别启动失败：${status.message}`, true)
    }
  })
  void refreshAsrRuntimeStatus()

  initTabs()
  loadConfigToForm()
  renderCommandEditor()
  loadHotwords()
  loadLogs()
}
