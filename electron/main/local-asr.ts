import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { app } from 'electron'
import { logger } from './logger'
import { MODELS, ModelInfo } from './model-manager'
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
let requestId = 0
// 等待响应的回调表
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
// 行缓冲（stdout 可能分片到达）
let stdoutBuffer = ''
// init 进度回调（由 initLocalRecognizer 设置）
let onInitProgress: ((data: { progress: number; status?: string }) => void) | null = null
const SIDECAR_START_TIMEOUT_MS = 15000

function buildSidecarErrorMessage(msg: Record<string, any>): string {
  const base = typeof msg.error === 'string' && msg.error.trim() ? msg.error.trim() : 'sidecar 返回错误'
  const details = typeof msg.details === 'string' ? msg.details.trim() : ''
  if (!details) return base
  const firstLine = details.split('\n').find((line) => line.trim()) || ''
  return firstLine ? `${base} (${firstLine})` : base
}

// 启动 sidecar 进程
function spawnSidecar(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sidecar) { resolve(); return }

    const isDev = !app.isPackaged
    let cmd: string
    let args: string[]

    if (isDev) {
      // 开发模式：直接用 python3 运行脚本
      cmd = 'python3'
      args = [path.join(__dirname, '../../python/asr_server.py')]
    } else {
      // 生产模式：使用 PyInstaller 打包的二进制
      const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
      const ext = process.platform === 'win32' ? '.exe' : ''
      cmd = path.join(process.resourcesPath, 'sidecar', platform, `asr_server${ext}`)
      args = []
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
      logger.error(`sidecar 启动超时 (${SIDECAR_START_TIMEOUT_MS}ms)`)
      try {
        child.kill()
      } catch { /* ignore */ }
      cleanupSidecar()
      finishReject(new Error(`sidecar 启动超时 (${SIDECAR_START_TIMEOUT_MS}ms)`))
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
          logger.info(`sidecar stdout: ${trimmed}`)
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
              logger.error(`sidecar 请求失败(id=${id}): ${errMsg}`)
              cb.reject(new Error(errMsg))
            }
          }
        } catch {
          logger.warn(`sidecar stdout 解析失败: ${trimmed}`)
        }
      }
    })

    child.stderr!.on('data', (chunk: Buffer) => {
      logger.warn(`sidecar stderr: ${chunk.toString('utf-8').trim()}`)
    })

    child.on('error', (err) => {
      logger.error(`sidecar 进程错误: ${err.message}`)
      clearTimeout(startTimer)
      if (!started) finishReject(err)
      cleanupSidecar()
    })

    child.on('exit', (code) => {
      logger.info(`sidecar 进程退出，code=${code}`)
      // 拒绝所有等待中的请求
      for (const [, cb] of pending) {
        cb.reject(new Error(`sidecar 进程意外退出 (code=${code})`))
      }
      pending.clear()
      cleanupSidecar()
      clearTimeout(startTimer)
      if (!started) finishReject(new Error(`sidecar 启动失败 (code=${code})`))
    })

    sidecar = child
  })
}

function cleanupSidecar() {
  sidecar = null
  currentModelId = null
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
      reject(new Error(`sidecar 请求超时 (${timeoutMs}ms)`))
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

function getHotwordSupportedModelNames(): string[] {
  return MODELS.filter((m) => m.hotwordFormat !== 'none').map((m) => m.name)
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

  let content = ''
  if (modelInfo.hotwordFormat === 'space-separated') {
    // funasr_onnx ContextualParaformer 使用空格分隔热词
    content = words.join(' ')
  } else {
    // FunASR AutoModel 热词格式：每行 "词 权重"
    content = words.map(w => `${w} 20`).join('\n')
  }
  logger.info(`热词已构建: ${words.length} 个词，格式=${modelInfo.hotwordFormat}`)
  return content
}

// 初始化或切换本地识别器
export async function initLocalRecognizer(
  modelId: string,
  progressCb?: (data: { progress: number; status?: string }) => void,
): Promise<void> {
  // 如果已经是同一个模型，跳过
  if (currentModelId === modelId && sidecar) return

  const modelInfo = MODELS.find(m => m.id === modelId)
  if (!modelInfo) throw new Error(`未知模型: ${modelId}`)

  // 确保 sidecar 已启动
  await spawnSidecar()

  logger.info(`正在加载本地模型: ${modelInfo.name}`)

  // 按模型后端构建热词字符串
  const hotwords = buildHotwordsString(modelInfo)

  // 设置进度回调
  onInitProgress = progressCb || null

  try {
    // 发送 init 命令，sidecar 会按模型后端初始化（torch / onnx）
    // 超时 10 分钟：首次可能需要下载并导出模型
    await sendRequest({
      cmd: 'init',
      modelName: modelInfo.funasrModel,
      backend: modelInfo.backend,
      quantize: Boolean(modelInfo.quantized),
      vadModelName: modelInfo.vadModel,
      vadBackend: modelInfo.vadBackend,
      vadQuantize: Boolean(modelInfo.vadQuantized),
      puncModelName: modelInfo.puncModel,
      puncBackend: modelInfo.puncBackend,
      hotwords,
    }, 600000)
  } catch (e) {
    currentModelId = null
    const detail = e instanceof Error ? e.message : String(e)
    logger.error(`[ASR] 本地模型初始化失败(${modelInfo.name}): ${detail}`)
    const firstLine = detail.split('\n').find((line) => line.trim()) || detail
    throw new Error(`本地模型初始化失败（${modelInfo.name}）: ${firstLine}`)
  } finally {
    onInitProgress = null
  }

  currentModelId = modelId
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
  })

  if (typeof resp?.segmentCount === 'number') {
    logger.info(`[ASR] sidecar stats: segmentCount=${resp.segmentCount}, asrPasses=${resp?.asrPasses ?? '?'}`)
  }
  if (typeof resp?.rawText === 'string') {
    logger.info(`[ASR] sidecar rawText: "${resp.rawText}"`)
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

  await spawnSidecar()

  try {
    const resp = await sendRequest({
      cmd: 'check',
      modelName: modelInfo.funasrModel,
      backend: modelInfo.backend,
      quantize: Boolean(modelInfo.quantized),
      vadModelName: modelInfo.vadModel,
      vadBackend: modelInfo.vadBackend,
      vadQuantize: Boolean(modelInfo.vadQuantized),
      puncModelName: modelInfo.puncModel,
      puncBackend: modelInfo.puncBackend,
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
}
