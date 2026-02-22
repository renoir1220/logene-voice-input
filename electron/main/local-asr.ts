import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { logger } from './logger'
import { MODELS, ModelInfo, isHotwordCapableModel } from './model-manager'
import { getConfig } from './config'
import { normalizeAsrText } from './asr-text'

export interface DependencyStatus {
  role: string
  modelName: string
  backend: string
  quantize: boolean
  cached: boolean
  complete: boolean
  missingFiles?: string[]
  issue?: string
}

export interface ModelCheckStatus {
  downloaded: boolean
  incomplete: boolean
  dependencies: DependencyStatus[]
}

// sidecar 子进程
let sidecar: ChildProcess | null = null
let currentModelId: string | null = null
let currentPuncEnabled: boolean | null = null
let requestId = 0
// 等待响应的回调表
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
// 行缓冲（stdout 可能分片到达）
let stdoutBuffer = ''
// init 进度回调（由 initLocalRecognizer 设置）
let onInitProgress: ((data: { progress: number; status?: string }) => void) | null = null
const SIDECAR_START_TIMEOUT_MS = 45000
const SIDECAR_STDERR_BUFFER_LIMIT = 80
const sidecarStderrLines: string[] = []

type SidecarErrorPayload = {
  code?: string
  message: string
  phase?: string
  details?: string
  data?: unknown
}

function appendSidecarStderr(raw: string): void {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    sidecarStderrLines.push(line)
    if (sidecarStderrLines.length > SIDECAR_STDERR_BUFFER_LIMIT) {
      sidecarStderrLines.shift()
    }
  }
}

function getRecentSidecarStderr(maxLines = 6): string {
  if (sidecarStderrLines.length === 0) return ''
  return sidecarStderrLines.slice(-maxLines).join(' | ')
}

function extractDetailsSummary(details: string): string {
  const lines = details
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line === 'Traceback (most recent call last):') continue
    if (line.startsWith('File "')) continue
    return line
  }
  return lines[0]
}

function normalizeSidecarError(msg: Record<string, any>): SidecarErrorPayload {
  const err = msg.error
  if (err && typeof err === 'object') {
    const payload = err as Record<string, any>
    return {
      code: typeof payload.code === 'string' ? payload.code : undefined,
      phase: typeof payload.phase === 'string' ? payload.phase : undefined,
      message: typeof payload.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : 'sidecar 返回错误',
      details: typeof payload.details === 'string' ? payload.details : undefined,
      data: payload.data,
    }
  }

  return {
    code: typeof msg.code === 'string' ? msg.code : undefined,
    phase: typeof msg.phase === 'string' ? msg.phase : undefined,
    message: typeof msg.error === 'string' && msg.error.trim() ? msg.error.trim() : 'sidecar 返回错误',
    details: typeof msg.details === 'string' ? msg.details : undefined,
  }
}

function buildSidecarErrorMessage(msg: Record<string, any>): string {
  const parsed = normalizeSidecarError(msg)
  const tags: string[] = []
  if (parsed.code) tags.push(`code=${parsed.code}`)
  if (parsed.phase) tags.push(`phase=${parsed.phase}`)
  const detailsSummary = parsed.details ? extractDetailsSummary(parsed.details) : ''
  const suffix = [tags.join(', '), detailsSummary].filter(Boolean).join(' | ')
  return suffix ? `${parsed.message} (${suffix})` : parsed.message
}

function logSidecarErrorDetail(id: number, msg: Record<string, any>): void {
  const parsed = normalizeSidecarError(msg)
  const detailPayload = {
    id,
    code: parsed.code ?? '',
    phase: parsed.phase ?? '',
    message: parsed.message,
    details: parsed.details ?? '',
    data: parsed.data,
  }
  logger.error(`sidecar error detail: ${JSON.stringify(detailPayload)}`)
}

// 启动 sidecar 进程
function spawnSidecar(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sidecar) { resolve(); return }
    sidecarStderrLines.length = 0

    const rejectEarly = (msg: string) => {
      logger.error(msg)
      reject(new Error(msg))
    }

    const isDev = !app.isPackaged
    let cmd: string
    let args: string[]

    if (isDev) {
      // 开发模式：优先使用 .venv 中的 Python，确保依赖可用
      const projectRoot = path.join(__dirname, '../..')
      const venvPython = process.platform === 'win32'
        ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(projectRoot, '.venv', 'bin', 'python3')
      cmd = fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3')
      args = [path.join(projectRoot, 'python/asr_server.py')]
    } else {
      // 生产模式：使用 PyInstaller 打包的二进制
      const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
      const ext = process.platform === 'win32' ? '.exe' : ''
      const sidecarRoot = path.join(process.resourcesPath, 'sidecar', platform, 'asr_server')
      const oneDirExec = path.join(sidecarRoot, `asr_server${ext}`)
      const oneFileExec = path.join(process.resourcesPath, 'sidecar', platform, `asr_server${ext}`)
      cmd = fs.existsSync(oneDirExec) ? oneDirExec : oneFileExec
      args = []
      if (!fs.existsSync(cmd)) {
        rejectEarly(`sidecar 可执行文件不存在: ${oneDirExec} 或 ${oneFileExec}`)
        return
      }
      try {
        fs.accessSync(cmd, fs.constants.X_OK)
      } catch (e) {
        rejectEarly(`sidecar 不可执行: ${cmd}, ${String(e)}`)
        return
      }
    }

    logger.info(`启动 ASR sidecar: ${cmd} ${args.join(' ')}`)

    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })

    let started = false
    let settled = false
    const finishResolve = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const finishReject = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }

    const startTimer = setTimeout(() => {
      if (started || settled) return
      const stderrSummary = getRecentSidecarStderr()
      logger.error(`sidecar 启动超时 (${SIDECAR_START_TIMEOUT_MS}ms)`)
      try {
        child.kill()
      } catch { /* ignore */ }
      cleanupSidecar()
      const suffix = stderrSummary ? `, stderr: ${stderrSummary}` : ''
      finishReject(new Error(`sidecar 启动超时 (${SIDECAR_START_TIMEOUT_MS}ms)${suffix}`))
    }, SIDECAR_START_TIMEOUT_MS)

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8')
      // 按行分割处理
      const lines = stdoutBuffer.split('\n')
      // 最后一段可能不完整，留在缓冲区
      stdoutBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // 第三方库偶尔会向 stdout 输出普通文本（非协议 JSON），避免误报为解析失败。
        if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
          logger.debug(`sidecar stdout: ${trimmed}`)
          continue
        }
        try {
          const msg = JSON.parse(trimmed)
          // 启动就绪信号
          if (msg.ready && !started) {
            started = true
            clearTimeout(startTimer)
            finishResolve()
            continue
          }
          // 匹配请求 ID
          const id = msg.id
          const cb = pending.get(id)
          if (cb) {
            // 进度消息（非最终响应）
            if ('progress' in msg && !('ok' in msg)) {
              if (typeof msg.progress === 'number') {
                const status = typeof msg.status === 'string' ? msg.status : ''
                logger.debug(`[ASR] init progress: ${msg.progress}%${status ? `, ${status}` : ''}`)
              }
              if (onInitProgress) {
                onInitProgress({ progress: msg.progress, status: msg.status })
              }
              continue
            }
            pending.delete(id)
            if (msg.ok) {
              cb.resolve(msg)
            } else {
              const errMsg = buildSidecarErrorMessage(msg)
              logSidecarErrorDetail(id, msg)
              logger.error(`sidecar 请求失败(id=${id}): ${errMsg}`)
              cb.reject(new Error(errMsg))
            }
          }
        } catch {
          logger.debug(`sidecar stdout 解析失败: ${trimmed}`)
        }
      }
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      const raw = chunk.toString('utf-8')
      appendSidecarStderr(raw)
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      for (const line of lines) {
        logger.debug(`sidecar stderr: ${line}`)
      }
    })

    child.on('error', (err) => {
      const stderrSummary = getRecentSidecarStderr()
      const suffix = stderrSummary ? `, stderr: ${stderrSummary}` : ''
      logger.error(`sidecar 进程错误: ${err.message}${suffix}`)
      clearTimeout(startTimer)
      if (!started) finishReject(new Error(`sidecar 进程错误: ${err.message}${suffix}`))
      cleanupSidecar()
    })

    child.on('exit', (code) => {
      const stderrSummary = getRecentSidecarStderr()
      const suffix = stderrSummary ? `, stderr: ${stderrSummary}` : ''
      logger.debug(`sidecar 进程退出，code=${code}`)
      // 拒绝所有等待中的请求
      for (const [, cb] of pending) {
        cb.reject(new Error(`sidecar 进程意外退出 (code=${code})${suffix}`))
      }
      pending.clear()
      cleanupSidecar()
      clearTimeout(startTimer)
      if (!started) finishReject(new Error(`sidecar 启动失败 (code=${code})${suffix}`))
    })

    sidecar = child
  })
}

function cleanupSidecar() {
  sidecar = null
  currentModelId = null
  currentPuncEnabled = null
  stdoutBuffer = ''
}

// 向 sidecar 发送请求并等待响应
function sendRequest(msg: Record<string, any>, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!sidecar || !sidecar.stdin?.writable) {
      reject(new Error('sidecar 未启动'))
      return
    }

    const id = ++requestId
    msg.id = id

    const timer = setTimeout(() => {
      pending.delete(id)
      const stderrSummary = getRecentSidecarStderr()
      const suffix = stderrSummary ? `, stderr: ${stderrSummary}` : ''
      reject(new Error(`sidecar 请求超时 (${timeoutMs}ms)${suffix}`))
    }, timeoutMs)

    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })

    sidecar.stdin!.write(JSON.stringify(msg) + '\n', 'utf-8')
  })
}

function collectHotwords(): string[] {
  const config = getConfig()
  const scenes = config.hotwords || []
  const allWords = new Set<string>()
  for (const scene of scenes) {
    for (const word of scene.words) {
      if (word.trim()) allWords.add(word.trim())
    }
  }
  return Array.from(allWords)
}

function isPuncEnabled(): boolean {
  const config = getConfig()
  return config.asr?.puncEnabled !== false
}

function getHotwordSupportedModelNames(): string[] {
  return MODELS.filter((m) => isHotwordCapableModel(m)).map((m) => m.name)
}

// 将配置中的热词构建为 sidecar 可识别字符串
function buildHotwordsString(modelInfo: ModelInfo): string {
  const words = collectHotwords()
  if (words.length === 0) return ''
  if (modelInfo.hotwordFormat === 'none') {
    const supportedModels = getHotwordSupportedModelNames().join(' / ')
    throw new Error(
      `当前模型「${modelInfo.name}」不支持热词注入，但你已配置 ${words.length} 个热词。` +
      `请切换到支持热词的模型（${supportedModels}）后再进行本地识别。`,
    )
  }

  // funasr_onnx ContextualParaformer 使用空格分隔热词
  const content = words.join(' ')
  logger.info(`热词已构建: ${words.length} 个词，格式=${modelInfo.hotwordFormat}`)
  return content
}

// 初始化或切换本地识别器
export async function initLocalRecognizer(
  modelId: string,
  progressCb?: (data: { progress: number; status?: string }) => void,
): Promise<void> {
  const puncEnabled = isPuncEnabled()
  // 如果已经是同一个模型，跳过
  if (currentModelId === modelId && sidecar && currentPuncEnabled === puncEnabled) return

  const modelInfo = MODELS.find(m => m.id === modelId)
  if (!modelInfo) throw new Error(`未知模型: ${modelId}`)
  if (!isHotwordCapableModel(modelInfo)) {
    throw new Error(`当前模型「${modelInfo.name}」不支持热词注入，不允许用于本地识别。`)
  }

  // 确保 sidecar 已启动
  await spawnSidecar()

  logger.info(`正在加载本地模型: ${modelInfo.name}`)

  // 按模型后端构建热词字符串
  const hotwords = buildHotwordsString(modelInfo)
  if (!puncEnabled) {
    logger.info('[ASR] 本地 PUNC 已关闭：将跳过标点恢复模型加载')
  }

  // 设置进度回调
  onInitProgress = progressCb || null

  try {
    // 发送 init 命令，sidecar 会按模型后端初始化（onnx）
    // 超时 10 分钟：首次可能需要下载并导出模型
    const initResp = await sendRequest({
      cmd: 'init',
      modelName: modelInfo.funasrModel,
      backend: modelInfo.backend,
      quantize: Boolean(modelInfo.quantized),
      vadModelName: modelInfo.vadModel,
      vadBackend: modelInfo.vadBackend,
      vadQuantize: Boolean(modelInfo.vadQuantized),
      usePunc: puncEnabled,
      puncModelName: puncEnabled ? modelInfo.puncModel : '',
      puncBackend: puncEnabled ? modelInfo.puncBackend : '',
      hotwords,
    }, 600000)

    const hs = initResp?.hotwordStats
    if (hs && typeof hs === 'object') {
      const backend = typeof hs.backend === 'string' ? hs.backend : modelInfo.backend
      const configured = Number.isFinite(Number(hs.configuredCount)) ? Number(hs.configuredCount) : 0
      const verified = Boolean(hs.verified)
      const mode = typeof hs.mode === 'string' ? hs.mode : 'unknown'
      const accepted = Number.isFinite(Number(hs.modelAcceptedCount))
        ? Number(hs.modelAcceptedCount)
        : null
      const normalized = Number.isFinite(Number(hs.normalizedCount))
        ? Number(hs.normalizedCount)
        : null
      const verifyError = typeof hs.verifyError === 'string' ? hs.verifyError : ''

      logger.debug(
        `[ASR] 热词模型状态: backend=${backend}, configured=${configured}, ` +
        `normalized=${normalized ?? 'n/a'}, accepted=${accepted ?? 'n/a'}, ` +
        `verified=${verified}, mode=${mode}`,
      )
      if (verifyError) {
        logger.warn(`[ASR] 热词模型校验异常: ${verifyError}`)
      }
    } else {
      logger.debug('[ASR] 热词模型状态: sidecar 未返回 hotwordStats')
    }
  } catch (e) {
    currentModelId = null
    currentPuncEnabled = null
    const detail = e instanceof Error ? e.message : String(e)
    logger.error(`[ASR] 本地模型初始化失败(${modelInfo.name}): ${detail}`)
    // 初始化失败后主动重置 sidecar，避免残留进程或半初始化状态影响后续识别。
    disposeLocalRecognizer()
    const firstLine = detail.split('\n').find((line) => line.trim()) || detail
    throw new Error(`本地模型初始化失败（${modelInfo.name}）: ${firstLine}`)
  } finally {
    onInitProgress = null
  }

  currentModelId = modelId
  currentPuncEnabled = puncEnabled
  logger.info(`本地模型 ${modelInfo.name} 加载完成`)
}

// 本地识别 WAV 音频
export async function recognizeLocal(wavBuffer: Buffer): Promise<string> {
  if (!sidecar || !currentModelId) {
    throw new Error('本地识别器未初始化，请先选择并下载模型')
  }

  const resp = await sendRequest({
    cmd: 'recognize',
    wavBase64: wavBuffer.toString('base64'),
  }, 120000)

  if (typeof resp?.segmentCount === 'number') {
    logger.debug(`[ASR] sidecar stats: segmentCount=${resp.segmentCount}, asrPasses=${resp?.asrPasses ?? '?'}`)
  }
  if (typeof resp?.rawText === 'string') {
    logger.debug(`[ASR] sidecar rawText: "${resp.rawText}"`)
  }
  const text = normalizeAsrText(resp?.text)
  logger.info(`本地识别结果: "${text}"`)
  return text
}

// 通过 sidecar 检查模型是否已下载
export async function checkModelDownloaded(modelId: string): Promise<boolean> {
  const status = await checkModelStatus(modelId)
  return status.downloaded
}

export async function checkModelStatus(modelId: string): Promise<ModelCheckStatus> {
  const modelInfo = MODELS.find(m => m.id === modelId)
  if (!modelInfo) {
    return { downloaded: false, incomplete: false, dependencies: [] }
  }
  if (!isHotwordCapableModel(modelInfo)) {
    logger.error(`[ASR] 模型 ${modelInfo.name} 不支持热词注入，拒绝检查状态`)
    return { downloaded: false, incomplete: false, dependencies: [] }
  }

  await spawnSidecar()
  const puncEnabled = isPuncEnabled()

  try {
    const resp = await sendRequest({
      cmd: 'check',
      modelName: modelInfo.funasrModel,
      backend: modelInfo.backend,
      quantize: Boolean(modelInfo.quantized),
      vadModelName: modelInfo.vadModel,
      vadBackend: modelInfo.vadBackend,
      vadQuantize: Boolean(modelInfo.vadQuantized),
      usePunc: puncEnabled,
      puncModelName: puncEnabled ? modelInfo.puncModel : '',
      puncBackend: puncEnabled ? modelInfo.puncBackend : '',
    }, 10000)
    return {
      downloaded: Boolean(resp.downloaded),
      incomplete: Boolean(resp.incomplete),
      dependencies: Array.isArray(resp.dependencies) ? resp.dependencies : [],
    }
  } catch {
    return { downloaded: false, incomplete: false, dependencies: [] }
  }
}

// 释放识别器资源
export function disposeLocalRecognizer(): void {
  if (sidecar) {
    // 尝试优雅关闭
    try {
      sidecar.stdin?.write(JSON.stringify({ id: ++requestId, cmd: 'dispose' }) + '\n')
    } catch { /* 忽略写入错误 */ }

    // 给 sidecar 一点时间处理 dispose，然后强制杀掉
    setTimeout(() => {
      if (sidecar) {
        sidecar.kill()
        cleanupSidecar()
      }
    }, 500)

    logger.info('本地识别器已释放')
  }
  currentModelId = null
  currentPuncEnabled = null
}
