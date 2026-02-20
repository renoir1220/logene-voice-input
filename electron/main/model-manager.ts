import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { logger } from './logger'

// 模型定义
export interface ModelInfo {
  id: string
  name: string
  type: 'paraformer' | 'sensevoice'
  description: string
  size: string           // 人类可读体积
  downloadUrl: string    // tar.bz2 下载地址
  dirName: string        // 解压后的目录名
  modelFile: string      // 模型文件名（相对于 dirName）
  tokensFile: string     // tokens 文件名
}

// 三个可选模型
export const MODELS: ModelInfo[] = [
  {
    id: 'paraformer-zh-small',
    name: 'Paraformer 中文 (小)',
    type: 'paraformer',
    description: '最小模型，速度快，适合日常使用',
    size: '~79 MB',
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2',
    dirName: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    modelFile: 'model.int8.onnx',
    tokensFile: 'tokens.txt',
  },
  {
    id: 'paraformer-zh',
    name: 'Paraformer 中文 (标准)',
    type: 'paraformer',
    description: '标准模型，识别效果更好',
    size: '~217 MB',
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2024-03-09.tar.bz2',
    dirName: 'sherpa-onnx-paraformer-zh-2024-03-09',
    modelFile: 'model.int8.onnx',
    tokensFile: 'tokens.txt',
  },
  {
    id: 'sensevoice-small',
    name: 'SenseVoice (小)',
    type: 'sensevoice',
    description: '多语言模型，支持 50+ 语言和情感识别',
    size: '~229 MB',
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2',
    dirName: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    modelFile: 'model.int8.onnx',
    tokensFile: 'tokens.txt',
  },
]

// 模型存储根目录
export function getModelsDir(): string {
  return path.join(app.getPath('userData'), 'models')
}

// 检查模型是否已下载
export function isModelDownloaded(modelId: string): boolean {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return false
  const modelPath = path.join(getModelsDir(), model.dirName, model.modelFile)
  const tokensPath = path.join(getModelsDir(), model.dirName, model.tokensFile)
  return fs.existsSync(modelPath) && fs.existsSync(tokensPath)
}

// 获取模型文件路径
export function getModelPaths(modelId: string): { model: string; tokens: string } | null {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return null
  const dir = path.join(getModelsDir(), model.dirName)
  return {
    model: path.join(dir, model.modelFile),
    tokens: path.join(dir, model.tokensFile),
  }
}

// 获取所有模型的状态
export function getModelStatuses(): Array<ModelInfo & { downloaded: boolean }> {
  return MODELS.map(m => ({ ...m, downloaded: isModelDownloaded(m.id) }))
}

// 下载并解压模型（tar.bz2）
export async function downloadModel(
  modelId: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) throw new Error(`未知模型: ${modelId}`)

  const modelsDir = getModelsDir()
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true })

  const tarPath = path.join(modelsDir, `${model.id}.tar.bz2`)

  logger.info(`开始下载模型 ${model.name} → ${tarPath}`)

  // 下载文件（支持 GitHub 重定向）
  await downloadFile(model.downloadUrl, tarPath, onProgress)

  logger.info(`下载完成，开始解压...`)

  // 使用系统 tar 解压（macOS/Linux 自带，Windows 10+ 也有）
  const { execFile } = await import('child_process')
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['xjf', tarPath, '-C', modelsDir], (err) => {
      if (err) reject(new Error(`解压失败: ${err.message}`))
      else resolve()
    })
  })

  // 清理压缩包
  fs.unlinkSync(tarPath)
  logger.info(`模型 ${model.name} 安装完成`)
}

// HTTP(S) 下载，支持重定向
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    proto.get(url, { headers: { 'User-Agent': 'LogeneVoiceInput' } }, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
      let downloadedBytes = 0
      const file = createWriteStream(dest)

      res.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length
        if (totalBytes > 0 && onProgress) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100))
        }
      })

      pipeline(res, file).then(resolve).catch(reject)
    }).on('error', reject)
  })
}

// 删除已下载的模型
export function deleteModel(modelId: string): void {
  const model = MODELS.find(m => m.id === modelId)
  if (!model) return
  const dir = path.join(getModelsDir(), model.dirName)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    logger.info(`已删除模型 ${model.name}`)
  }
}
