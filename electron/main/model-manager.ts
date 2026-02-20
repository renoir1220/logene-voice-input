export type AsrBackend = 'funasr_torch' | 'funasr_onnx_contextual' | 'funasr_onnx_paraformer'
export type HotwordFormat = 'weighted-lines' | 'space-separated' | 'none'

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
}

// 本地模型列表
export const MODELS: ModelInfo[] = [
  {
    id: 'paraformer-zh',
    name: 'Paraformer 中文 (标准)',
    funasrModel: 'paraformer-zh',
    description: '标准中文模型，VAD+标点，支持热词',
    size: '~1 GB',
    backend: 'funasr_torch',
    hotwordFormat: 'weighted-lines',
  },
  {
    id: 'paraformer-zh-contextual-quant',
    name: 'Paraformer 中文 (量化+热词)',
    funasrModel: 'iic/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx',
    description: 'ONNX INT8 上下文版，支持热词注入（体积较大）',
    size: '~860 MB',
    backend: 'funasr_onnx_contextual',
    hotwordFormat: 'space-separated',
    quantized: true,
  },
  {
    id: 'sensevoice-small',
    name: 'SenseVoice (小)',
    funasrModel: 'iic/SenseVoiceSmall',
    description: '多语言模型，支持热词',
    size: '~450 MB',
    backend: 'funasr_torch',
    hotwordFormat: 'weighted-lines',
  },
]

// 获取所有模型基本信息（不含下载状态，下载状态由 local-asr 异步查询）
export function getModelInfoList(): ModelInfo[] {
  return MODELS
}
