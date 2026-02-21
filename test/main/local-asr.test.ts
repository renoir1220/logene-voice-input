import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

// mock logger
vi.mock('../../electron/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// mock electron app
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/fake/userData' },
}))

// mock config
vi.mock('../../electron/main/config', () => ({
  getConfig: vi.fn(() => ({
    hotwords: [
      { name: '全局', words: ['肉眼所见', '鳞状上皮'] },
      { name: '胃镜', words: ['萎缩性胃炎'] },
    ],
  })),
}))

// mock model-manager
vi.mock('../../electron/main/model-manager', () => ({
  MODELS: [
    {
      id: 'paraformer-zh',
      name: 'Paraformer 中文 (标准)',
      funasrModel: 'paraformer-zh',
      description: '标准中文模型，VAD+标点，支持热词',
      size: '~1 GB',
      backend: 'funasr_torch',
      hotwordFormat: 'weighted-lines',
      vadModel: 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
      vadBackend: 'funasr_onnx_vad',
      vadQuantized: true,
      puncModel: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
      puncBackend: 'funasr_torch_punc',
    },
    {
      id: 'paraformer-zh-contextual-quant',
      name: 'Paraformer 中文 (量化+热词)',
      funasrModel: 'iic/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx',
      description: 'ONNX INT8 上下文版，支持热词注入',
      size: '~860 MB',
      backend: 'funasr_onnx_contextual',
      hotwordFormat: 'space-separated',
      quantized: true,
      vadModel: 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
      vadBackend: 'funasr_onnx_vad',
      vadQuantized: true,
      puncModel: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
      puncBackend: 'funasr_torch_punc',
    },
    {
      id: 'sensevoice-small',
      name: 'SenseVoice (小)',
      funasrModel: 'iic/SenseVoiceSmall',
      description: '多语言模型，支持热词',
      size: '~450 MB',
      backend: 'funasr_torch',
      hotwordFormat: 'weighted-lines',
      vadModel: 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
      vadBackend: 'funasr_onnx_vad',
      vadQuantized: true,
      puncModel: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
      puncBackend: 'funasr_torch_punc',
    },
  ],
}))

// 模拟 sidecar 子进程
function createMockProcess(): ChildProcess & { _emit: (event: string, data?: any) => void } {
  const proc = new EventEmitter() as any
  proc.stdin = { writable: true, write: vi.fn() }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  proc.pid = 12345

  // 辅助方法：模拟 stdout 输出
  proc._emit = (event: string, data?: any) => {
    if (event === 'stdout') {
      proc.stdout.emit('data', Buffer.from(data + '\n'))
    } else if (event === 'stderr') {
      proc.stderr.emit('data', Buffer.from(data))
    } else {
      proc.emit(event, data)
    }
  }
  return proc
}

let mockProc: ReturnType<typeof createMockProcess>
const spawnMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}))

describe('local-asr (sidecar + FunASR)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.useRealTimers()

    mockProc = createMockProcess()
    spawnMock.mockReturnValue(mockProc)
  })

  afterEach(async () => {
    vi.useRealTimers()
    const { disposeLocalRecognizer } = await import('../../electron/main/local-asr')
    disposeLocalRecognizer()
  })

  it('initLocalRecognizer 启动 sidecar 并发送 init（含 modelName 和 hotwords）', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh')

    // 模拟 sidecar 就绪
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')

    // 模拟 init 响应
    await new Promise(r => setTimeout(r, 10))
    const writeCall = mockProc.stdin.write.mock.calls[0][0]
    const req = JSON.parse(writeCall)
    expect(req.cmd).toBe('init')
    expect(req.modelName).toBe('paraformer-zh')
    expect(req.vadModelName).toBe('iic/speech_fsmn_vad_zh-cn-16k-common-onnx')
    expect(req.vadBackend).toBe('funasr_onnx_vad')
    expect(req.vadQuantize).toBe(true)
    expect(req.puncModelName).toBe('iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch')
    expect(req.puncBackend).toBe('funasr_torch_punc')
    // 所有模型都传热词
    expect(req.hotwords).toContain('肉眼所见')
    expect(req.hotwords).toContain('鳞状上皮')
    expect(req.hotwords).toContain('萎缩性胃炎')
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: true }))

    await initPromise

    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('sensevoice 模型同样传递热词', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('sensevoice-small')

    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')

    await new Promise(r => setTimeout(r, 10))
    const writeCall = mockProc.stdin.write.mock.calls[0][0]
    const req = JSON.parse(writeCall)
    expect(req.cmd).toBe('init')
    expect(req.modelName).toBe('iic/SenseVoiceSmall')
    expect(req.vadModelName).toBe('iic/speech_fsmn_vad_zh-cn-16k-common-onnx')
    expect(req.vadBackend).toBe('funasr_onnx_vad')
    expect(req.vadQuantize).toBe(true)
    expect(req.puncModelName).toBe('iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch')
    expect(req.puncBackend).toBe('funasr_torch_punc')
    expect(req.hotwords).toContain('肉眼所见')
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: true }))

    await initPromise
  })

  it('量化+热词 ONNX 模型应传递空格分隔热词', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh-contextual-quant')

    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')

    await new Promise(r => setTimeout(r, 10))
    const writeCall = mockProc.stdin.write.mock.calls[0][0]
    const req = JSON.parse(writeCall)
    expect(req.cmd).toBe('init')
    expect(req.modelName).toBe('iic/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx')
    expect(req.backend).toBe('funasr_onnx_contextual')
    expect(req.quantize).toBe(true)
    expect(req.vadBackend).toBe('funasr_onnx_vad')
    expect(req.vadQuantize).toBe(true)
    expect(req.puncBackend).toBe('funasr_torch_punc')
    expect(req.hotwords).toContain('肉眼所见')
    expect(req.hotwords).toContain('鳞状上皮')
    expect(req.hotwords).toContain('萎缩性胃炎')
    // contextual onnx 需空格分隔
    expect(req.hotwords).not.toContain('\n')
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: true }))

    await initPromise
  })

  it('recognizeLocal 发送 wavBase64 并返回识别文本', async () => {
    const { initLocalRecognizer, recognizeLocal } = await import('../../electron/main/local-asr')

    // 先初始化
    const initPromise = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))
    const initReq = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: initReq.id, ok: true }))
    await initPromise

    // 识别
    const wavBuf = Buffer.alloc(100, 0)
    const recPromise = recognizeLocal(wavBuf)

    await new Promise(r => setTimeout(r, 10))
    const recReq = JSON.parse(mockProc.stdin.write.mock.calls[1][0])
    expect(recReq.cmd).toBe('recognize')
    expect(recReq.wavBase64).toBe(wavBuf.toString('base64'))
    mockProc._emit('stdout', JSON.stringify({ id: recReq.id, ok: true, text: '肉眼所见' }))

    const text = await recPromise
    expect(text).toBe('肉眼所见')
  })

  it('recognizeLocal 应规范化结构化文本结果', async () => {
    const { initLocalRecognizer, recognizeLocal } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh-contextual-quant')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))
    const initReq = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: initReq.id, ok: true }))
    await initPromise

    const recPromise = recognizeLocal(Buffer.alloc(100, 0))
    await new Promise(r => setTimeout(r, 10))
    const recReq = JSON.parse(mockProc.stdin.write.mock.calls[1][0])
    mockProc._emit('stdout', JSON.stringify({ id: recReq.id, ok: true, text: ['你好世界', ['你', '好', '世', '界']] }))

    const text = await recPromise
    expect(text).toBe('你好世界')
  })

  it('未初始化时 recognizeLocal 抛出错误', async () => {
    const { recognizeLocal } = await import('../../electron/main/local-asr')
    await expect(recognizeLocal(Buffer.alloc(10))).rejects.toThrow('未初始化')
  })

  it('未知模型 ID 时抛出错误', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')
    await expect(initLocalRecognizer('nonexistent-model')).rejects.toThrow('未知模型')
  })

  it('sidecar 崩溃时拒绝等待中的请求', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))

    // sidecar 在 init 请求发出后崩溃
    mockProc.emit('exit', 1)

    await expect(initPromise).rejects.toThrow('意外退出')
  })

  it('sidecar init 返回错误时抛出模型初始化失败', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh-contextual-quant')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))

    const req = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: false, error: 'context model load failed' }))

    await expect(initPromise).rejects.toThrow(/本地模型初始化失败.*context model load failed/)
  })

  it('sidecar 结构化错误应透传 code/phase 摘要', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))

    const req = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({
      id: req.id,
      ok: false,
      error: {
        code: 'PUNC_MODEL_INIT_FAILED',
        phase: 'init/punc',
        message: 'PUNC 模型初始化失败',
        details: 'Traceback\\nRuntimeError: CTTransformer is not registered',
      },
    }))

    await expect(initPromise).rejects.toThrow(/PUNC 模型初始化失败.*code=PUNC_MODEL_INIT_FAILED.*phase=init\/punc/)
  })

  it('重复初始化同一模型不会重新发送 init', async () => {
    const { initLocalRecognizer } = await import('../../electron/main/local-asr')

    // 第一次初始化
    const p1 = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))
    const req1 = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: req1.id, ok: true }))
    await p1

    // 第二次初始化同一模型
    await initLocalRecognizer('paraformer-zh')

    // stdin.write 只被调用一次（init 命令）
    expect(mockProc.stdin.write).toHaveBeenCalledTimes(1)
  })

  it('checkModelDownloaded 通过 sidecar check 命令查询', async () => {
    const { checkModelDownloaded } = await import('../../electron/main/local-asr')

    const checkPromise = checkModelDownloaded('paraformer-zh')

    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')

    await new Promise(r => setTimeout(r, 10))
    const writeCall = mockProc.stdin.write.mock.calls[0][0]
    const req = JSON.parse(writeCall)
    expect(req.cmd).toBe('check')
    expect(req.modelName).toBe('paraformer-zh')
    expect(req.vadModelName).toBe('iic/speech_fsmn_vad_zh-cn-16k-common-onnx')
    expect(req.vadBackend).toBe('funasr_onnx_vad')
    expect(req.vadQuantize).toBe(true)
    expect(req.puncModelName).toBe('iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch')
    expect(req.puncBackend).toBe('funasr_torch_punc')
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: true, downloaded: true }))

    const result = await checkPromise
    expect(result).toBe(true)
  })

  it('checkModelStatus 返回完整性详情', async () => {
    const { checkModelStatus } = await import('../../electron/main/local-asr')

    const checkPromise = checkModelStatus('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))

    const req = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({
      id: req.id,
      ok: true,
      downloaded: false,
      incomplete: true,
      dependencies: [
        {
          role: 'ASR',
          modelName: 'paraformer-zh',
          backend: 'funasr_torch',
          quantize: false,
          cached: true,
          complete: false,
          issue: '缺少文件',
        },
      ],
    }))

    const status = await checkPromise
    expect(status.downloaded).toBe(false)
    expect(status.incomplete).toBe(true)
    expect(status.dependencies[0].role).toBe('ASR')
  })

  it('recognizeLocal 在 sidecar 返回错误时应抛出异常', async () => {
    const { initLocalRecognizer, recognizeLocal } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))
    const initReq = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: initReq.id, ok: true }))
    await initPromise

    const recPromise = recognizeLocal(Buffer.alloc(128))
    await new Promise(r => setTimeout(r, 10))
    const recReq = JSON.parse(mockProc.stdin.write.mock.calls[1][0])
    mockProc._emit('stdout', JSON.stringify({ id: recReq.id, ok: false, error: 'wav decode failed' }))

    await expect(recPromise).rejects.toThrow('wav decode failed')
  })

  it('请求超时应附带最近 sidecar stderr 摘要', async () => {
    vi.useFakeTimers()
    const { initLocalRecognizer, recognizeLocal } = await import('../../electron/main/local-asr')

    const initPromise = initLocalRecognizer('paraformer-zh')
    await vi.advanceTimersByTimeAsync(20)
    mockProc._emit('stdout', '{"ready":true}')
    await vi.advanceTimersByTimeAsync(20)
    const initReq = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: initReq.id, ok: true }))
    await initPromise

    const recPromise = recognizeLocal(Buffer.alloc(128))
    const expectRejected = expect(recPromise).rejects.toThrow(/sidecar 请求超时 \(120000ms\).*stderr: .*RuntimeError: sidecar crashed/)
    await vi.advanceTimersByTimeAsync(20)
    mockProc._emit('stderr', 'Traceback (most recent call last):\\n')
    mockProc._emit('stderr', 'RuntimeError: sidecar crashed')

    await vi.advanceTimersByTimeAsync(120001)
    await expectRejected
  })

  it('disposeLocalRecognizer 发送 dispose 并杀掉进程', async () => {
    const { initLocalRecognizer, disposeLocalRecognizer } = await import('../../electron/main/local-asr')

    const p = initLocalRecognizer('paraformer-zh')
    await new Promise(r => setTimeout(r, 10))
    mockProc._emit('stdout', '{"ready":true}')
    await new Promise(r => setTimeout(r, 10))
    const req = JSON.parse(mockProc.stdin.write.mock.calls[0][0])
    mockProc._emit('stdout', JSON.stringify({ id: req.id, ok: true }))
    await p

    disposeLocalRecognizer()

    // 验证发送了 dispose 命令
    const lastWrite = mockProc.stdin.write.mock.calls[mockProc.stdin.write.mock.calls.length - 1][0]
    const disposeReq = JSON.parse(lastWrite)
    expect(disposeReq.cmd).toBe('dispose')
  })
})
