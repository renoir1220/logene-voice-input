import { describe, expect, it } from 'vitest'
import { normalizeAsrText } from '../../electron/main/asr-text'

describe('normalizeAsrText', () => {
  it('字符串原样返回', () => {
    expect(normalizeAsrText('你好')).toBe('你好')
  })

  it('ContextualParaformer tuple 风格结果应取首个完整字符串', () => {
    expect(normalizeAsrText(['你好世界', ['你', '好', '世', '界']])).toBe('你好世界')
  })

  it('字符数组应拼接为连续文本', () => {
    expect(normalizeAsrText(['你', '好'])).toBe('你好')
  })

  it('字典结果应优先抽取 text/preds', () => {
    expect(normalizeAsrText({ preds: ['医', '生'] })).toBe('医生')
    expect(normalizeAsrText({ text: '测试' })).toBe('测试')
  })
})
