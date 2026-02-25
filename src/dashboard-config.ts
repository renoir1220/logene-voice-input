import type {
  HotwordScene,
  AppConfig,
  LlmModelConfig,
  LlmTaskPromptConfig,
  TextRuleConfig,
  TextRulesConfig,
} from './types'
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

function llmModelContainer(): HTMLDivElement | null {
  return document.getElementById('llm-model-list') as HTMLDivElement | null
}

function normalizeModelId(raw: string, index: number): string {
  const id = raw.trim()
  return id || `llm-${index + 1}`
}

function normalizeHotkey(raw: string): string {
  const tokens = raw
    .split('+')
    .map((p) => normalizeHotkeyMainKey(p))
    .filter(Boolean)
  const modifiers = HOTKEY_MODIFIER_ORDER.filter((modifier) => tokens.includes(modifier))
  const main = tokens.find((token) => !HOTKEY_MODIFIER_SET.has(token)) ?? ''
  return main ? [...modifiers, main].join('+') : modifiers.join('+')
}

const HOTKEY_MODIFIER_ORDER = ['CTRL', 'ALT', 'SHIFT', 'META']
const HOTKEY_MODIFIER_SET = new Set(['CTRL', 'ALT', 'SHIFT', 'META'])

function normalizeHotkeyMainKey(raw: string): string {
  const key = raw.trim().toUpperCase()
  if (!key) return ''
  const alias: Record<string, string> = {
    CONTROL: 'CTRL',
    CMD: 'META',
    COMMAND: 'META',
    WIN: 'META',
    SUPER: 'META',
    ESCAPE: 'ESC',
    RETURN: 'ENTER',
    ARROWUP: 'UP',
    ARROWDOWN: 'DOWN',
    ARROWLEFT: 'LEFT',
    ARROWRIGHT: 'RIGHT',
    ' ': 'SPACE',
  }
  return alias[key] ?? key
}

function hotkeyFromKeyboardEvent(event: KeyboardEvent): string | null {
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('CTRL')
  if (event.altKey) modifiers.push('ALT')
  if (event.shiftKey) modifiers.push('SHIFT')
  if (event.metaKey) modifiers.push('META')

  let main = normalizeHotkeyMainKey(event.key)
  if (main === 'PROCESS' || main === 'UNIDENTIFIED' || main === 'DEAD') return null
  if (HOTKEY_MODIFIER_SET.has(main)) main = ''

  if (!main) return null
  if (main.length === 1 && /^[A-Z0-9]$/.test(main)) {
    // keep single char key as-is
  } else if (!/^(F([1-9]|1[0-2])|SPACE|ENTER|TAB|ESC|BACKSPACE|DELETE|UP|DOWN|LEFT|RIGHT)$/.test(main)) {
    return null
  }

  const orderedMods = HOTKEY_MODIFIER_ORDER.filter((m) => modifiers.includes(m))
  return [...orderedMods, main].join('+')
}

function attachHotkeyRecorder(input: HTMLInputElement): void {
  if (input.dataset.hotkeyRecorderBound === '1') return
  input.dataset.hotkeyRecorderBound = '1'
  input.readOnly = true
  input.spellcheck = false
  if (!input.placeholder) input.placeholder = '点击后按下快捷键'

  const leaveCaptureState = () => input.classList.remove('capturing-hotkey')
  input.addEventListener('focus', () => input.classList.add('capturing-hotkey'))
  input.addEventListener('blur', leaveCaptureState)
  input.addEventListener('mousedown', () => input.select())
  input.addEventListener('keydown', (event) => {
    event.preventDefault()
    event.stopPropagation()

    const clearByDelete = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
      && (event.key === 'Backspace' || event.key === 'Delete')
    if (clearByDelete) {
      input.value = ''
      leaveCaptureState()
      return
    }

    const hotkey = hotkeyFromKeyboardEvent(event)
    if (!hotkey) return
    input.value = hotkey
    leaveCaptureState()
    input.blur()
  })
}

function cloneScenes(scenes: HotwordScene[] | undefined): HotwordScene[] {
  if (!Array.isArray(scenes)) return []
  return scenes.map((scene) => ({
    name: String(scene?.name ?? '').trim() || '未命名',
    words: Array.isArray(scene?.words) ? scene.words.map((w) => String(w || '').trim()).filter(Boolean) : [],
  }))
}

function stripVoiceCommandHotwords(
  scenes: HotwordScene[] | undefined,
  commands: Record<string, string> | undefined,
): HotwordScene[] {
  const cleaned = cloneScenes(scenes)
  const commandWords = new Set(Object.keys(commands ?? {})
    .map((word) => word.trim())
    .filter(Boolean))

  for (const scene of cleaned) {
    scene.words = scene.words.filter((word) => !commandWords.has(word.trim()))
  }

  return cleaned.length > 0 ? cleaned : [{ name: '全局', words: [] }]
}

export function initHotkeyRecorders(): void {
  const recordHotkeyInput = document.getElementById('cfg-hotkey') as HTMLInputElement | null
  if (recordHotkeyInput) attachHotkeyRecorder(recordHotkeyInput)
}

function collectLlmModelsFromForm(): LlmModelConfig[] {
  const container = llmModelContainer()
  if (!container) return []

  const rows = Array.from(container.querySelectorAll<HTMLDivElement>('.llm-model-row'))
  const usedIds = new Set<string>()
  const models: LlmModelConfig[] = []

  rows.forEach((row, idx) => {
    const nameInput = row.querySelector<HTMLInputElement>('.llm-name')
    const baseUrlInput = row.querySelector<HTMLInputElement>('.llm-baseurl')
    const apiKeyInput = row.querySelector<HTMLInputElement>('.llm-apikey')
    const modelInput = row.querySelector<HTMLInputElement>('.llm-model')
    const enabledInput = row.querySelector<HTMLInputElement>('.llm-enabled')

    if (!nameInput || !baseUrlInput || !apiKeyInput || !modelInput || !enabledInput) return

    const name = nameInput.value.trim() || `模型${idx + 1}`
    // 根据名称自动生成 id
    let id = `llm-${idx + 1}`
    if (usedIds.has(id)) id = `${id}-dup`
    usedIds.add(id)

    models.push({
      id,
      name,
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      enabled: enabledInput.checked,
    })
  })

  return models
}

function textRuleContainer(): HTMLDivElement | null {
  return document.getElementById('text-rules-editor-list') as HTMLDivElement | null
}

function parseRuleTokenList(raw: string): string[] {
  const parts = raw
    .split(/[\n,，、]+/u)
    .map((p) => p.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const result: string[] = []
  for (const token of parts) {
    if (seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }
  return result
}

function renderRuleTokenList(tokens: string[] | undefined): string {
  return Array.isArray(tokens) ? tokens.join('，') : ''
}

function renderTaskBindings(models: LlmModelConfig[], bindings?: { rewrite?: string; asrPostProcess?: string; dailySummary?: string }) {
  const rewriteSelect = document.getElementById('cfg-llm-task-rewrite') as HTMLSelectElement | null
  const asrSelect = document.getElementById('cfg-llm-task-asr') as HTMLSelectElement | null
  const summarySelect = document.getElementById('cfg-llm-task-summary') as HTMLSelectElement | null
  if (!rewriteSelect || !asrSelect) return

  const options = models.length > 0 ? models : [{
    id: 'default-llm',
    name: '默认模型',
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  }]
  rewriteSelect.innerHTML = ''
  asrSelect.innerHTML = ''
  if (summarySelect) summarySelect.innerHTML = ''

  for (const model of options) {
    const r = document.createElement('option')
    r.value = model.id
    r.textContent = model.name
    rewriteSelect.appendChild(r)

    const a = document.createElement('option')
    a.value = model.id
    a.textContent = model.name
    asrSelect.appendChild(a)

    if (summarySelect) {
      const s = document.createElement('option')
      s.value = model.id
      s.textContent = model.name
      summarySelect.appendChild(s)
    }
  }

  rewriteSelect.value = bindings?.rewrite && options.some((m) => m.id === bindings.rewrite)
    ? bindings.rewrite
    : options[0].id
  asrSelect.value = bindings?.asrPostProcess && options.some((m) => m.id === bindings.asrPostProcess)
    ? bindings.asrPostProcess
    : options[0].id
  if (summarySelect) {
    summarySelect.value = bindings?.dailySummary && options.some((m) => m.id === bindings.dailySummary)
      ? bindings.dailySummary
      : options[0].id
  }
}

function setPromptTextareaValue(id: string, value: string) {
  const input = document.getElementById(id) as HTMLTextAreaElement | null
  if (input) input.value = value
}

function getPromptTextareaValue(id: string): string {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? ''
}

function renderTaskPrompts(prompts: AppConfig['llm']['prompts']) {
  setPromptTextareaValue('cfg-llm-prompt-rewrite-system', prompts.rewrite.systemPrompt)
  setPromptTextareaValue('cfg-llm-prompt-rewrite-user', prompts.rewrite.userPromptTemplate)

  setPromptTextareaValue('cfg-llm-prompt-asr-system', prompts.asrPostProcess.systemPrompt)
  setPromptTextareaValue('cfg-llm-prompt-asr-user', prompts.asrPostProcess.userPromptTemplate)

  setPromptTextareaValue('cfg-llm-prompt-summary-system', prompts.dailySummary.systemPrompt)
  setPromptTextareaValue('cfg-llm-prompt-summary-user', prompts.dailySummary.userPromptTemplate)
}

function collectTaskPromptsFromForm(existing: AppConfig['llm']['prompts']): AppConfig['llm']['prompts'] {
  const readTask = (prefix: string, fallback: LlmTaskPromptConfig): LlmTaskPromptConfig => ({
    systemPrompt: getPromptTextareaValue(`cfg-llm-prompt-${prefix}-system`) || fallback.systemPrompt,
    userPromptTemplate: getPromptTextareaValue(`cfg-llm-prompt-${prefix}-user`) || fallback.userPromptTemplate,
  })

  return {
    rewrite: readTask('rewrite', existing.rewrite),
    asrPostProcess: readTask('asr', existing.asrPostProcess),
    dailySummary: readTask('summary', existing.dailySummary),
  }
}

function appendTextRuleRow(rule: TextRuleConfig, refreshHint = false) {
  const container = textRuleContainer()
  if (!container) return

  const row = document.createElement('div')
  row.className = 'text-rule-row cmd-editor-row'
  row.dataset.ruleId = rule.id

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.className = 'cmd-input text-rule-name'
  nameInput.placeholder = '规则名称'
  nameInput.value = rule.name

  const mulInput = document.createElement('input')
  mulInput.type = 'text'
  mulInput.className = 'cmd-input text-rule-mul'
  mulInput.placeholder = '乘法连接词（逗号分隔）'
  mulInput.value = renderRuleTokenList(rule.options.multiplicationWords)

  const rangeInput = document.createElement('input')
  rangeInput.type = 'text'
  rangeInput.className = 'cmd-input text-rule-range'
  rangeInput.placeholder = '范围连接词（逗号分隔）'
  rangeInput.value = renderRuleTokenList(rule.options.rangeWords)

  const unitInput = document.createElement('input')
  unitInput.type = 'text'
  unitInput.className = 'cmd-input text-rule-unit'
  unitInput.placeholder = '输出单位'
  unitInput.value = rule.options.outputUnit || 'CM'

  const enabledLabel = document.createElement('label')
  enabledLabel.className = 'checkbox'
  const enabledInput = document.createElement('input')
  enabledInput.className = 'text-rule-enabled'
  enabledInput.type = 'checkbox'
  enabledInput.checked = rule.enabled
  const enabledText = document.createElement('span')
  enabledText.textContent = '启用'
  enabledLabel.appendChild(enabledInput)
  enabledLabel.appendChild(enabledText)

  const delBtn = document.createElement('button')
  delBtn.className = 'cmd-del-btn text-rule-del-btn'
  delBtn.type = 'button'
  delBtn.textContent = '×'
  delBtn.title = '删除规则'
  delBtn.addEventListener('click', () => {
    row.remove()
  })

  row.append(nameInput, mulInput, rangeInput, unitInput, enabledLabel, delBtn)
  container.appendChild(row)

  if (refreshHint) {
    const hint = document.getElementById('text-rules-save-hint')
    if (hint) {
      hint.textContent = '请点击“保存文本规则”应用改动'
      hint.style.color = '#94a3b8'
    }
  }
}

function renderTextRulesEditor(config: TextRulesConfig | undefined) {
  const container = textRuleContainer()
  if (!container) return

  const enabledInput = document.getElementById('cfg-text-rules-enabled') as HTMLInputElement | null
  if (enabledInput) {
    enabledInput.checked = Boolean(config?.enabled)
  }

  container.innerHTML = ''
  const rules = Array.isArray(config?.rules) ? config!.rules : []
  for (const rule of rules) {
    appendTextRuleRow(rule)
  }
}

function collectTextRulesFromForm(existing: TextRulesConfig): TextRulesConfig {
  const enabled = (document.getElementById('cfg-text-rules-enabled') as HTMLInputElement | null)?.checked ?? false
  const container = textRuleContainer()
  if (!container) return existing

  const rows = Array.from(container.querySelectorAll<HTMLDivElement>('.text-rule-row'))
  const rules: TextRuleConfig[] = rows.map((row, index) => {
    const fallback = existing.rules[index] || existing.rules[0]
    const rawId = row.dataset.ruleId || ''
    const name = (row.querySelector('.text-rule-name') as HTMLInputElement | null)?.value.trim() || `规则${index + 1}`
    const multiplicationWords = parseRuleTokenList(
      (row.querySelector('.text-rule-mul') as HTMLInputElement | null)?.value || '',
    )
    const rangeWords = parseRuleTokenList(
      (row.querySelector('.text-rule-range') as HTMLInputElement | null)?.value || '',
    )
    const outputUnit = (row.querySelector('.text-rule-unit') as HTMLInputElement | null)?.value.trim().toUpperCase() || 'CM'
    const enabledRule = (row.querySelector('.text-rule-enabled') as HTMLInputElement | null)?.checked ?? true

    return {
      id: rawId || `text-rule-${index + 1}`,
      name,
      enabled: enabledRule,
      type: 'sizeExpressionNormalize',
      options: {
        multiplicationWords: multiplicationWords.length > 0
          ? multiplicationWords
          : [...(fallback?.options.multiplicationWords ?? ['乘以', '乘', 'x', 'X', '×', '*'])],
        rangeWords: rangeWords.length > 0
          ? rangeWords
          : [...(fallback?.options.rangeWords ?? ['到', '至', '-', '~', '～', '—', '－'])],
        outputUnit: outputUnit || (fallback?.options.outputUnit ?? 'CM'),
      },
    }
  })

  return {
    enabled,
    rules,
  }
}

export function addTextRule() {
  const container = textRuleContainer()
  if (!container) return
  const nextIndex = container.querySelectorAll('.text-rule-row').length + 1
  appendTextRuleRow({
    id: `text-rule-${nextIndex}`,
    name: `尺寸规则${nextIndex}`,
    enabled: true,
    type: 'sizeExpressionNormalize',
    options: {
      multiplicationWords: ['乘以', '乘', 'x', 'X', '×', '*'],
      rangeWords: ['到', '至', '-', '~', '～', '—', '－'],
      outputUnit: 'CM',
    },
  }, true)
}

function appendLlmModelRow(model: LlmModelConfig, refreshBindings: boolean) {
  const container = llmModelContainer()
  if (!container) return

  const row = document.createElement('div')
  row.className = 'llm-model-row cmd-editor-row'
  const createInput = (className: string, type: string, placeholder: string, value: string) => {
    const input = document.createElement('input')
    input.className = `cmd-input ${className}`
    input.type = type
    input.placeholder = placeholder
    input.value = value
    return input
  }

  const idInput = createInput('llm-id', 'text', '模型ID(唯一)', model.id)
  const nameInput = createInput('llm-name', 'text', '名称', model.name)
  const baseUrlInput = createInput('llm-baseurl', 'text', 'Base URL', model.baseUrl)
  const modelInput = createInput('llm-model', 'text', 'Model Name', model.model)
  const apiKeyInput = createInput('llm-apikey', 'password', 'API Key', model.apiKey)

  const enabledLabel = document.createElement('label')
  enabledLabel.className = 'checkbox'
  const enabledInput = document.createElement('input')
  enabledInput.className = 'llm-enabled'
  enabledInput.type = 'checkbox'
  enabledInput.checked = model.enabled
  const enabledText = document.createElement('span')
  enabledText.textContent = '启用'
  enabledLabel.appendChild(enabledInput)
  enabledLabel.appendChild(enabledText)

  const delBtn = document.createElement('button')
  delBtn.className = 'cmd-del-btn llm-del-btn'
  delBtn.type = 'button'
  delBtn.textContent = '×'

  row.appendChild(nameInput)
  row.appendChild(baseUrlInput)
  row.appendChild(modelInput)
  row.appendChild(apiKeyInput)
  row.appendChild(enabledLabel)
  row.appendChild(delBtn)

  const refresh = () => renderTaskBindings(collectLlmModelsFromForm(), {
    rewrite: (document.getElementById('cfg-llm-task-rewrite') as HTMLSelectElement | null)?.value,
    asrPostProcess: (document.getElementById('cfg-llm-task-asr') as HTMLSelectElement | null)?.value,
    dailySummary: (document.getElementById('cfg-llm-task-summary') as HTMLSelectElement | null)?.value,
  })

  delBtn.addEventListener('click', () => {
    row.remove()
    refresh()
  })
  nameInput.addEventListener('input', refresh)
  enabledInput.addEventListener('change', refresh)

  container.appendChild(row)
  if (refreshBindings) refresh()
}

function renderLlmModelRows(models: LlmModelConfig[], bindings?: { rewrite?: string; asrPostProcess?: string }) {
  const container = llmModelContainer()
  if (!container) return
  container.innerHTML = ''
  const finalModels = models.length > 0
    ? models
    : [{
      id: 'default-llm',
      name: '默认模型',
      baseUrl: '',
      apiKey: '',
      model: '',
      enabled: true,
    }]
  for (const model of finalModels) {
    appendLlmModelRow(model, false)
  }
  renderTaskBindings(finalModels, bindings)
}

export function addLlmModel() {
  const models = collectLlmModelsFromForm()
  const nextIdx = models.length + 1
  appendLlmModelRow({
    id: `llm-${nextIdx}`,
    name: `模型${nextIdx}`,
    baseUrl: '',
    apiKey: '',
    model: '',
    enabled: true,
  }, true)
}

// ── 配置表单 ──

export async function loadConfigToForm() {
  const urlInput = document.getElementById('cfg-url') as HTMLInputElement | null
  if (!urlInput) return

  try {
    const cfg = await window.electronAPI.getConfig()
    ;urlInput.value = cfg.server?.url || ''
    ;(document.getElementById('cfg-hotkey') as HTMLInputElement).value = normalizeHotkey(cfg.hotkey?.record || '')
    ;(document.getElementById('cfg-clipboard') as HTMLInputElement).checked = cfg.input?.useClipboard || false
    ;(document.getElementById('cfg-log-debug-enabled') as HTMLInputElement).checked = cfg.logging?.enableDebug || false
    ;(document.getElementById('cfg-vad') as HTMLInputElement).checked = cfg.vad?.enabled || false
    ;(document.getElementById('dashboard-vad-toggle') as HTMLInputElement).checked = cfg.vad?.enabled || false
    const threshold = cfg.vad?.speechThreshold ?? 0.06
    const thresholdSlider = document.getElementById('cfg-vad-threshold') as HTMLInputElement | null
    const thresholdDisplay = document.getElementById('vad-threshold-display')
    if (thresholdSlider) thresholdSlider.value = String(threshold)
    if (thresholdDisplay) thresholdDisplay.textContent = threshold.toFixed(2)
    ;(document.getElementById('cfg-llm-enabled') as HTMLInputElement).checked = cfg.llm?.enabled || false
    ;(document.getElementById('cfg-llm-asr-optimize') as HTMLInputElement).checked =
      typeof cfg.llm?.asrPostProcessEnabled === 'boolean'
        ? cfg.llm.asrPostProcessEnabled
        : false
    renderLlmModelRows(cfg.llm?.models || [], cfg.llm?.taskBindings)
    renderTaskPrompts(cfg.llm.prompts)
    renderTextRulesEditor(cfg.textRules)
    const asrMode = cfg.asr?.mode ?? 'api'
    ;(document.getElementById('cfg-local-punc-enabled') as HTMLInputElement).checked = cfg.asr?.puncEnabled !== false
    ;(document.getElementById('asr-mode-api') as HTMLInputElement).checked = asrMode === 'api'
    ;(document.getElementById('asr-mode-local') as HTMLInputElement).checked = asrMode === 'local'
    updateAsrModeUI(asrMode)
    await withTimeout(renderModelList(cfg.asr?.localModel), 8000, 'render-model-list')
    // 枚举麦克风设备并填充下拉
    await populateAudioInputDevices(cfg.audioCapture?.inputConstraints?.deviceId || '')
  } catch (e) {
    console.error('[Dashboard] loadConfigToForm failed:', e)
    setModelListHint(`初始化失败：${String(e)}`, true)
  }
}

export async function saveConfig() {
  const hint = document.getElementById('save-hint')!
  const llmHint = document.getElementById('llm-save-hint')
  const textRulesHint = document.getElementById('text-rules-save-hint')
  try {
    const cfg = await window.electronAPI.getConfig()
    const prevHotkey = normalizeHotkey(cfg.hotkey?.record || '')
    cfg.server.url = (document.getElementById('cfg-url') as HTMLInputElement).value.trim()
    cfg.hotkey.record = normalizeHotkey((document.getElementById('cfg-hotkey') as HTMLInputElement).value.trim())
    const nextHotkey = normalizeHotkey(cfg.hotkey.record)
    const needsRestart = prevHotkey !== nextHotkey
    cfg.input.useClipboard = (document.getElementById('cfg-clipboard') as HTMLInputElement).checked
    cfg.logging = {
      ...cfg.logging,
      enableDebug: (document.getElementById('cfg-log-debug-enabled') as HTMLInputElement).checked,
    }
    const asrMode = (document.getElementById('asr-mode-local') as HTMLInputElement).checked ? 'local' : 'api'
    cfg.asr = {
      ...cfg.asr,
      mode: asrMode,
      puncEnabled: (document.getElementById('cfg-local-punc-enabled') as HTMLInputElement).checked,
    }
    const llmModels = collectLlmModelsFromForm()
    const fallbackModelId = llmModels[0]?.id || 'default-llm'
    const rewriteBinding = (document.getElementById('cfg-llm-task-rewrite') as HTMLSelectElement | null)?.value || fallbackModelId
    const asrBinding = (document.getElementById('cfg-llm-task-asr') as HTMLSelectElement | null)?.value || fallbackModelId
    const summaryBinding = (document.getElementById('cfg-llm-task-summary') as HTMLSelectElement | null)?.value || fallbackModelId
    cfg.llm = {
      enabled: (document.getElementById('cfg-llm-enabled') as HTMLInputElement).checked,
      asrPostProcessEnabled: (document.getElementById('cfg-llm-asr-optimize') as HTMLInputElement).checked,
      models: llmModels,
      taskBindings: {
        rewrite: llmModels.some((m) => m.id === rewriteBinding) ? rewriteBinding : fallbackModelId,
        asrPostProcess: llmModels.some((m) => m.id === asrBinding) ? asrBinding : fallbackModelId,
        dailySummary: llmModels.some((m) => m.id === summaryBinding) ? summaryBinding : fallbackModelId,
      },
      prompts: collectTaskPromptsFromForm(cfg.llm.prompts),
    }
    cfg.textRules = collectTextRulesFromForm(cfg.textRules)
    // 保存麦克风设备选择
    const deviceSelect = document.getElementById('cfg-audio-input-device') as HTMLSelectElement | null
    if (deviceSelect) {
      cfg.audioCapture = {
        ...cfg.audioCapture,
        inputConstraints: {
          ...cfg.audioCapture.inputConstraints,
          deviceId: deviceSelect.value || undefined,
        },
      }
    }
    const thresholdSlider = document.getElementById('cfg-vad-threshold') as HTMLInputElement | null
    cfg.vad = {
      ...cfg.vad,
      speechThreshold: thresholdSlider ? parseFloat(thresholdSlider.value) : (cfg.vad?.speechThreshold ?? 0.06),
    }
    await window.electronAPI.saveConfig(cfg)
    hint.textContent = needsRestart ? '已保存，热键变更需重启后生效' : '已保存'
    hint.style.color = '#4ade80'
    if (llmHint) {
      llmHint.textContent = '应用已持久化'
      llmHint.style.color = '#4ade80'
    }
    if (textRulesHint) {
      textRulesHint.textContent = '文本规则已保存'
      textRulesHint.style.color = '#4ade80'
    }
    if (needsRestart) {
      const shouldRestart = window.confirm('热键配置已变更，需要重启应用后生效。现在重启吗？')
      if (shouldRestart) {
        await window.electronAPI.restartApp()
      }
    }
  } catch (e) {
    hint.textContent = '保存失败: ' + String(e)
    hint.style.color = '#f87171'
    if (llmHint) {
      llmHint.textContent = '保存失败'
      llmHint.style.color = '#f87171'
    }
    if (textRulesHint) {
      textRulesHint.textContent = '保存失败'
      textRulesHint.style.color = '#f87171'
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
  } catch (e) {
    console.warn('[Command] renderCommandList failed:', e)
  }
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
  } catch (e) {
    console.warn('[Command] renderCommandEditor failed:', e)
  }
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
  keyInput.placeholder = '点击后按下快捷键'
  keyInput.value = normalizeHotkey(key)
  attachHotkeyRecorder(keyInput)

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
      const key = normalizeHotkey((row.querySelector('.cmd-key-input') as HTMLInputElement).value.trim())
      if (name && key) newCmds[name] = key
    }
    cfg.voiceCommands = newCmds
    cfg.hotwords = stripVoiceCommandHotwords(cfg.hotwords, newCmds)
    hotwordScenes = stripVoiceCommandHotwords(hotwordScenes, newCmds)
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
    hotwordScenes = stripVoiceCommandHotwords(cfg.hotwords, cfg.voiceCommands)
    activeSceneIndex = 0
    hotwordSearchQuery = ''
    const searchInput = document.getElementById('hotword-search') as HTMLInputElement
    if (searchInput) searchInput.value = ''
    renderSceneTabs()
    renderHotwordTags()
  } catch (e) {
    console.warn('[Hotword] loadHotwords failed:', e)
  }
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
    cfg.hotwords = stripVoiceCommandHotwords(hotwordScenes, cfg.voiceCommands)
    hotwordScenes = stripVoiceCommandHotwords(cfg.hotwords, cfg.voiceCommands)
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

// 枚举音频输入设备并填充下拉列表
async function populateAudioInputDevices(savedDeviceId: string): Promise<void> {
  const select = document.getElementById('cfg-audio-input-device') as HTMLSelectElement | null
  if (!select) return
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const audioInputs = devices.filter((d) => d.kind === 'audioinput')
    // 保留默认选项，清空其余
    while (select.options.length > 1) select.remove(1)
    for (const device of audioInputs) {
      const opt = document.createElement('option')
      opt.value = device.deviceId
      opt.textContent = device.label || `麦克风 ${select.options.length}`
      select.appendChild(opt)
    }
    if (savedDeviceId) select.value = savedDeviceId
  } catch {
    // 权限未授予时 enumerateDevices 可能返回空标签，静默处理
  }
}
