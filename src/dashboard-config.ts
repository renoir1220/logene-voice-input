import type { HotwordScene, AppConfig } from './types'
import { renderModelList, setModelListHint } from './dashboard-models'
import { withTimeout } from './utils'

// ── Tab 切换 ──

export function initTabs() {
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

// ── 配置表单 ──

export async function loadConfigToForm() {
  const urlInput = document.getElementById('cfg-url') as HTMLInputElement | null
  if (!urlInput) return

  try {
    const cfg = await window.electronAPI.getConfig()
    ;urlInput.value = cfg.server?.url || ''
    ;(document.getElementById('cfg-hotkey') as HTMLInputElement).value = cfg.hotkey?.record || ''
    ;(document.getElementById('cfg-clipboard') as HTMLInputElement).checked = cfg.input?.useClipboard || false
    ;(document.getElementById('cfg-vad') as HTMLInputElement).checked = cfg.vad?.enabled || false
    ;(document.getElementById('dashboard-vad-toggle') as HTMLInputElement).checked = cfg.vad?.enabled || false
    ;(document.getElementById('cfg-llm-enabled') as HTMLInputElement).checked = cfg.llm?.enabled || false
    ;(document.getElementById('cfg-llm-baseurl') as HTMLInputElement).value = cfg.llm?.baseUrl || ''
    ;(document.getElementById('cfg-llm-apikey') as HTMLInputElement).value = cfg.llm?.apiKey || ''
    ;(document.getElementById('cfg-llm-model') as HTMLInputElement).value = cfg.llm?.model || ''
    const asrMode = cfg.asr?.mode ?? 'api'
    ;(document.getElementById('asr-mode-api') as HTMLInputElement).checked = asrMode === 'api'
    ;(document.getElementById('asr-mode-local') as HTMLInputElement).checked = asrMode === 'local'
    updateAsrModeUI(asrMode)
    await withTimeout(renderModelList(cfg.asr?.localModel), 8000, 'render-model-list')
  } catch (e) {
    console.error('[Dashboard] loadConfigToForm failed:', e)
    setModelListHint(`初始化失败：${String(e)}`, true)
  }
}

export async function saveConfig() {
  const hint = document.getElementById('save-hint')!
  const llmHint = document.getElementById('llm-save-hint')
  try {
    const cfg = await window.electronAPI.getConfig()
    cfg.server.url = (document.getElementById('cfg-url') as HTMLInputElement).value.trim()
    cfg.hotkey.record = (document.getElementById('cfg-hotkey') as HTMLInputElement).value.trim()
    cfg.input.useClipboard = (document.getElementById('cfg-clipboard') as HTMLInputElement).checked
    const asrMode = (document.getElementById('asr-mode-local') as HTMLInputElement).checked ? 'local' : 'api'
    cfg.asr = { ...cfg.asr, mode: asrMode }
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

// ── ASR 模式切换 ──

export function updateAsrModeUI(mode: string) {
  const apiSettings = document.getElementById('api-settings')!
  const localSettings = document.getElementById('local-model-settings')!
  apiSettings.style.display = mode === 'api' ? '' : 'none'
  localSettings.style.display = mode === 'local' ? '' : 'none'
}

// ── 语音指令 ──

export async function renderCommandList() {
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

export async function renderCommandEditor() {
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

export function appendCommandRow(container: HTMLElement, name = '', key = '') {
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

export async function saveCommands() {
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
    renderCommandList()
    setTimeout(() => { hint.textContent = '' }, 2000)
  } catch (e) {
    hint.textContent = '保存失败: ' + String(e)
    hint.style.color = '#f87171'
  }
}

// ── 热词管理 ──

let hotwordScenes: HotwordScene[] = [{ name: '全局', words: [] }]
let activeSceneIndex = 0
let hotwordSearchQuery = ''

export async function loadHotwords() {
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

function renderSceneTabs() {
  const container = document.getElementById('scene-tabs')!
  container.innerHTML = ''
  hotwordScenes.forEach((scene, i) => {
    const tab = document.createElement('button')
    tab.className = 'scene-tab' + (i === activeSceneIndex ? ' active' : '')
    tab.textContent = scene.name
    tab.addEventListener('click', () => switchScene(i))
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

function sortByPinyin(words: string[]): string[] {
  return [...words].sort((a, b) => a.localeCompare(b, 'zh'))
}

function filterHotwords(words: string[], query: string): string[] {
  if (!query) return words
  return words.filter(w => w.includes(query))
}

export function renderHotwordTags() {
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

export function addHotword(word: string) {
  const trimmed = word.trim()
  if (!trimmed) return
  const scene = hotwordScenes[activeSceneIndex]
  if (!scene || scene.words.includes(trimmed)) return
  scene.words.push(trimmed)
  renderHotwordTags()
}

function removeHotword(word: string) {
  const scene = hotwordScenes[activeSceneIndex]
  if (!scene) return
  scene.words = scene.words.filter(w => w !== word)
  renderHotwordTags()
}

export function addScene() {
  const name = prompt('请输入场景名称：')
  if (!name || !name.trim()) return
  const trimmed = name.trim()
  if (hotwordScenes.some(s => s.name === trimmed)) {
    alert('场景名称已存在')
    return
  }
  hotwordScenes.push({ name: trimmed, words: [] })
  activeSceneIndex = hotwordScenes.length - 1
  renderSceneTabs()
  renderHotwordTags()
}

function deleteScene(index: number) {
  if (index === 0) return
  if (!confirm(`确定删除场景「${hotwordScenes[index].name}」？`)) return
  hotwordScenes.splice(index, 1)
  if (activeSceneIndex >= hotwordScenes.length) activeSceneIndex = hotwordScenes.length - 1
  renderSceneTabs()
  renderHotwordTags()
}

export async function saveHotwords() {
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

export function setHotwordSearchQuery(query: string) {
  hotwordSearchQuery = query
}
