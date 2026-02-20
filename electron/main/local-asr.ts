import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import { app } from 'electron'
import { logger } from './logger'
import { MODELS, ModelInfo } from './model-manager'
import { getConfig } from './config'
import { normalizeAsrText } from './asr-text'

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

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8')
      // 按行分割处理
      const lines = stdoutBuffer.split('\n')
      // 最后一段可能不完整，留在缓冲区
      stdoutBuffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed)
          // 启动就绪信号
          if (msg.ready && !started) {
            started = true
            resolve()
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
              cb.reject(new Error(msg.error || 'sidecar 返回错误'))
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
      if (!started) reject(err)
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
      if (!started) reject(new Error(`sidecar 启动失败 (code=${code})`))
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
      hotwords,
    }, 600000)
  } catch (e) {
    currentModelId = null
    throw new Error(`本地模型初始化失败（${modelInfo.name}）: ${String(e)}`)
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

  const text = normalizeAsrText(resp?.text)
  logger.info(`本地识别结果: "${text}"`)
  return text
}

// 通过 sidecar 检查模型是否已下载
export async function checkModelDownloaded(modelId: string): Promise<boolean> {
  const modelInfo = MODELS.find(m => m.id === modelId)
  if (!modelInfo) return false

  await spawnSidecar()

  try {
    const resp = await sendRequest({
      cmd: 'check',
      modelName: modelInfo.funasrModel,
      backend: modelInfo.backend,
      quantize: Boolean(modelInfo.quantized),
    }, 10000)
    return Boolean(resp.downloaded)
  } catch {
    return false
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
