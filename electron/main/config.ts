import Store = require('electron-store')
import * as path from 'path'
import * as os from 'os'

// 热词场景
export interface HotwordScene {
  name: string      // "全局"、"胃镜" 等
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

export const DEFAULT_TEXT_RULES: TextRulesConfig = {
  enabled: true,
  rules: [
    {
      id: 'size-normalize-default',
      name: '尺寸表达标准化',
      enabled: true,
      type: 'sizeExpressionNormalize',
      options: {
        multiplicationWords: ['乘以', '乘', 'x', 'X', '×', '*'],
        rangeWords: ['到', '至', '-', '~', '～', '—', '－'],
        outputUnit: 'CM',
      },
    },
  ],
}

export interface LlmModelConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

export interface LlmTaskBindings {
  rewrite: string
  asrPostProcess: string
  dailySummary: string
}

export interface LlmTaskPromptConfig {
  systemPrompt: string
  userPromptTemplate: string
}

export interface LlmPromptsConfig {
  rewrite: LlmTaskPromptConfig
  asrPostProcess: LlmTaskPromptConfig
  dailySummary: LlmTaskPromptConfig
}

export const DEFAULT_LLM_PROMPTS: LlmPromptsConfig = {
  rewrite: {
    systemPrompt: `你是一个出色的桌面端文本重写助手。
必须严格遵循用户的要求，对给定的 [Selected Text] 进行修改、翻译或润色。
【严格要求】：
1. 绝对不要输出任何打招呼的话语、解释、或是“好的，以下是...”等废话。
2. 仅输出最终修改完毕的文本本身。
3. 除非用户明确要求，否则不要包裹 markdown 代码块符号（如 \`\`\`）。`,
    userPromptTemplate: `要求 (Instruction): {{instruction}}

Selected Text:
{{selectedText}}`,
  },
  asrPostProcess: {
    systemPrompt: `你是中文语音识别文本后处理助手。
目标：在不改变原意的前提下，修正明显识别错误、补全合理标点和格式。
规则：
1. 只输出最终文本，不要解释。
2. 不要添加原文没有的信息。
3. 保留专有名词、医学术语、数字与单位。
4. 如果不确定，尽量保持原文。`,
    userPromptTemplate: `请优化这段语音识别结果（保持原意）：
{{text}}`,
  },
  dailySummary: {
    systemPrompt: `你是一个智能工作助手，负责根据用户一天的语音录入内容生成简洁的每日总结。
要求：
1. 提炼出今天有价值的关键信息和工作内容。
2. 按主题或时间段归纳，不要逐条复述。
3. 忽略无意义的短语、测试内容或重复内容。
4. 如果内容涉及医疗取材，请用专业术语准确描述。
5. 输出简洁的中文总结，不要加多余的开场白。`,
    userPromptTemplate: `以下是今天的语音录入记录（共 {{count}} 条）：

{{records}}

请生成今日总结。`,
  },
}

export interface LlmConfig {
  enabled: boolean
  asrPostProcessEnabled: boolean
  models: LlmModelConfig[]
  taskBindings: LlmTaskBindings
  prompts: LlmPromptsConfig
}

export interface LoggingConfig {
  enableDebug: boolean
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

// 应用配置类型
export interface AppConfig {
  server: {
    url: string
    asrConfigId: string
  }
  hotkey: {
    record: string
  }
  input: {
    useClipboard: boolean
  }
  audioCapture: AudioCaptureConfig
  vad: {
    enabled: boolean
    speechThreshold: number
    silenceTimeoutMs: number
    minSpeechDurationMs: number
  }
  voiceCommands: Record<string, string>
  hotwords: HotwordScene[]
  textRules: TextRulesConfig
  asr: {
    mode: 'api' | 'local'    // 识别模式：远程 API 或本地模型
    localModel: string        // 本地模型标识，如 'paraformer-zh-contextual-quant'
    puncEnabled: boolean      // 本地识别是否启用 PUNC 标点恢复
  }
  onboarding?: OnboardingConfig
  llm: LlmConfig
  logging: LoggingConfig
}

// 默认配置
const defaultConfig: AppConfig = {
  server: { url: 'http://localhost:3000', asrConfigId: '' },
  hotkey: { record: 'Alt+Space' },
  input: { useClipboard: false },
  audioCapture: {
    inputConstraints: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    postRollMs: 200,
    tailSilenceMs: 120,
    workletFlushTimeoutMs: 220,
  },
  vad: {
    enabled: false,
    speechThreshold: 0.03,
    silenceTimeoutMs: 800,
    minSpeechDurationMs: 300,
  },
  voiceCommands: {
    肉眼所见: 'ALT+R',
    查询病人: 'ALT+Q',
    材块数: 'ALT+C',
    序列号: 'ALT+D',
    取材医生: 'ALT+E',
    上机状态: 'ALT+G',
    上一个: 'ALT+A',
    下一个: 'ALT+B',
    附言: 'ALT+F',
    保存报告: 'F2',
    保存下例: 'F4',
    病理号: 'F9',
    组织名称: 'F7',
    增加切片: 'F6',
  },
  hotwords: [{
    name: '全局',
    words: [
      '肉眼所见', '鳞状上皮', '腺体增生', '间质纤维化',
      '黏膜慢性炎', '淋巴细胞', '异型增生', '固有层',
      '肠上皮化生', '萎缩性胃炎', '幽门螺杆菌',
      '灰白色', '灰红色', '暗红色', '质软', '质硬', '质韧',
      '结节状', '息肉状', '乳头状', '菜花状',
    ],
  }],
  textRules: cloneTextRulesConfig(),
  asr: { mode: 'api', localModel: 'paraformer-zh-contextual-quant', puncEnabled: true },
  onboarding: {
    completed: false,
    completedAt: '',
    version: 1,
  },
  llm: {
    enabled: true,
    asrPostProcessEnabled: true,
    models: [
      {
        id: 'default-llm',
        name: '默认模型',
        baseUrl: '',
        apiKey: '',
        model: '',
        enabled: true,
      },
    ],
    taskBindings: {
      rewrite: 'default-llm',
      asrPostProcess: 'default-llm',
      dailySummary: 'default-llm',
    },
    prompts: cloneLlmPromptsConfig(),
  },
  logging: {
    enableDebug: false,
  },
}

// electron-store 实例
const store = new Store<AppConfig>({
  name: 'config',
  defaults: defaultConfig,
})

export function getConfig(): AppConfig {
  const cfg = store.store as AppConfig
  cfg.llm = normalizeLlmConfig(cfg.llm as unknown)
  cfg.textRules = normalizeTextRulesConfig(cfg.textRules as unknown)
  cfg.audioCapture = normalizeAudioCaptureConfig(cfg.audioCapture as unknown)
  if (!cfg.asr || typeof cfg.asr !== 'object') {
    cfg.asr = { ...defaultConfig.asr }
  }
  if (typeof cfg.asr.puncEnabled !== 'boolean') {
    cfg.asr.puncEnabled = true
  }
  if (!cfg.logging || typeof cfg.logging !== 'object') {
    cfg.logging = { ...defaultConfig.logging }
  }
  if (typeof cfg.logging.enableDebug !== 'boolean') {
    cfg.logging.enableDebug = false
  }
  cfg.onboarding = normalizeOnboardingConfig(cfg.onboarding)
  // 迁移旧模型 ID：本地识别仅保留 ONNX 量化热词模型。
  if (cfg.asr?.localModel !== 'paraformer-zh-contextual-quant') {
    cfg.asr.localModel = 'paraformer-zh-contextual-quant'
  }
  store.store = cfg
  return cfg
}

export function saveConfig(config: AppConfig): void {
  config.llm = normalizeLlmConfig(config.llm as unknown)
  config.textRules = normalizeTextRulesConfig(config.textRules as unknown)
  config.audioCapture = normalizeAudioCaptureConfig(config.audioCapture as unknown)
  if (!config.asr || typeof config.asr !== 'object') {
    config.asr = { ...defaultConfig.asr }
  }
  if (typeof config.asr.puncEnabled !== 'boolean') {
    config.asr.puncEnabled = true
  }
  if (!config.logging || typeof config.logging !== 'object') {
    config.logging = { ...defaultConfig.logging }
  }
  if (typeof config.logging.enableDebug !== 'boolean') {
    config.logging.enableDebug = false
  }
  config.onboarding = normalizeOnboardingConfig(config.onboarding)
  store.store = config
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeAudioInputConstraints(raw: unknown): AudioInputConstraintsConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    channelCount: Math.round(clampNumber(
      source.channelCount,
      defaultConfig.audioCapture.inputConstraints.channelCount,
      1,
      2,
    )),
    echoCancellation: typeof source.echoCancellation === 'boolean'
      ? source.echoCancellation
      : defaultConfig.audioCapture.inputConstraints.echoCancellation,
    noiseSuppression: typeof source.noiseSuppression === 'boolean'
      ? source.noiseSuppression
      : defaultConfig.audioCapture.inputConstraints.noiseSuppression,
    autoGainControl: typeof source.autoGainControl === 'boolean'
      ? source.autoGainControl
      : defaultConfig.audioCapture.inputConstraints.autoGainControl,
    deviceId: typeof source.deviceId === 'string' && source.deviceId ? source.deviceId : undefined,
  }
}

function normalizeAudioCaptureConfig(raw: unknown): AudioCaptureConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    inputConstraints: normalizeAudioInputConstraints(source.inputConstraints),
    postRollMs: Math.round(clampNumber(source.postRollMs, defaultConfig.audioCapture.postRollMs, 0, 1200)),
    tailSilenceMs: Math.round(clampNumber(source.tailSilenceMs, defaultConfig.audioCapture.tailSilenceMs, 0, 1200)),
    workletFlushTimeoutMs: Math.round(clampNumber(
      source.workletFlushTimeoutMs,
      defaultConfig.audioCapture.workletFlushTimeoutMs,
      80,
      2000,
    )),
  }
}

function normalizeOnboardingConfig(raw: unknown): OnboardingConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    completed: typeof source.completed === 'boolean'
      ? source.completed
      : defaultConfig.onboarding!.completed,
    completedAt: typeof source.completedAt === 'string'
      ? source.completedAt
      : defaultConfig.onboarding!.completedAt,
    version: Math.round(clampNumber(
      source.version,
      defaultConfig.onboarding!.version,
      1,
      999,
    )),
  }
}

function cloneTextRulesConfig(source: TextRulesConfig = DEFAULT_TEXT_RULES): TextRulesConfig {
  return {
    enabled: Boolean(source.enabled),
    rules: Array.isArray(source.rules)
      ? source.rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: Boolean(rule.enabled),
        type: 'sizeExpressionNormalize',
        options: {
          multiplicationWords: [...rule.options.multiplicationWords],
          rangeWords: [...rule.options.rangeWords],
          outputUnit: rule.options.outputUnit,
        },
      }))
      : [],
  }
}

function normalizeTokenList(raw: unknown, fallback: string[]): string[] {
  const source = Array.isArray(raw) ? raw : []
  const list: string[] = []
  const seen = new Set<string>()
  for (const token of source) {
    if (typeof token !== 'string') continue
    const value = token.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    list.push(value)
  }
  return list.length > 0 ? list : [...fallback]
}

function normalizeSingleTextRule(raw: unknown, index: number): TextRuleConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fallback = DEFAULT_TEXT_RULES.rules[0]
  const optionsRaw = (source.options && typeof source.options === 'object'
    ? source.options
    : {}) as Record<string, unknown>

  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : `text-rule-${index + 1}`
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `规则${index + 1}`
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true

  return {
    id,
    name,
    enabled,
    type: 'sizeExpressionNormalize',
    options: {
      multiplicationWords: normalizeTokenList(optionsRaw.multiplicationWords, fallback.options.multiplicationWords),
      rangeWords: normalizeTokenList(optionsRaw.rangeWords, fallback.options.rangeWords),
      outputUnit: typeof optionsRaw.outputUnit === 'string' && optionsRaw.outputUnit.trim()
        ? optionsRaw.outputUnit.trim().toUpperCase()
        : fallback.options.outputUnit,
    },
  }
}

function normalizeTextRulesConfig(raw: unknown): TextRulesConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_TEXT_RULES.enabled
  const rulesRaw = Array.isArray(source.rules) ? source.rules : DEFAULT_TEXT_RULES.rules
  const rules = rulesRaw.map((rule, index) => normalizeSingleTextRule(rule, index))
  return { enabled, rules }
}

function normalizeLlmConfig(raw: unknown): LlmConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>

  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true
  const models = normalizeModels(source)
  const modelIds = new Set(models.map((m) => m.id))
  const firstModelId = models[0]?.id || 'default-llm'

  const taskBindingsRaw = (source.taskBindings && typeof source.taskBindings === 'object'
    ? source.taskBindings
    : {}) as Record<string, any>

  const rewrite = typeof taskBindingsRaw.rewrite === 'string' && modelIds.has(taskBindingsRaw.rewrite)
    ? taskBindingsRaw.rewrite
    : firstModelId
  const asrPostProcess = typeof taskBindingsRaw.asrPostProcess === 'string' && modelIds.has(taskBindingsRaw.asrPostProcess)
    ? taskBindingsRaw.asrPostProcess
    : firstModelId
  const dailySummary = typeof taskBindingsRaw.dailySummary === 'string' && modelIds.has(taskBindingsRaw.dailySummary)
    ? taskBindingsRaw.dailySummary
    : firstModelId

  // 默认策略：若未显式配置开关，则当任一模型配置了 baseUrl 时默认开启。
  const hasAnyBaseUrl = models.some((m) => Boolean(m.baseUrl.trim()))
  const asrPostProcessEnabled = typeof source.asrPostProcessEnabled === 'boolean'
    ? source.asrPostProcessEnabled
    : hasAnyBaseUrl

  return {
    enabled,
    asrPostProcessEnabled,
    models,
    taskBindings: {
      rewrite,
      asrPostProcess,
      dailySummary,
    },
    prompts: normalizePrompts(source.prompts),
  }
}

function cloneLlmPromptsConfig(source: LlmPromptsConfig = DEFAULT_LLM_PROMPTS): LlmPromptsConfig {
  return {
    rewrite: { ...source.rewrite },
    asrPostProcess: { ...source.asrPostProcess },
    dailySummary: { ...source.dailySummary },
  }
}

function normalizeTaskPrompt(raw: unknown, fallback: LlmTaskPromptConfig): LlmTaskPromptConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    systemPrompt: typeof source.systemPrompt === 'string' ? source.systemPrompt : fallback.systemPrompt,
    userPromptTemplate: typeof source.userPromptTemplate === 'string'
      ? source.userPromptTemplate
      : fallback.userPromptTemplate,
  }
}

function normalizePrompts(raw: unknown): LlmPromptsConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    rewrite: normalizeTaskPrompt(source.rewrite, DEFAULT_LLM_PROMPTS.rewrite),
    asrPostProcess: normalizeTaskPrompt(source.asrPostProcess, DEFAULT_LLM_PROMPTS.asrPostProcess),
    dailySummary: normalizeTaskPrompt(source.dailySummary, DEFAULT_LLM_PROMPTS.dailySummary),
  }
}

function normalizeModels(source: Record<string, any>): LlmModelConfig[] {
  const rawModels = Array.isArray(source.models) ? source.models : []
  const normalized: LlmModelConfig[] = []
  const usedIds = new Set<string>()

  const pushModel = (model: Partial<LlmModelConfig>, fallbackIndex: number) => {
    let id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) id = `llm-${fallbackIndex + 1}`
    if (usedIds.has(id)) id = `${id}-${fallbackIndex + 1}`
    usedIds.add(id)
    normalized.push({
      id,
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : `模型${fallbackIndex + 1}`,
      baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : '',
      apiKey: typeof model.apiKey === 'string' ? model.apiKey : '',
      model: typeof model.model === 'string' ? model.model : '',
      enabled: typeof model.enabled === 'boolean' ? model.enabled : true,
    })
  }

  for (let i = 0; i < rawModels.length; i += 1) {
    const item = rawModels[i]
    if (!item || typeof item !== 'object') continue
    pushModel(item as Partial<LlmModelConfig>, normalized.length)
  }

  // 兼容旧结构（单模型）
  if (normalized.length === 0) {
    const oldBaseUrl = typeof source.baseUrl === 'string' ? source.baseUrl : ''
    const oldApiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
    const oldModel = typeof source.model === 'string' ? source.model : ''
    pushModel({
      id: 'default-llm',
      name: '默认模型',
      baseUrl: oldBaseUrl,
      apiKey: oldApiKey,
      model: oldModel,
      enabled: true,
    }, 0)
  }

  return normalized
}
