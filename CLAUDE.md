# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Logene Voice Input — 面向医疗取材软件的语音转文字 + 语音指令桌面客户端。
技术栈：Tauri v2 + Rust 后端 + Vanilla TypeScript 前端（Vite 构建）。

## 开发命令

```bash
npm install              # 安装前端依赖
npm run tauri dev        # 开发模式（前端 + Rust 热重载）
npm run tauri build      # 生产构建
```

前端开发服务器固定端口 1420，HMR 端口 1421。

## 架构

### Rust 后端 (src-tauri/src/)

- `lib.rs` — 应用入口，初始化 Tauri、注册全局热键（默认 Alt+Space）、管理 VAD 状态
- `commands.rs` — Tauri 命令：录音控制、识别、配置读写、VAD 切换
- `audio.rs` — cpal 音频采集，多声道转单声道，输出 16-bit WAV
- `asr.rs` — 调用 Next.js ASR API（`/api/tasks/asr-recognize/sync`），POST multipart WAV
- `vad.rs` — 基于 RMS 能量阈值的语音活动检测，状态机 Idle → Speaking → Processing
- `voice_commands.rs` — 识别结果精确匹配预设关键词，触发对应快捷键
- `input_sim.rs` — 两种输入方式：enigo 直接输入 / 剪贴板粘贴（Cmd/Ctrl+V）；支持组合键解析
- `tray.rs` — 系统托盘菜单（显示/隐藏、VAD 切换、退出）
- `config.rs` — TOML 配置管理，路径 `~/Library/Application Support/logene-voice-input/config.toml`

### 前端 (src/)

- `main.ts` — UI 逻辑，三种状态（idle/recording/recognizing），监听 Tauri 事件
- `styles.css` — 无边框透明浮窗样式

### 关键设计

- 录音前通过 AppleScript 记录当前活跃应用 bundle id，识别后自动还原焦点
- VAD 智能模式：持续监听麦克风，自动检测语音段落触发识别
- 语音指令匹配成功时模拟快捷键而非输入文字
- 窗口配置：无边框、透明、置顶、不显示任务栏（320×120）

## 代码规范

- 代码注释使用中文
- Rust 代码遵循标准 Cargo 格式化（`cargo fmt`）
- 前端无框架，直接操作 DOM
