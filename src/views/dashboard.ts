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
  addLlmModel,
  addTextRule,
  updateAsrModeUI,
  setHotwordSearchQuery,
} from '../dashboard-config'
import {
  appendLogEntry,
  loadLogs,
  copyLogsToClipboard,
  setLogLevelEnabled,
  clearLogViewCache,
  setModelListHint,
} from '../dashboard-models'
import { initFirstUseOnboarding } from './onboarding'

import { marked } from 'marked'
import type { RecognitionRecord } from '../types'

export function initDashboardUI() {
  document.getElementById('float-capsule-view')!.classList.remove('active')
  document.getElementById('main-dashboard-view')!.classList.add('active')

  initDashboardElements()

  const dashboardVadToggle = document.getElementById('dashboard-vad-toggle') as HTMLInputElement | null

  document.getElementById('save-btn')!.addEventListener('click', saveConfig)
  document.getElementById('save-text-rules-btn')?.addEventListener('click', saveConfig)
  document.getElementById('llm-save-btn')?.addEventListener('click', saveConfig)
  document.getElementById('llm-add-model-btn')?.addEventListener('click', addLlmModel)
  document.getElementById('add-text-rule-btn')?.addEventListener('click', addTextRule)

  // 二级 tab 切换
  document.querySelectorAll<HTMLButtonElement>('.sub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.closest('.tab-pane')
      if (!parent) return
      parent.querySelectorAll<HTMLButtonElement>('.sub-tab').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      parent.querySelectorAll<HTMLDivElement>('.sub-tab-pane').forEach(p => p.classList.remove('active'))
      const target = btn.dataset.subtab
      if (target) document.getElementById(`subtab-${target}`)?.classList.add('active')
    })
  })
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
  document.getElementById('log-filter-debug')?.addEventListener('change', (e) => {
    setLogLevelEnabled('debug', (e.target as HTMLInputElement).checked)
  })
  document.getElementById('log-filter-error')?.addEventListener('change', (e) => {
    setLogLevelEnabled('error', (e.target as HTMLInputElement).checked)
  })
  document.getElementById('log-filter-warn')?.addEventListener('change', (e) => {
    setLogLevelEnabled('warn', (e.target as HTMLInputElement).checked)
  })
  document.getElementById('log-filter-info')?.addEventListener('change', (e) => {
    setLogLevelEnabled('info', (e.target as HTMLInputElement).checked)
  })
  document.getElementById('log-clear-btn')?.addEventListener('click', async () => {
    await window.electronAPI.clearLogs()
    clearLogViewCache()
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
  // 识别记录新增时刷新统计和历史
  window.electronAPI.onRecognitionAdded(() => {
    loadStats()
    loadFullHistory(true)
  })
  void refreshAsrRuntimeStatus()

  initTabs()
  loadConfigToForm()
  void initFirstUseOnboarding()
  renderCommandEditor()
  loadHotwords()
  loadLogs()
  loadStats()
  initHistoryTab()
}

/** 加载统计数据和历史记录 */
async function loadStats() {
  try {
    const stats = await window.electronAPI.getStats()
    setText('stat-today-count', String(stats.todayCount))
    setText('stat-today-chars', String(stats.todayChars))
    setText('stat-total-count', String(stats.totalCount))
  } catch { /* 静默 */ }

  try {
    const history = await window.electronAPI.getRecentHistory(30)
    renderHistory(history)
  } catch { /* 静默 */ }
}

function setText(id: string, text: string) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function renderHistory(records: RecognitionRecord[]) {
  const container = document.getElementById('history-list')
  if (!container) return
  if (records.length === 0) {
    container.innerHTML = '<div class="history-empty">暂无识别记录</div>'
    return
  }
  container.innerHTML = ''
  for (const r of records) {
    const time = r.created_at.slice(5, 16).replace('T', ' ')
    const item = document.createElement('div')
    item.className = 'history-item'

    const timeSpan = document.createElement('span')
    timeSpan.className = 'history-time'
    timeSpan.textContent = time

    const textSpan = document.createElement('span')
    textSpan.className = 'history-text'
    textSpan.textContent = r.text

    const badge = document.createElement('span')
    badge.className = r.is_command ? 'history-badge command' : 'history-badge text'
    badge.textContent = r.is_command ? `指令 ${r.command_shortcut ?? ''}` : `${r.char_count}字`

    const copyBtn = document.createElement('button')
    copyBtn.className = 'history-action-btn'
    copyBtn.textContent = '复制'
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void handleCopy(copyBtn, r.text)
    })

    // 点击切换展开/收起
    item.addEventListener('click', () => item.classList.toggle('expanded'))

    item.append(timeSpan, textSpan, badge, copyBtn)
    container.appendChild(item)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 复制文本并显示反馈 */
async function handleCopy(btn: HTMLButtonElement, text: string) {
  const old = btn.textContent || '复制'
  try {
    await window.electronAPI.copyToClipboard(text)
    btn.textContent = '已复制'
  } catch {
    btn.textContent = '失败'
  }
  setTimeout(() => { btn.textContent = old }, 1200)
}

/** 日期标签：今天/昨天/M月D日 周X */
function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = (today.getTime() - target.getTime()) / 86400000
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdays[d.getDay()]}`
}

/** 从 created_at 提取日期 key（YYYY-MM-DD） */
function dateKey(createdAt: string): string {
  return createdAt.slice(0, 10)
}

// ── 对话记录页 ──

let historyOffset = 0
const HISTORY_PAGE_SIZE = 100

async function initHistoryTab() {
  document.getElementById('daily-summary-btn')?.addEventListener('click', handleDailySummary)
  document.getElementById('history-load-more-btn')?.addEventListener('click', loadMoreHistory)
  // 抽屉关闭
  document.getElementById('summary-drawer-close')?.addEventListener('click', closeSummaryDrawer)
  document.querySelector('.summary-drawer-backdrop')?.addEventListener('click', closeSummaryDrawer)
  await loadFullHistory(true)
}

async function loadFullHistory(reset: boolean) {
  if (reset) historyOffset = 0
  try {
    const records = await window.electronAPI.getAllHistory(historyOffset, HISTORY_PAGE_SIZE)
    renderFullHistory(records, reset)
    historyOffset += records.length
    const loadMoreBtn = document.getElementById('history-load-more-btn')
    if (loadMoreBtn) {
      loadMoreBtn.style.display = records.length >= HISTORY_PAGE_SIZE ? '' : 'none'
    }
  } catch { /* 静默 */ }
}

async function loadMoreHistory() {
  await loadFullHistory(false)
}

/** 已渲染的最后一个日期 key，用于增量加载时判断是否需要插入日期头 */
let lastRenderedDateKey = ''

function renderFullHistory(records: RecognitionRecord[], reset: boolean) {
  const container = document.getElementById('full-history-list')
  if (!container) return
  if (reset) {
    container.innerHTML = ''
    lastRenderedDateKey = ''
  }
  if (records.length === 0 && reset) {
    container.innerHTML = '<div class="history-empty">暂无对话记录</div>'
    return
  }

  const frag = document.createDocumentFragment()

  for (const r of records) {
    const dk = dateKey(r.created_at)
    // 插入日期分组头
    if (dk !== lastRenderedDateKey) {
      const header = document.createElement('div')
      header.className = 'history-date-header'
      header.textContent = formatDateLabel(r.created_at)
      frag.appendChild(header)
      lastRenderedDateKey = dk
    }

    // 复用 .history-item 控件
    const item = document.createElement('div')
    item.className = 'history-item'
    if (r.is_command) item.classList.add('command-item')

    const timeSpan = document.createElement('span')
    timeSpan.className = 'history-time'
    timeSpan.textContent = r.created_at.slice(11, 16)

    const textSpan = document.createElement('span')
    textSpan.className = 'history-text'
    textSpan.textContent = r.text

    const badge = document.createElement('span')
    badge.className = r.is_command ? 'history-badge command' : 'history-badge text'
    badge.textContent = r.is_command ? `指令 ${r.command_shortcut ?? ''}` : `${r.char_count}字`

    const copyBtn = document.createElement('button')
    copyBtn.className = 'history-action-btn'
    copyBtn.textContent = '复制'
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      void handleCopy(copyBtn, r.text)
    })

    item.addEventListener('click', () => item.classList.toggle('expanded'))

    item.append(timeSpan, textSpan, badge, copyBtn)
    frag.appendChild(item)
  }

  container.appendChild(frag)
}

function closeSummaryDrawer() {
  const drawer = document.getElementById('summary-drawer')
  if (drawer) drawer.hidden = true
}

async function handleDailySummary() {
  const btn = document.getElementById('daily-summary-btn') as HTMLButtonElement | null
  const drawer = document.getElementById('summary-drawer')
  const content = document.getElementById('summary-drawer-content')
  if (!btn || !drawer || !content) return

  btn.disabled = true
  btn.textContent = '生成中...'
  drawer.hidden = false
  content.innerHTML = '<p style="color:#94a3b8">正在调用大模型生成总结，请稍候...</p>'

  try {
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const summary = await window.electronAPI.generateDailySummary(dateStr)
    content.innerHTML = marked(summary) as string
  } catch (e) {
    content.innerHTML = `<p style="color:#ef4444">生成失败: ${escapeHtml(String(e))}</p>`
  } finally {
    btn.disabled = false
    btn.textContent = '生成今日总结'
  }
}
