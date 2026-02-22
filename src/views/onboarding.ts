import { updateAsrModeUI } from '../dashboard-config'

const ONBOARDING_VERSION = 1

type StepDefinition = {
  title: string
  desc: string
  points: string[]
  primaryLabel: string
  secondaryLabel?: string
  allowClose: boolean
  onEnter?: () => Promise<void>
  onPrimary: () => Promise<void>
  onSecondary?: () => Promise<void>
  highlightSelectors?: string[]
}

type ModelReadiness = {
  ready: boolean
  modelId: string
  reason: string
}

let currentStep = 0
let busy = false
let renderVersion = 0
let requireModelSetup = false
let introPending = false
let modelState: ModelReadiness = {
  ready: false,
  modelId: 'paraformer-zh-contextual-quant',
  reason: '',
}

const highlightedEls: HTMLElement[] = []

function qs<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function activateMainTab(tab: string) {
  const btn = document.querySelector<HTMLButtonElement>(`.menu-item[data-tab="${tab}"]`)
  btn?.click()
}

function activateSubTab(tab: string, subtab: string) {
  activateMainTab(tab)
  const btn = document.querySelector<HTMLButtonElement>(`#tab-${tab} .sub-tab[data-subtab="${subtab}"]`)
  btn?.click()
}

function clearHighlights() {
  for (const el of highlightedEls) {
    el.classList.remove('onboarding-highlight')
  }
  highlightedEls.length = 0
}

function applyHighlights(selectors?: string[]) {
  clearHighlights()
  if (!selectors || selectors.length === 0) return
  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) continue
    el.classList.add('onboarding-highlight')
    highlightedEls.push(el)
  }
}

function setStepStatus(text: string, isError = false) {
  const statusEl = qs<HTMLDivElement>('onboarding-step-status')
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.style.color = isError ? '#dc2626' : ''
}

function focusLocalModelSection() {
  activateSubTab('llm', 'llm-voice')
  const asrLocal = qs<HTMLInputElement>('asr-mode-local')
  const asrApi = qs<HTMLInputElement>('asr-mode-api')
  if (asrLocal) asrLocal.checked = true
  if (asrApi) asrApi.checked = false
  updateAsrModeUI('local')
}

async function inspectModelReadiness(): Promise<ModelReadiness> {
  const cfg = await window.electronAPI.getConfig()
  const modelId = cfg.asr?.localModel || 'paraformer-zh-contextual-quant'
  try {
    const statuses = await window.electronAPI.getModelStatuses()
    const target = statuses.find((item) => item.id === modelId)
    if (!target) {
      return { ready: false, modelId, reason: '无法读取模型状态，请先下载模型。' }
    }
    const ready = Boolean(target.downloaded && !target.incomplete)
    if (ready) return { ready: true, modelId, reason: '' }
    if (target.incomplete) {
      return { ready: false, modelId, reason: '检测到 ASR/VAD/PUNC 模型文件不完整，请重新下载。' }
    }
    return { ready: false, modelId, reason: '尚未下载 ASR/VAD/PUNC 模型，请先下载。' }
  } catch {
    return { ready: false, modelId, reason: '模型状态读取失败，请点击下载模型。' }
  }
}

async function downloadCurrentModel(): Promise<void> {
  const result = await window.electronAPI.downloadModel(modelState.modelId)
  if (!result?.success) {
    throw new Error(result?.error || '模型下载失败')
  }
}

async function markIntroCompleted() {
  const cfg = await window.electronAPI.getConfig()
  cfg.onboarding = {
    completed: true,
    completedAt: new Date().toISOString(),
    version: ONBOARDING_VERSION,
  }
  await window.electronAPI.saveConfig(cfg)
  introPending = false
}

function getSteps(hide: () => void): StepDefinition[] {
  const steps: StepDefinition[] = []

  if (requireModelSetup) {
    steps.push({
      title: '先下载语音模型',
      desc: 'ASR + VAD + PUNC 是本应用的基础运行条件，检测到当前模型不完整，需先下载。',
      points: [
        '下载完成后才能稳定进行语音输入。',
        '下载过程可能较慢，请耐心等待。',
        '下载后会自动切换到下一步。',
      ],
      primaryLabel: modelState.ready ? '模型已就绪' : '下载模型',
      allowClose: false,
      highlightSelectors: ['#asr-mode-local', '#model-list'],
      onEnter: async () => {
        focusLocalModelSection()
        modelState = await inspectModelReadiness()
        requireModelSetup = !modelState.ready
        if (requireModelSetup) {
          setStepStatus(modelState.reason)
        } else {
          setStepStatus('模型已就绪')
        }
      },
      onPrimary: async () => {
        focusLocalModelSection()
        modelState = await inspectModelReadiness()
        requireModelSetup = !modelState.ready
        if (requireModelSetup) {
          setStepStatus('正在下载 ASR/VAD/PUNC 模型，请耐心等待...')
          await downloadCurrentModel()
          modelState = await inspectModelReadiness()
          requireModelSetup = !modelState.ready
        }
        if (requireModelSetup) {
          throw new Error(modelState.reason || '模型仍未就绪，请重试。')
        }
        setStepStatus('模型已下载完成')
        currentStep += 1
      },
    })
  }

  if (introPending) {
    steps.push({
      title: '你只需要记住这两个功能',
      desc: '先把这两个快捷功能用起来就可以，其他设置后续再看。',
      points: [
        'Alt + 空格：按下开始说话。',
        'Alt + W：对选中文字进行改写。',
      ],
      primaryLabel: '我知道了',
      allowClose: true,
      onEnter: async () => {
        activateMainTab('status')
      },
      onPrimary: async () => {
        await markIntroCompleted()
        hide()
      },
    })
  }

  return steps
}

function renderStep(hide: () => void) {
  renderVersion += 1
  const version = renderVersion

  const steps = getSteps(hide)
  if (steps.length === 0) {
    hide()
    return
  }

  if (currentStep < 0) currentStep = 0
  if (currentStep >= steps.length) currentStep = steps.length - 1
  const step = steps[currentStep]

  const titleEl = qs<HTMLDivElement>('onboarding-step-title')
  const descEl = qs<HTMLParagraphElement>('onboarding-step-desc')
  const pointsEl = qs<HTMLUListElement>('onboarding-step-points')
  const stepIndexEl = qs<HTMLSpanElement>('onboarding-step-index')
  const primaryBtn = qs<HTMLButtonElement>('onboarding-primary-btn')
  const secondaryBtn = qs<HTMLButtonElement>('onboarding-secondary-btn')
  const closeBtn = qs<HTMLButtonElement>('onboarding-close-btn')
  if (!titleEl || !descEl || !pointsEl || !stepIndexEl || !primaryBtn || !secondaryBtn || !closeBtn) return

  titleEl.textContent = step.title
  descEl.textContent = step.desc
  stepIndexEl.textContent = `${currentStep + 1} / ${steps.length}`
  pointsEl.innerHTML = ''
  for (const point of step.points) {
    const li = document.createElement('li')
    li.textContent = point
    pointsEl.appendChild(li)
  }
  setStepStatus('')
  primaryBtn.textContent = step.primaryLabel
  secondaryBtn.style.display = step.secondaryLabel ? '' : 'none'
  secondaryBtn.textContent = step.secondaryLabel || ''
  closeBtn.style.display = step.allowClose ? '' : 'none'

  applyHighlights(step.highlightSelectors)

  if (step.onEnter) {
    void step.onEnter()
      .then(() => {
        if (version !== renderVersion) return
        if (currentStep !== 0) return
        if (requireModelSetup) return
        const firstStep = getSteps(hide)[0]
        if (firstStep) {
          primaryBtn.textContent = firstStep.primaryLabel
        }
      })
      .catch((e) => {
        if (version !== renderVersion) return
        setStepStatus(`引导上下文加载失败：${String(e)}`, true)
      })
  }
}

export async function initFirstUseOnboarding() {
  // TODO: 引导界面暂时停用，待完善后重新启用
  return
  const overlay = qs<HTMLDivElement>('onboarding-overlay')
  const closeBtn = qs<HTMLButtonElement>('onboarding-close-btn')
  const primaryBtn = qs<HTMLButtonElement>('onboarding-primary-btn')
  const secondaryBtn = qs<HTMLButtonElement>('onboarding-secondary-btn')
  if (!overlay || !closeBtn || !primaryBtn || !secondaryBtn) return

  const hide = () => {
    overlay.hidden = true
    clearHighlights()
  }

  const cfg = await window.electronAPI.getConfig()
  const onboarding = cfg.onboarding
  const introCompleted = Boolean(onboarding?.completed) && Number(onboarding?.version) === ONBOARDING_VERSION
  introPending = !introCompleted

  modelState = await inspectModelReadiness()
  requireModelSetup = !modelState.ready

  if (!requireModelSetup && !introPending) {
    hide()
    return
  }

  currentStep = 0
  closeBtn.onclick = () => {
    hide()
  }

  primaryBtn.onclick = async () => {
    if (busy) return
    const steps = getSteps(hide)
    const step = steps[currentStep]
    if (!step) return
    busy = true
    primaryBtn.disabled = true
    secondaryBtn.disabled = true
    closeBtn.disabled = true
    try {
      await step.onPrimary()
      if (!overlay.hidden) renderStep(hide)
    } catch (e) {
      setStepStatus(String(e), true)
    } finally {
      busy = false
      primaryBtn.disabled = false
      secondaryBtn.disabled = false
      closeBtn.disabled = false
    }
  }

  secondaryBtn.onclick = async () => {
    if (busy) return
    const steps = getSteps(hide)
    const step = steps[currentStep]
    if (!step?.onSecondary) return
    busy = true
    primaryBtn.disabled = true
    secondaryBtn.disabled = true
    closeBtn.disabled = true
    try {
      await step.onSecondary()
      if (!overlay.hidden) renderStep(hide)
    } catch (e) {
      setStepStatus(String(e), true)
    } finally {
      busy = false
      primaryBtn.disabled = false
      secondaryBtn.disabled = false
      closeBtn.disabled = false
    }
  }

  overlay.hidden = false
  renderStep(hide)
}
