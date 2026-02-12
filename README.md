# Logene Voice Input

语音输入法桌面客户端 — 语音转文字 + 语音指令，面向医疗取材软件场景。

## 技术栈

Rust + Tauri v2，前端 vanilla HTML/CSS/TS

## 功能

- 按住热键（Ctrl+Space）说话，松开后识别并输入文字
- 点击浮窗按钮开始/停止录音
- VAD 智能模式：持续监听麦克风，检测到语音段落后自动识别
- 语音指令：识别结果匹配预设指令时自动触发快捷键

## 开发

```bash
npm install
npm run tauri dev
```

## 构建

```bash
npm run tauri build
```

## 配置

首次运行后在 `%APPDATA%/logene-voice-input/config.toml`（Windows）或 `~/Library/Application Support/logene-voice-input/config.toml`（macOS）生成配置文件。
