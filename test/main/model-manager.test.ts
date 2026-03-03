import { describe, it, expect } from 'vitest'
import { MODELS, getModelInfoList } from '../../electron/main/model-manager'

describe('model-manager', () => {
  it('getModelInfoList 会过滤不支持热词注入的模型', () => {
    MODELS.push({
      id: 'unsupported-hotword-model',
      name: 'Unsupported',
      funasrModel: 'iic/unsupported',
      description: 'test',
      size: '~1 MB',
      backend: 'funasr_onnx_contextual',
      hotwordFormat: 'none',
      quantized: true,
      vadModel: 'iic/speech_fsmn_vad_zh-cn-16k-common-onnx',
      vadBackend: 'funasr_onnx_vad',
      vadQuantized: true,
      puncModel: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx',
      puncBackend: 'funasr_onnx_punc',
    })
    try {
      const ids = getModelInfoList().map((m) => m.id)
      expect(ids).not.toContain('unsupported-hotword-model')
    } finally {
      MODELS.pop()
    }
  })
})
