import { logger } from './logger'
import { getModelPaths, MODELS } from './model-manager'

// sherpa-onnx-node 动态导入（native addon）
let sherpa: typeof import('sherpa-onnx-node') | null = null

async function loadSherpa() {
  if (!sherpa) {
    sherpa = await import('sherpa-onnx-node')
    logger.info('sherpa-onnx-node 加载成功')
  }
  return sherpa
}

// 当前活跃的识别器实例
let currentRecognizer: any = null
let currentModelId: string | null = null

// 初始化或切换本地识别器
export async function initLocalRecognizer(modelId: string): Promise<void> {
  // 如果已经是同一个模型，跳过
  if (currentModelId === modelId && currentRecognizer) return

  const paths = getModelPaths(modelId)
  if (!paths) throw new Error(`模型 ${modelId} 未找到`)

  const modelInfo = MODELS.find(m => m.id === modelId)
  if (!modelInfo) throw new Error(`未知模型: ${modelId}`)

  const s = await loadSherpa()

  // 释放旧实例
  if (currentRecognizer) {
    currentRecognizer.free?.()
    currentRecognizer = null
    currentModelId = null
  }

  logger.info(`正在加载本地模型: ${modelInfo.name}`)

  // 根据模型类型构建不同的 config
  const config: any = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      tokens: paths.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  }

  if (modelInfo.type === 'paraformer') {
    config.modelConfig.paraformer = { model: paths.model }
  } else if (modelInfo.type === 'sensevoice') {
    config.modelConfig.senseVoice = {
      model: paths.model,
      language: 'zh',
      useInverseTextNormalization: 1,
    }
  }

  currentRecognizer = new s.OfflineRecognizer(config)
  currentModelId = modelId
  logger.info(`本地模型 ${modelInfo.name} 加载完成`)
}

// 本地识别 WAV 音频
export async function recognizeLocal(wavBuffer: Buffer): Promise<string> {
  if (!currentRecognizer) {
    throw new Error('本地识别器未初始化，请先选择并下载模型')
  }

  const s = await loadSherpa()

  // WAV 解析：跳过 44 字节头，读取 16-bit PCM 转 Float32
  const pcmData = wavBuffer.subarray(44)
  const samples = new Float32Array(pcmData.length / 2)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcmData.readInt16LE(i * 2) / 32768.0
  }

  const stream = currentRecognizer.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  currentRecognizer.decode(stream)
  const result = currentRecognizer.getResult(stream)

  logger.info(`本地识别结果: "${result.text}"`)
  return result.text || ''
}

// 释放识别器资源
export function disposeLocalRecognizer(): void {
  if (currentRecognizer) {
    currentRecognizer.free?.()
    currentRecognizer = null
    currentModelId = null
    logger.info('本地识别器已释放')
  }
}
