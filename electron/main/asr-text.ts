export function normalizeAsrText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }

  if (Array.isArray(value)) {
    if (
      value.length >= 2 &&
      typeof value[0] === 'string' &&
      value.slice(1).some((item) => typeof item !== 'string')
    ) {
      const first = value[0].trim()
      if (first) return first
    }
    return value.map(normalizeAsrText).filter(Boolean).join('')
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['text', 'preds', 'pred', 'sentence', 'transcript']) {
      if (key in record) {
        const normalized = normalizeAsrText(record[key])
        if (normalized) return normalized
      }
    }
    return ''
  }

  return String(value)
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

const CHINESE_DIGIT_MAP: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const CHINESE_UNIT_MAP: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
}

export function applyTextRules(text: string, config?: TextRulesConfig | null): string {
  const raw = typeof text === 'string' ? text : ''
  if (!raw.trim() || !config?.enabled || !Array.isArray(config.rules)) {
    return raw
  }

  let output = raw
  for (const rule of config.rules) {
    if (!rule || rule.enabled === false) continue
    if (rule.type === 'sizeExpressionNormalize') {
      output = applySizeExpressionRule(output, rule.options)
    }
  }
  return output
}

function applySizeExpressionRule(text: string, options?: SizeExpressionRuleOptions): string {
  const outputUnit = normalizeOutputUnit(options?.outputUnit)
  const multiplicationWords = normalizeTokenList(
    options?.multiplicationWords,
    ['乘以', '乘', 'x', 'X', '×', '*'],
  )
  const rangeWords = normalizeTokenList(
    options?.rangeWords,
    ['到', '至', '-', '~', '～', '—', '－'],
  )

  let output = text
  output = normalizePlainMultiplicationExpressions(output, multiplicationWords)
  output = normalizeMeasurementTokens(output, outputUnit)
  output = normalizeRangeExpressions(output, outputUnit, rangeWords)
  output = normalizeMultiplicationExpressions(output, outputUnit, multiplicationWords)
  return output
}

function normalizeMeasurementTokens(text: string, outputUnit: string): string {
  return text.replace(
    /([零〇一二两三四五六七八九十百千万点\d.]+)\s*(厘米|公分|厘|cm|CM)/gu,
    (_full, rawNumber: string) => {
      const parsed = parseNumberPhrase(rawNumber)
      if (parsed == null) return `${rawNumber}${outputUnit}`
      return `${formatNumber(parsed)}${outputUnit}`
    },
  )
}

function normalizePlainMultiplicationExpressions(text: string, multiplicationWords: string[]): string {
  const rawWords = multiplicationWords
    .map((word) => String(word || '').trim())
    .filter((word) => Boolean(word) && word !== '×')
  const words = rawWords.map(escapeRegex).sort((a, b) => b.length - a.length)
  const connectorPattern = words.length > 0 ? words.join('|') : '乘以|乘|x|X|\\*'
  const numberPattern = '([零〇一二两三四五六七八九十百千万点\\d.]+)'
  const pattern = new RegExp(
    `${numberPattern}(?:\\s*[，,、]\\s*)?(?:${connectorPattern})(?:\\s*[，,、]\\s*)?${numberPattern}`,
    'gu',
  )

  let output = text
  while (true) {
    pattern.lastIndex = 0
    const next = output.replace(pattern, (full, leftRaw: string, rightRaw: string) => {
      const left = parseNumberPhrase(leftRaw)
      const right = parseNumberPhrase(rightRaw)
      if (left == null || right == null) return full
      return `${formatNumber(left)}×${formatNumber(right)}`
    })
    if (next === output) break
    output = next
  }
  return output
}

function normalizeRangeExpressions(text: string, outputUnit: string, rangeWords: string[]): string {
  const unit = escapeRegex(outputUnit)
  const words = rangeWords.map(escapeRegex).sort((a, b) => b.length - a.length)
  const connectorPattern = words.length > 0 ? words.join('|') : '到|至|-|~|～|—|－'
  const pattern = new RegExp(
    `(\\d+(?:\\.\\d+)?${unit})\\s*(?:${connectorPattern})\\s*(\\d+(?:\\.\\d+)?${unit})`,
    'gu',
  )
  return text.replace(pattern, '$1-$2')
}

function normalizeMultiplicationExpressions(text: string, outputUnit: string, multiplicationWords: string[]): string {
  const unit = escapeRegex(outputUnit)
  const rawWords = multiplicationWords
    .map((word) => String(word || '').trim())
    .filter((word) => Boolean(word) && word !== '×')
  const words = rawWords.map(escapeRegex).sort((a, b) => b.length - a.length)
  const connectorPattern = words.length > 0 ? words.join('|') : '乘以|乘|x|X|\\*'
  const pattern = new RegExp(
    `(\\d+(?:\\.\\d+)?${unit})(?:\\s*[，,、]\\s*)?(?:${connectorPattern})(?:\\s*[，,、]\\s*)?(\\d+(?:\\.\\d+)?${unit})`,
    'gu',
  )

  let output = text
  while (true) {
    pattern.lastIndex = 0
    const next = output.replace(pattern, '$1×$2')
    if (next === output) break
    output = next
  }
  return output
}

function parseNumberPhrase(raw: string): number | null {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  if (/^[零〇一二两三四五六七八九十百千万点]+$/.test(text)) {
    return parseChineseNumber(text)
  }
  return null
}

function parseChineseNumber(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null

  if (text.includes('点')) {
    const [intPartRaw, fracPartRaw] = text.split('点')
    if (fracPartRaw == null) return null
    const intPart = intPartRaw.trim()
    const fracPart = fracPartRaw.trim()
    const parsedInt = intPart ? parseChineseInteger(intPart) : 0
    if (parsedInt == null) return null
    const fracDigits = parseChineseFraction(fracPart)
    if (!fracDigits) return null
    return Number(`${parsedInt}.${fracDigits}`)
  }

  return parseChineseInteger(text)
}

function parseChineseFraction(raw: string): string | null {
  if (!raw) return null
  let digits = ''
  for (const ch of raw) {
    if (/\d/.test(ch)) {
      digits += ch
      continue
    }
    if (!(ch in CHINESE_DIGIT_MAP)) return null
    digits += String(CHINESE_DIGIT_MAP[ch])
  }
  return digits || null
}

function parseChineseInteger(raw: string): number | null {
  const text = raw.trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)

  let total = 0
  let section = 0
  let number = 0

  for (const ch of text) {
    if (ch in CHINESE_DIGIT_MAP) {
      number = CHINESE_DIGIT_MAP[ch]
      continue
    }

    if (ch in CHINESE_UNIT_MAP) {
      const unit = CHINESE_UNIT_MAP[ch]
      if (number === 0) number = 1
      section += number * unit
      number = 0
      continue
    }

    if (ch === '万') {
      section += number
      if (section === 0) section = 1
      total += section * 10000
      section = 0
      number = 0
      continue
    }

    return null
  }

  return total + section + number
}

function normalizeOutputUnit(raw: string | undefined): string {
  const unit = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : 'CM'
  return unit
}

function normalizeTokenList(source: string[] | undefined, fallback: string[]): string[] {
  const values = Array.isArray(source) ? source : []
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const token = String(raw || '').trim()
    if (!token || seen.has(token)) continue
    seen.add(token)
    result.push(token)
  }
  return result.length > 0 ? result : [...fallback]
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(value).replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
