import type { ModelStatus, ModelCatalogItem, LogEntry } from './types'
import { withTimeout } from './utils'

// ── 模型管理 ──

let currentSelectedModel = 'paraformer-zh-contextual-quant'

function getBrokenDeps(model: ModelStatus): Array<{ role: string; issue: string }> {
  return (model.dependencies || [])
    .filter(dep => !dep.complete)
    .map(dep => ({ role: dep.role, issue: dep.issue || '模型文件不完整' }))
}

export function updateModelIntegrityIndicators(models: ModelStatus[]) {
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
  tip.textContent = `检测到模型文件不完整：${names}。请点击"重新下载"修复。`
}

export function setModelListHint(message = '', withRetry = false) {
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

function mergeStatusesById(base: ModelStatus[], statuses: ModelStatus[]): ModelStatus[] {
  const map = new Map<string, ModelStatus>()
  for (const status of statuses) {
    if (status && typeof status.id === 'string') {
      map.set(status.id, status)
    }
  }
  return base.map((item) => {
    const status = map.get(item.id)
    if (!status) return item
    return {
      ...item,
      downloaded: Boolean(status.downloaded),
      incomplete: Boolean(status.incomplete),
      dependencies: Array.isArray(status.dependencies) ? status.dependencies : [],
    }
  })
}

function renderModelCards(container: HTMLElement, models: ModelStatus[]) {
  container.innerHTML = ''
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
}

export async function renderModelList(selectedModel?: string) {
  const container = document.getElementById('model-list')
  if (!container) return
  if (selectedModel) currentSelectedModel = selectedModel
  container.innerHTML = ''
  setModelListHint('正在加载模型列表...')
  try {
    const catalog = await withTimeout(window.electronAPI.getModelCatalog(), 2000, 'get-model-catalog')
    if (!Array.isArray(catalog) || catalog.length === 0) {
      updateModelIntegrityIndicators([])
      setModelListHint('模型列表加载失败，请重试。', true)
      return
    }

    const baseModels = mapCatalogToStatuses(catalog)
    updateModelIntegrityIndicators([])
    renderModelCards(container, baseModels)
    setModelListHint('正在检查本地模型状态...')

    let finalModels = baseModels
    let fallbackUsed = false
    try {
      const statuses = await withTimeout(window.electronAPI.getModelStatuses(), 4000, 'get-model-statuses')
      if (Array.isArray(statuses) && statuses.length > 0) {
        finalModels = mergeStatusesById(baseModels, statuses)
      } else {
        fallbackUsed = true
      }
    } catch (e) {
      fallbackUsed = true
      console.warn('[Model] get-model-statuses failed:', e)
    }

    updateModelIntegrityIndicators(finalModels)
    renderModelCards(container, finalModels)
    if (fallbackUsed) {
      setModelListHint('模型状态读取失败，已显示基础模型列表。你仍可点击"准备模型"继续。', true)
    } else {
      setModelListHint('')
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

export function appendLogEntry(entry: LogEntry) {
  const container = document.getElementById('log-container')
  if (!container) return
  const div = document.createElement('div')
  div.className = 'log-entry'
  const time = entry.time.slice(11, 23)
  const levelClass = `log-level-${entry.level}`
  div.innerHTML = `<span class="log-time">${time}</span> <span class="${levelClass}">[${entry.level.toUpperCase()}]</span> <span class="log-msg">${escapeHtml(entry.msg)}</span>`
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function loadLogs() {
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

export async function copyLogsToClipboard() {
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
