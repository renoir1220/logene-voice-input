import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export type AsrBackend = 'funasr_onnx_contextual' | 'funasr_onnx_paraformer'
export type HotwordFormat = 'space-separated' | 'none'
export type VadBackend = 'funasr_onnx_vad'
export type PuncBackend = 'funasr_onnx_punc'

// 模型定义
export interface ModelInfo {
  id: string
  name: string
  funasrModel: string    // FunASR 模型名（传给 AutoModel）
  description: string
  size: string           // 人类可读体积
  backend: AsrBackend
  hotwordFormat: HotwordFormat
  quantized?: boolean
  vadModel: string
  vadBackend: VadBackend
  vadQuantized?: boolean
  puncModel: string
  puncBackend: PuncBackend
}

interface ModelDependency {
  role: 'ASR' | 'VAD' | 'PUNC'
  modelName: string
  backend: string
  quantize: boolean
}

export interface ModelDependencyStatus extends ModelDependency {
  cached: boolean
  complete: boolean
  missingFiles: string[]
  issue: string
}

export interface ModelCheckStatus {
  downloaded: boolean
  incomplete: boolean
  dependencies: ModelDependencyStatus[]
}

export function isHotwordCapableModel(model: ModelInfo): boolean {
  return model.hotwordFormat !== 'none'
}

const FUNASR_MODEL_ID_MAP: Record<string, string> = {
  'ct-punc': 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
}

function resolveModelId(modelName: string): string {
  return FUNASR_MODEL_ID_MAP[modelName] || modelName
}

function getModelCachePath(modelId: string): string {
  return path.join(os.homedir(), '.cache', 'modelscope', 'hub', 'models', ...modelId.split('/'))
}

function findExistingModelDir(modelName: string): string | null {
  const resolved = resolveModelId(modelName)
  const candidates = [resolved]
  if (modelName !== resolved) candidates.push(modelName)
  for (const candidate of candidates) {
    const modelDir = getModelCachePath(candidate)
    if (fs.existsSync(modelDir) && fs.statSync(modelDir).isDirectory()) {
      return modelDir
    }
  }
  return null
}

function getMissingOnnxFiles(modelDir: string, backend: string, quantize: boolean): string[] {
  const missing: string[] = []
  if (quantize) {
    if (!fs.existsSync(path.join(modelDir, 'model_quant.onnx'))) {
      missing.push('model_quant.onnx')
    }
  } else if (!fs.existsSync(path.join(modelDir, 'model.onnx'))) {
    missing.push('model.onnx')
  }

  if (backend === 'funasr_onnx_contextual') {
    if (quantize) {
      const hasQuantEb = fs.existsSync(path.join(modelDir, 'model_eb_quant.onnx'))
      const hasPlainEb = fs.existsSync(path.join(modelDir, 'model_eb.onnx'))
      if (!hasQuantEb && !hasPlainEb) {
        missing.push('model_eb_quant.onnx|model_eb.onnx')
      }
    } else if (!fs.existsSync(path.join(modelDir, 'model_eb.onnx'))) {
      missing.push('model_eb.onnx')
    }
  }
  return missing
}

function inspectDependency(dep: ModelDependency): ModelDependencyStatus {
  const modelDir = findExistingModelDir(dep.modelName)
  const cached = Boolean(modelDir)
  if (!cached || !modelDir) {
    return {
      ...dep,
      cached: false,
      complete: false,
      missingFiles: [],
      issue: '模型未下载',
    }
  }

  if (dep.backend.startsWith('funasr_onnx')) {
    const missingFiles = getMissingOnnxFiles(modelDir, dep.backend, dep.quantize)
    if (missingFiles.length > 0) {
      return {
        ...dep,
        cached: true,
        complete: false,
        missingFiles,
        issue: `缺失文件: ${missingFiles.join(', ')}`,
      }
    }
  }

  return {
    ...dep,
    cached: true,
    complete: true,
    missingFiles: [],
    issue: '',
  }
}

function buildDependencies(model: ModelInfo): ModelDependency[] {
  const deps: ModelDependency[] = [
    {
      role: 'ASR',
      modelName: model.funasrModel,
      backend: model.backend,
      quantize: Boolean(model.quantized),
    },
  ]
  if (model.vadModel) {
    deps.push({
      role: 'VAD',
      modelName: model.vadModel,
      backend: model.vadBackend,
      quantize: Boolean(model.vadQuantized),
    })
  }
  if (model.puncModel) {
    deps.push({
      role: 'PUNC',
      modelName: model.puncModel,
      backend: model.puncBackend,
      quantize: false,
    })
  }
  return deps
}

export function inspectLocalModelStatus(model: ModelInfo): ModelCheckStatus {
  const dependencies = buildDependencies(model).map(inspectDependency)
  const downloaded = dependencies.every((dep) => dep.complete)
  const asrCached = dependencies.some((dep) => dep.role === 'ASR' && dep.cached)
  const incomplete = asrCached && !downloaded
  return { downloaded, incomplete, dependencies }
}

// 本地模型列表
export const MODELS: ModelInfo[] = [
  {
    id: 'paraformer-zh-contextual-quant',
    name: 'Paraformer 中文 (量化+热词)',
    funasrModel: 'iic/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx',
    description: 'ONNX INT8 上下文版，支持热词注入（体积较大）',
    size: '~860 MB',
    backend: 'funasr_onnx_contextual',
    hotwordFormat: 'space-separated',
    quantized: true,
    vadModel: 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
    vadBackend: 'funasr_onnx_vad',
    vadQuantized: true,
    puncModel: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
    puncBackend: 'funasr_onnx_punc',
  },
]

// 获取所有模型基本信息（不含下载状态，下载状态由 local-asr 异步查询）
export function getModelInfoList(): ModelInfo[] {
  return MODELS.filter(isHotwordCapableModel)
}
