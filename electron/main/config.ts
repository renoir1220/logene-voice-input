import Store from 'electron-store'
import path from 'path'
import os from 'os'

// 热词场景
export interface HotwordScene {
  name: string      // "全局"、"胃镜" 等
  words: string[]
}

// 应用配置类型
export interface AppConfig {
  server: {
    url: string
    asrConfigId: string
  }
  hotkey: {
    record: string
  }
  input: {
    useClipboard: boolean
  }
  vad: {
    enabled: boolean
    speechThreshold: number
    silenceTimeoutMs: number
    minSpeechDurationMs: number
  }
  voiceCommands: Record<string, string>
  hotwords: HotwordScene[]
  asr: {
    mode: 'api' | 'local'    // 识别模式：远程 API 或本地模型
    localModel: string        // 本地模型标识，如 'paraformer-zh-small'
  }
}

// 默认配置
const defaultConfig: AppConfig = {
  server: { url: 'http://localhost:3000', asrConfigId: '' },
  hotkey: { record: 'Alt+Space' },
  input: { useClipboard: false },
  vad: {
    enabled: false,
    speechThreshold: 0.03,
    silenceTimeoutMs: 800,
    minSpeechDurationMs: 300,
  },
  voiceCommands: {
    肉眼所见: 'ALT+R',
    查询病人: 'ALT+Q',
    材块数: 'ALT+C',
    序列号: 'ALT+D',
    取材医生: 'ALT+E',
    上机状态: 'ALT+G',
    上一个: 'ALT+A',
    下一个: 'ALT+B',
    附言: 'ALT+F',
    保存报告: 'F2',
    保存下例: 'F4',
    病理号: 'F9',
    组织名称: 'F7',
    增加切片: 'F6',
  },
  hotwords: [{ name: '全局', words: [] }],
  asr: { mode: 'api', localModel: 'paraformer-zh-small' },
}

// electron-store 实例
const store = new Store<AppConfig>({
  name: 'config',
  defaults: defaultConfig,
})

export function getConfig(): AppConfig {
  return store.store as AppConfig
}

export function saveConfig(config: AppConfig): void {
  store.store = config
}
