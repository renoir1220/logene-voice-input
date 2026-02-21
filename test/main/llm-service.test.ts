import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const getConfigMock = vi.fn(() => ({
  llm: {
    enabled: true,
    asrPostProcessEnabled: true,
    models: [
      {
        id: 'default-llm',
        name: '默认模型',
        baseUrl: 'https://example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        enabled: true,
      },
    ],
    taskBindings: {
      rewrite: 'default-llm',
      asrPostProcess: 'default-llm',
      dailySummary: 'default-llm',
    },
    prompts: {
      rewrite: {
        systemPrompt: 'rewrite-system',
        userPromptTemplate: 'i={{instruction}};t={{selectedText}}',
      },
      asrPostProcess: {
        systemPrompt: 'asr-system',
        userPromptTemplate: 'text={{text}}',
      },
      dailySummary: {
        systemPrompt: 'sum-system',
        userPromptTemplate: 'count={{count}}\n{{records}}',
      },
    },
  },
}))

vi.mock('../../electron/main/config', () => ({
  getConfig: getConfigMock,
  DEFAULT_LLM_PROMPTS: {
    rewrite: {
      systemPrompt: 'fallback-rewrite-system',
      userPromptTemplate: 'fallback {{instruction}} {{selectedText}}',
    },
    asrPostProcess: {
      systemPrompt: 'fallback-asr-system',
      userPromptTemplate: 'fallback {{text}}',
    },
    dailySummary: {
      systemPrompt: 'fallback-summary-system',
      userPromptTemplate: 'fallback {{count}} {{records}}',
    },
  },
}))

vi.mock('../../electron/main/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

function buildStreamResponse(chunks: string[]) {
  let index = 0
  const reader = {
    read: vi.fn(async () => {
      if (index >= chunks.length) return { done: true, value: undefined }
      const value = Buffer.from(chunks[index], 'utf-8')
      index += 1
      return { done: false, value }
    }),
    releaseLock: vi.fn(),
  }
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => reader,
    },
  }
}

describe('llm-service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    getConfigMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rewriteText 可正确拼接跨 chunk 的 SSE token', async () => {
    const response = buildStreamResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"d',
      'elta":{"content":"好"}}]}\n',
      'data: [DONE]\n',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { rewriteText } = await import('../../electron/main/llm-service')
    const onChunk = vi.fn()
    const result = await rewriteText({
      text: 'original',
      instruction: 'rewrite',
      onChunk,
    })

    expect(result).toBe('你好')
    expect(onChunk.mock.calls.map((args) => String(args[0])).join('')).toBe('你好')
  })

  it('rewriteText 可处理流末尾无换行的 SSE 数据', async () => {
    const response = buildStreamResponse([
      'data: {"choices":[{"delta":{"content":"末"}}]}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const { rewriteText } = await import('../../electron/main/llm-service')
    const onChunk = vi.fn()
    const result = await rewriteText({
      text: 'original',
      instruction: 'rewrite',
      onChunk,
    })

    expect(result).toBe('末')
    expect(onChunk).toHaveBeenCalledWith('末')
  })

  it('rewriteText 非流式模式返回完整 message 内容', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { content: '完整结果' } }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rewriteText } = await import('../../electron/main/llm-service')
    const result = await rewriteText({
      text: 'original',
      instruction: 'rewrite',
    })
    expect(result).toBe('完整结果')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')) as {
      messages?: Array<{ role: string; content: string }>
    }
    expect(body.messages?.[0]?.content).toBe('rewrite-system')
    expect(body.messages?.[1]?.content).toBe('i=rewrite;t=original')
  })
})
