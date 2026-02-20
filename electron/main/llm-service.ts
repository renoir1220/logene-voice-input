import { getConfig } from './config'
import { logger } from './logger'

export interface RewriteOptions {
    text: string
    instruction: string
    onChunk?: (chunk: string) => void
}

export async function rewriteText(options: RewriteOptions): Promise<string> {
    const cfg = getConfig()
    if (!cfg.llm || !cfg.llm.enabled) {
        throw new Error('未启用划词重写特性，请在设置中开启并完成 LLM 配置。')
    }

    const { baseUrl, apiKey, model } = cfg.llm

    if (!baseUrl || baseUrl.trim() === '') {
        throw new Error('LLM Base URL 未配置，请前往首选项设置。决不使用隐藏的兜底地址。')
    }

    if (!apiKey || apiKey.trim() === '') {
        throw new Error('LLM API Key 未配置，请前往首选项填写凭据。')
    }

    if (!model || model.trim() === '') {
        throw new Error('未配置 LLM 模型名称 (Model Name)，请前往首选项填写。')
    }

    // 确保没有末尾斜杠
    const endpoint = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    const url = `${endpoint}/chat/completions`

    // 系统提示词：剥离寒暄，直奔主题
    const systemPrompt = `你是一个出色的桌面端文本重写助手。
必须严格遵循用户的要求，对给定的 [Selected Text] 进行修改、翻译或润色。
【严格要求】：
1. 绝对不要输出任何打招呼的话语、解释、或是“好的，以下是...”等废话。
2. 仅输出最终修改完毕的文本本身。
3. 除非用户明确要求，否则不要包裹 markdown 代码块符号（如 \`\`\`）。`

    const userPrompt = `要求 (Instruction): ${options.instruction}\n\nSelected Text:\n${options.text}`

    const requestBody = {
        model: model.trim(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        stream: !!options.onChunk,
        temperature: 0.7
    }

    logger.info(`[LLM] 发起请求: ${url} (Model: ${model.trim()})`)

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify(requestBody)
    })

    if (!response.ok) {
        let errText = ''
        try { errText = await response.text() } catch (_) { }
        logger.error(`[LLM] 请求失败: HTTP ${response.status} - ${errText}`)
        throw new Error(`API 访问失败: ${response.status} ${response.statusText}\n${errText}`)
    }

    if (options.onChunk && response.body) {
        // 采用 ReadableStream 处理 SSE流
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let fullContent = ''

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                const chunkStr = decoder.decode(value, { stream: true })
                // 一次可能接收多个以 \n 分隔的数据元
                const lines = chunkStr.split('\n')

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed || trimmed === 'data: [DONE]') continue
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(trimmed.slice(6)) as any
                            const token = data.choices?.[0]?.delta?.content || ''
                            if (token) {
                                fullContent += token
                                options.onChunk(token)
                            }
                        } catch (e) {
                            // 忽略解析错误（可能是不完整的块，实战当使用更复杂的库，此处作为简化演示）
                            logger.error(`[LLM] 流解析遇到异常区块: ${e}`)
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }
        return fullContent
    } else {
        const data = await response.json() as any
        return data.choices?.[0]?.message?.content || ''
    }
}
