// ASR API 响应格式
interface AsrResponse {
  success?: boolean
  message?: string
  data?: { text: string }
}

// 调用 Next.js ASR API 识别语音（使用 Node.js 内置 fetch）
export async function recognize(
  serverUrl: string,
  asrConfigId: string,
  wavBuffer: Buffer,
): Promise<string> {
  const url = `${serverUrl.replace(/\/$/, '')}/api/tasks/asr-recognize/sync`

  // 使用 FormData + Blob 构建 multipart 请求
  const form = new FormData()
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'recording.wav')
  if (asrConfigId) {
    form.append('asrConfigId', asrConfigId)
  }

  const resp = await fetch(url, { method: 'POST', body: form })
  if (!resp.ok) {
    throw new Error(`ASR 返回错误状态: ${resp.status}`)
  }

  const body = (await resp.json()) as AsrResponse
  if (body.success === false) {
    throw new Error(`ASR 错误: ${body.message ?? ''}`)
  }
  if (!body.data?.text) {
    throw new Error('ASR 响应中无 data 字段')
  }
  return body.data.text
}
