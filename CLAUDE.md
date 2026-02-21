# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Logene Voice Input — 面向医疗取材软件的语音转文字 + 语音指令桌面客户端。
技术栈：Electron + Vanilla TypeScript 前端（electron-vite 构建）+ sherpa-onnx-node 本地 ASR。

## 开发命令

```bash
npm install              # 安装依赖
npm run dev              # 开发模式（electron-vite dev）
npm run build            # 生产构建
npm test                 # 运行测试（vitest run）
```

## 架构

### 主进程 (electron/main/)

- `index.ts` — 应用入口，生命周期编排（窗口创建、托盘、启动流程）
- `app-context.ts` — 共享状态（mainWindow/dashboardWindow/vadEnabled 等）+ 诊断工具
- `ipc.ts` — 所有 IPC handler 注册 + ASR 运行时状态管理
- `hotkeys.ts` — 全局热键解析与注册（uiohook + globalShortcut）
- `permissions.ts` — macOS/Windows 权限检查、引导弹窗、打开系统设置
- `config.ts` — electron-store 配置管理（JSON 格式）
- `asr.ts` — 远程 API 识别（POST multipart WAV）
- `local-asr.ts` — 本地 sherpa-onnx 离线识别（Paraformer/SenseVoice）
- `model-manager.ts` — 模型定义、下载（hf-mirror.com 国内镜像）、状态管理
- `logger.ts` — 结构化日志，写文件 + 推送渲染进程
- `voice-commands.ts` — 语音指令匹配，触发快捷键
- `input-sim.ts` — 文字输入 / 剪贴板粘贴 / 组合键模拟
- `focus-controller.ts` — 前台应用检测（lsappinfo/AppleScript）+ 焦点还原 + 定时追踪
- `rewrite-window.ts` — 划词重写窗口管理
- `llm-service.ts` — LLM 调用（重写功能）

### 前端 (src/)

- `main.ts` — 入口，hash 路由分发到三个视图
- `types.ts` — 所有 interface/type 声明（含 Window.electronAPI）
- `audio.ts` — 麦克风采集、PCM 录音、VAD 检测
- `ui-state.ts` — UI 状态机、错误展示、ASR 运行时状态、VAD 切换、错误上报
- `utils.ts` — 通用工具函数
- `dashboard-config.ts` — 控制台配置表单、语音指令编辑、热词管理
- `dashboard-models.ts` — 模型列表渲染、下载 UI、日志展示
- `views/float.ts` — 浮窗视图（拖动、单击录音、双击呼出面板、热键监听）
- `views/dashboard.ts` — 控制台视图（事件绑定、数据加载）
- `views/rewrite.ts` — 重写视图
- `styles/` — CSS 按视图拆分（base / float / dashboard / rewrite）

### Python sidecar (python/)

- `asr_server.py` — 入口，stdin/stdout JSON 协议分发
- `protocol.py` — JSON 通信工具函数
- `model_cache.py` — 模型缓存检查、下载、依赖管理
- `model_factory.py` — ASR/VAD/PUNC 模型创建
- `inference.py` — 推理运行时（VAD 分段、ASR、标点恢复、文本归一化）

### 关键设计

- 录音前通过 AppleScript 记录当前活跃应用 bundle id，识别后自动还原焦点
- VAD 智能模式：持续监听麦克风，自动检测语音段落触发识别
- 语音指令匹配成功时模拟快捷键而非输入文字
- 窗口配置：无边框、透明、置顶、不显示任务栏（320×120）

## 代码规范

- 代码注释使用中文
- 前端无框架，直接操作 DOM
- 所有外部资源下载链接必须提供国内镜像（如 hf-mirror.com），不依赖 GitHub/HuggingFace 直连
