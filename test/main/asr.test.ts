import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recognize } from '../../electron/main/asr'

// 构造最小有效 WAV Buffer（静音）
function makeSilenceWav(samples = 160): Buffer {
  const buf = Buffer.alloc(44 + samples * 2, 0)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  return buf
}

describe('recognize', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('成功识别返回文本', async () => {
    // mock 全局 fetch
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: '肉眼所见' } }),
    }))

    const result = await recognize('http://localhost:3000', '', makeSilenceWav())
    expect(result).toBe('肉眼所见')
  })

  it('发送正确的 URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: 'ok' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await recognize('http://example.com/', '', makeSilenceWav())
    const [url] = mockFetch.mock.calls[0]
    expect(url).toBe('http://example.com/api/tasks/asr-recognize/sync')
  })

  it('asrConfigId 非空时附加到 form', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: 'ok' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await recognize('http://localhost:3000', 'cfg-123', makeSilenceWav())
    const [, init] = mockFetch.mock.calls[0]
    const body = init.body as FormData
    expect(body.get('asrConfigId')).toBe('cfg-123')
  })

  it('asrConfigId 为空时不附加字段', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: 'ok' } }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await recognize('http://localhost:3000', '', makeSilenceWav())
    const [, init] = mockFetch.mock.calls[0]
    const body = init.body as FormData
    expect(body.get('asrConfigId')).toBeNull()
  })

  it('HTTP 非 2xx 时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))

    await expect(recognize('http://localhost:3000', '', makeSilenceWav()))
      .rejects.toThrow('500')
  })

  it('success=false 时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false, message: '音频太短' }),
    }))

    await expect(recognize('http://localhost:3000', '', makeSilenceWav()))
      .rejects.toThrow('音频太短')
  })

  it('响应无 data 字段时抛出错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }))

    await expect(recognize('http://localhost:3000', '', makeSilenceWav()))
      .rejects.toThrow('data')
  })

  it('网络错误时抛出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(recognize('http://localhost:3000', '', makeSilenceWav()))
      .rejects.toThrow('ECONNREFUSED')
  })
})
