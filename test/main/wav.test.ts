import { describe, it, expect } from 'vitest'
import { encodeWav } from '../../src/wav'

// 解析 WAV 文件头
function parseWavHeader(buf: ArrayBuffer) {
  const view = new DataView(buf)
  const readStr = (offset: number, len: number) =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('')
  return {
    riff: readStr(0, 4),
    fileSize: view.getUint32(4, true),
    wave: readStr(8, 4),
    fmt: readStr(12, 4),
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: readStr(36, 4),
    dataSize: view.getUint32(40, true),
  }
}

describe('encodeWav', () => {
  describe('文件头格式', () => {
    it('RIFF/WAVE 标识正确', () => {
      const buf = encodeWav([])
      const h = parseWavHeader(buf)
      expect(h.riff).toBe('RIFF')
      expect(h.wave).toBe('WAVE')
      expect(h.fmt).toBe('fmt ')
      expect(h.data).toBe('data')
    })

    it('PCM 格式（audioFormat=1）', () => {
      const h = parseWavHeader(encodeWav([]))
      expect(h.audioFormat).toBe(1)
    })

    it('单声道', () => {
      const h = parseWavHeader(encodeWav([]))
      expect(h.channels).toBe(1)
    })

    it('采样率 16000', () => {
      const h = parseWavHeader(encodeWav([]))
      expect(h.sampleRate).toBe(16000)
    })

    it('16-bit 采样', () => {
      const h = parseWavHeader(encodeWav([]))
      expect(h.bitsPerSample).toBe(16)
    })

    it('byteRate = sampleRate * 2', () => {
      const h = parseWavHeader(encodeWav([]))
      expect(h.byteRate).toBe(16000 * 2)
    })
  })

  describe('数据大小', () => {
    it('空输入：总大小 44 字节', () => {
      const buf = encodeWav([])
      expect(buf.byteLength).toBe(44)
    })

    it('100 个采样：总大小 44 + 200 字节', () => {
      const chunk = new Float32Array(100)
      const buf = encodeWav([chunk])
      expect(buf.byteLength).toBe(44 + 200)
    })

    it('多个 chunk 合并正确', () => {
      const a = new Float32Array(50)
      const b = new Float32Array(30)
      const buf = encodeWav([a, b])
      expect(buf.byteLength).toBe(44 + 160)
      const h = parseWavHeader(buf)
      expect(h.dataSize).toBe(160)
    })

    it('fileSize = 36 + dataSize', () => {
      const chunk = new Float32Array(100)
      const h = parseWavHeader(encodeWav([chunk]))
      expect(h.fileSize).toBe(36 + h.dataSize)
    })
  })

  describe('PCM 编码', () => {
    it('正值 1.0 → 0x7fff', () => {
      const chunk = new Float32Array([1.0])
      const buf = encodeWav([chunk])
      const view = new DataView(buf)
      expect(view.getInt16(44, true)).toBe(0x7fff)
    })

    it('负值 -1.0 → -0x8000', () => {
      const chunk = new Float32Array([-1.0])
      const buf = encodeWav([chunk])
      const view = new DataView(buf)
      expect(view.getInt16(44, true)).toBe(-0x8000)
    })

    it('零值 → 0', () => {
      const chunk = new Float32Array([0])
      const buf = encodeWav([chunk])
      const view = new DataView(buf)
      expect(view.getInt16(44, true)).toBe(0)
    })

    it('超出范围的值被 clamp', () => {
      const chunk = new Float32Array([2.0, -2.0])
      const buf = encodeWav([chunk])
      const view = new DataView(buf)
      expect(view.getInt16(44, true)).toBe(0x7fff)
      expect(view.getInt16(46, true)).toBe(-0x8000)
    })

    it('多 chunk 数据顺序正确', () => {
      const a = new Float32Array([1.0])
      const b = new Float32Array([-1.0])
      const buf = encodeWav([a, b])
      const view = new DataView(buf)
      expect(view.getInt16(44, true)).toBe(0x7fff)
      expect(view.getInt16(46, true)).toBe(-0x8000)
    })
  })
})
