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

- `index.ts` — 应用入口，窗口管理、IPC 处理、全局热键、系统托盘
- `config.ts` — electron-store 配置管理（JSON 格式）
- `asr.ts` — 远程 API 识别（POST multipart WAV）
- `local-asr.ts` — 本地 sherpa-onnx 离线识别（Paraformer/SenseVoice）
- `model-manager.ts` — 模型定义、下载（hf-mirror.com 国内镜像）、状态管理
- `logger.ts` — 结构化日志，写文件 + 推送渲染进程
- `voice-commands.ts` — 语音指令匹配，触发快捷键
- `input-sim.ts` — 文字输入 / 剪贴板粘贴 / 组合键模拟
- `focus.ts` — AppleScript 前台应用记录与还原

### 前端 (src/)

- `main.ts` — UI 逻辑，浮窗/面板双模式，配置管理，模型管理，日志查看
- `styles.css` — 样式

### 关键设计

- 录音前通过 AppleScript 记录当前活跃应用 bundle id，识别后自动还原焦点
- VAD 智能模式：持续监听麦克风，自动检测语音段落触发识别
- 语音指令匹配成功时模拟快捷键而非输入文字
- 窗口配置：无边框、透明、置顶、不显示任务栏（320×120）

## 代码规范

- 代码注释使用中文
- Rust 代码遵循标准 Cargo 格式化（`cargo fmt`）
- 前端无框架，直接操作 DOM
- 所有外部资源下载链接必须提供国内镜像（如 hf-mirror.com），不依赖 GitHub/HuggingFace 直连
