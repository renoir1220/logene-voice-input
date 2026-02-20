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
