import { getConfig, DEFAULT_LLM_PROMPTS, type LlmTaskPromptConfig } from './config'
import { logger } from './logger'

export interface RewriteOptions {
    text: string
    instruction: string
    onChunk?: (chunk: string) => void
}

type LlmTask = 'rewrite' | 'asrPostProcess' | 'dailySummary'

interface ChatCompletionDelta {
    content?: string
}

interface ChatCompletionChoice {
    delta?: ChatCompletionDelta
    message?: {
        content?: string
    }
}

interface ChatCompletionResponse {
    choices?: ChatCompletionChoice[]
}

function extractStreamToken(payload: unknown): string {
    const data = payload as ChatCompletionResponse
    const token = data.choices?.[0]?.delta?.content
    return typeof token === 'string' ? token : ''
}

function extractMessageText(payload: unknown): string {
    const data = payload as ChatCompletionResponse
    const content = data.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
}

function resolveLlmConfigForRequest(task: LlmTask) {
    const cfg = getConfig()
    if (!cfg.llm || !cfg.llm.enabled) {
        throw new Error('未启用 LLM 特性，请在设置中开启并完成 LLM 配置。')
    }

    const models = Array.isArray(cfg.llm.models) ? cfg.llm.models : []
    const bindingId = task === 'rewrite'
        ? cfg.llm.taskBindings?.rewrite
        : task === 'dailySummary'
          ? cfg.llm.taskBindings?.dailySummary
          : cfg.llm.taskBindings?.asrPostProcess
    const target = models.find((m) => m.id === bindingId) || models.find((m) => m.enabled) || models[0]
    if (!target) {
        throw new Error('未配置可用的 LLM 模型，请在首选项新增模型。')
    }
    if (target.enabled === false) {
        throw new Error(`任务绑定模型已禁用：${target.name}`)
    }

    const { baseUrl, apiKey, model } = target
    if (!baseUrl || baseUrl.trim() === '') {
        throw new Error(`LLM Base URL 未配置（模型：${target.name}）。`)
    }
    if (!apiKey || apiKey.trim() === '') {
        throw new Error(`LLM API Key 未配置（模型：${target.name}）。`)
    }
    if (!model || model.trim() === '') {
        throw new Error(`未配置 LLM 模型名称（模型：${target.name}）。`)
    }

    const endpoint = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
    return {
        llm: cfg.llm,
        task,
        profileName: target.name,
        profileId: target.id,
        url: `${endpoint}/chat/completions`,
        apiKey: apiKey.trim(),
        model: model.trim(),
    }
}

function getTaskPromptConfig(task: LlmTask): LlmTaskPromptConfig {
    const cfg = getConfig()
    const prompts = cfg.llm?.prompts
    const fallback = DEFAULT_LLM_PROMPTS[task]
    const resolved = prompts?.[task]
    return {
        systemPrompt: typeof resolved?.systemPrompt === 'string' ? resolved.systemPrompt : fallback.systemPrompt,
        userPromptTemplate: typeof resolved?.userPromptTemplate === 'string'
            ? resolved.userPromptTemplate
            : fallback.userPromptTemplate,
    }
}

function renderPromptTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (full, key: string) => {
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
            return vars[key]
        }
        return full
    })
}

export async function rewriteText(options: RewriteOptions): Promise<string> {
    const { url, apiKey, model, profileName, profileId } = resolveLlmConfigForRequest('rewrite')
    const prompts = getTaskPromptConfig('rewrite')
    const systemPrompt = prompts.systemPrompt
    const userPrompt = renderPromptTemplate(prompts.userPromptTemplate, {
        instruction: options.instruction,
        selectedText: options.text,
        text: options.text,
    })

    const requestBody = {
        model: model.trim(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        stream: !!options.onChunk,
        temperature: 0.7
    }

    logger.debug(`[LLM] 发起请求: ${url} (Task: rewrite, Profile: ${profileName}/${profileId}, Model: ${model.trim()})`)

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    })

    if (!response.ok) {
        let errText = ''
        try { errText = await response.text() } catch (readErr) { logger.warn(`[LLM] 读取错误响应体失败: ${String(readErr)}`) }
        logger.error(`[LLM] 请求失败: HTTP ${response.status} - ${errText}`)
        throw new Error(`API 访问失败: ${response.status} ${response.statusText}\n${errText}`)
    }

    if (options.onChunk && response.body) {
        // 使用跨 chunk 缓冲解析 SSE，避免 JSON 半包被误判并丢失。
        const onChunk = options.onChunk
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let fullContent = ''
        let sseBuffer = ''

        const consumeSseLines = (text: string) => {
            sseBuffer += text
            const lines = sseBuffer.split('\n')
            sseBuffer = lines.pop() ?? ''

            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith('data:')) continue
                const payload = trimmed.slice(5).trimStart()
                if (!payload || payload === '[DONE]') continue
                try {
                    const token = extractStreamToken(JSON.parse(payload))
                    if (!token) continue
                    fullContent += token
                    onChunk(token)
                } catch (e) {
                    logger.warn(`[LLM] 流解析失败，已跳过异常片段: ${String(e)}`)
                }
            }
        }

        try {
            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                consumeSseLines(decoder.decode(value, { stream: true }))
            }

            const tail = decoder.decode()
            if (tail) consumeSseLines(tail)
            const last = sseBuffer.trim()
            if (last.startsWith('data:')) {
                const payload = last.slice(5).trimStart()
                if (payload && payload !== '[DONE]') {
                    try {
                        const token = extractStreamToken(JSON.parse(payload))
                        if (token) {
                            fullContent += token
                            onChunk(token)
                        }
                    } catch (e) {
                        logger.warn(`[LLM] 流末尾片段解析失败: ${String(e)}`)
                    }
                }
            }
        } finally {
            reader.releaseLock()
        }
        return fullContent
    } else {
        return extractMessageText(await response.json())
    }
}

export async function optimizeAsrTextWithLlm(text: string): Promise<string> {
    const { llm, url, apiKey, model, profileName, profileId } = resolveLlmConfigForRequest('asrPostProcess')
    if (!llm.asrPostProcessEnabled) {
        throw new Error('识别后 LLM 优化已关闭')
    }

    const trimmed = text.trim()
    if (!trimmed) return ''

    const prompts = getTaskPromptConfig('asrPostProcess')
    const systemPrompt = prompts.systemPrompt
    const userPrompt = renderPromptTemplate(prompts.userPromptTemplate, {
        text: trimmed,
        asrText: trimmed,
    })

    const requestBody = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        stream: false,
        temperature: 0.2
    }

    logger.debug(`[LLM] 发起 ASR 后处理请求: ${url} (Task: asrPostProcess, Profile: ${profileName}/${profileId}, Model: ${model})`)
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    })
    if (!response.ok) {
        let errText = ''
        try { errText = await response.text() } catch (readErr) { logger.warn(`[LLM] 读取 ASR 后处理错误响应失败: ${String(readErr)}`) }
        logger.error(`[LLM] ASR 后处理失败: HTTP ${response.status} - ${errText}`)
        throw new Error(`ASR 后处理失败: ${response.status} ${response.statusText}`)
    }
    return extractMessageText(await response.json()).trim()
}

/** 根据当天识别记录生成每日总结 */
export async function generateDailySummary(records: { text: string; created_at: string }[]): Promise<string> {
    const { url, apiKey, model, profileName, profileId } = resolveLlmConfigForRequest('dailySummary')

    if (records.length === 0) return '今天暂无语音录入记录。'

    const lines = records.map(r => `[${r.created_at.slice(11, 16)}] ${r.text}`).join('\n')

    const prompts = getTaskPromptConfig('dailySummary')
    const systemPrompt = prompts.systemPrompt
    const userPrompt = renderPromptTemplate(prompts.userPromptTemplate, {
        count: String(records.length),
        records: lines,
    })

    const requestBody = {
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        stream: false,
        temperature: 0.5
    }

    logger.debug(`[LLM] 发起每日总结请求: ${url} (Task: dailySummary, Profile: ${profileName}/${profileId}, Model: ${model})`)
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    })
    if (!response.ok) {
        let errText = ''
        try { errText = await response.text() } catch (readErr) { logger.warn(`[LLM] 读取每日总结错误响应失败: ${String(readErr)}`) }
        logger.error(`[LLM] 每日总结失败: HTTP ${response.status} - ${errText}`)
        throw new Error(`每日总结生成失败: ${response.status} ${response.statusText}`)
    }
    return extractMessageText(await response.json()).trim()
}
