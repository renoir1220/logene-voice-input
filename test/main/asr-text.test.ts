import { describe, expect, it } from 'vitest'
import { normalizeAsrText, applyTextRules } from '../../electron/main/asr-text'

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

describe('applyTextRules', () => {
  const textRulesConfig = {
    enabled: true,
    rules: [
      {
        id: 'size-normalize-default',
        name: '尺寸表达标准化',
        enabled: true,
        type: 'sizeExpressionNormalize' as const,
        options: {
          multiplicationWords: ['乘以', '乘', 'x', 'X', '×', '*'],
          rangeWords: ['到', '至', '-', '~', '～', '—', '－'],
          outputUnit: 'CM',
        },
      },
    ],
  }

  it('可把中文尺寸表达转换为阿拉伯数字+乘号+CM', () => {
    const input = '全子宫十六厘米乘以十二厘米乘以九厘米，内膜厚约零点四厘米'
    const output = applyTextRules(input, textRulesConfig)
    expect(output).toContain('16CM×12CM×9CM')
    expect(output).toContain('0.4CM')
  })

  it('支持“乘”作为连接词，且可处理逗号断开的表达', () => {
    const input = '直径零点二厘米到三厘米，乘两厘米，乘两厘米'
    const output = applyTextRules(input, textRulesConfig)
    expect(output).toContain('0.2CM-3CM')
    expect(output).toContain('3CM×2CM×2CM')
  })

  it('支持“厘”单位与无单位乘法表达', () => {
    const input = '六十厘米乘以七十厘米乘以八十厘。六十厘米乘以七十厘。六十乘以七。'
    const output = applyTextRules(input, textRulesConfig)
    expect(output).toContain('60CM×70CM×80CM')
    expect(output).toContain('60CM×70CM')
    expect(output).toContain('60×7')
  })

  it('总开关关闭时不改写文本', () => {
    const input = '十六厘米乘以十二厘米'
    const output = applyTextRules(input, { ...textRulesConfig, enabled: false })
    expect(output).toBe(input)
  })
})
