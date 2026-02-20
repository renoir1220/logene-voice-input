import { describe, it, expect } from 'vitest'
import { matchVoiceCommand } from '../../electron/main/voice-commands'

const commands = {
  肉眼所见: 'ALT+R',
  查询病人: 'ALT+Q',
  保存报告: 'F2',
  上一个: 'ALT+A',
}

describe('matchVoiceCommand', () => {
  describe('精确匹配', () => {
    it('命中指令返回 command 类型', () => {
      const r = matchVoiceCommand('肉眼所见', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'ALT+R' })
    })

    it('F 键指令', () => {
      const r = matchVoiceCommand('保存报告', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'F2' })
    })

    it('未命中返回 text 类型', () => {
      const r = matchVoiceCommand('你好世界', commands)
      expect(r).toEqual({ type: 'text', text: '你好世界' })
    })
  })

  describe('标点去除', () => {
    it('尾部中文句号', () => {
      const r = matchVoiceCommand('肉眼所见。', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'ALT+R' })
    })

    it('尾部逗号', () => {
      const r = matchVoiceCommand('查询病人，', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'ALT+Q' })
    })

    it('首尾空格', () => {
      const r = matchVoiceCommand('  保存报告  ', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'F2' })
    })

    it('首尾空格 + 标点', () => {
      const r = matchVoiceCommand('  上一个。  ', commands)
      expect(r).toEqual({ type: 'command', shortcut: 'ALT+A' })
    })

    it('未命中时保留原始 trim 文本（不去标点）', () => {
      const r = matchVoiceCommand('  你好。  ', commands)
      expect(r).toEqual({ type: 'text', text: '你好。' })
    })
  })

  describe('边界情况', () => {
    it('空字符串返回 text', () => {
      const r = matchVoiceCommand('', commands)
      expect(r.type).toBe('text')
    })

    it('空指令表不崩溃', () => {
      const r = matchVoiceCommand('肉眼所见', {})
      expect(r).toEqual({ type: 'text', text: '肉眼所见' })
    })

    it('只有标点的输入', () => {
      const r = matchVoiceCommand('。，！', commands)
      expect(r.type).toBe('text')
    })
  })
})
