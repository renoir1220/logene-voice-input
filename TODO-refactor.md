# 重构计划

## 目标

结构清晰、可持续优化、对 AI 友好。

---

## 项目现状概览

```
文件                              行数    评价
─────────────────────────────────────────────────
src/main.ts                       1476   ❌ 严重臃肿，三个视图 + 全部业务逻辑混在一起
src/styles.css                    1328   ⚠️ 偏大，三个视图样式混合
index.html                         316   ⚠️ 三个视图 HTML 混在一个文件
electron/main/index.ts             709   ⚠️ 偏大，权限/热键/IPC/窗口管理全在一起
python/asr_server.py               725   ⚠️ 偏大，模型管理 + 推理 + 协议处理混合
electron/main/local-asr.ts         373   ✅ 合理
electron/main/model-manager.ts     218   ✅ 合理
electron/main/input-sim.ts         146   ✅ 合理
electron/main/config.ts            113   ✅ 合理
electron/main/llm-service.ts       113   ✅ 合理
electron/main/focus-controller.ts  110   ✅ 合理
electron/main/rewrite-window.ts    111   ✅ 合理
electron/main/focus.ts              94   ⚠️ 与 focus-controller.ts 职责重叠，可合并
electron/main/logger.ts             73   ✅ 合理
electron/main/asr-text.ts           32   ✅ 合理（与 python 端有重复逻辑）
electron/main/self-app.ts           34   ✅ 合理
electron/main/voice-commands.ts     17   ✅ 合理
electron/main/asr.ts                36   ✅ 合理
electron/preload/index.ts           69   ✅ 合理
src/wav.ts                          34   ✅ 合理
```

---

## 一、src/main.ts 拆分（1476 行 → 9 个模块）【优先级 P0】

### 问题

- 三个完全独立的视图（浮窗、控制台、重写窗）写在同一个文件
- 类型声明、音频采集、VAD、UI 状态、表单逻辑、模型管理全部平铺
- AI 修改任何一个功能都需要读完整个文件，上下文浪费严重

### 拆分方案

```
src/
  types.ts              ← interface + type 声明（~96 行）
  audio.ts              ← initMic / startCapture / stopCapture + VAD（~200 行）
  ui-state.ts           ← setState / showError / showResult / onRecordClick / VAD 切换 UI（~220 行）
  dashboard-config.ts   ← loadConfigToForm / saveConfig / 指令编辑器 / 热词管理（~340 行）
  dashboard-models.ts   ← renderModelList / downloadModelUI / 完整性检查 / 日志（~310 行）
  views/float.ts        ← initFloatCapsuleUI（拖动、单击双击、热键监听）（~160 行）
  views/dashboard.ts    ← initDashboardUI（事件绑定、加载数据）（~90 行）
  views/rewrite.ts      ← initRewriteUI（~90 行）
  main.ts               ← 仅 DOMContentLoaded + hash 路由分发（~15 行）
```

### 模块间依赖

```
main.ts → views/float.ts, views/dashboard.ts, views/rewrite.ts
views/float.ts → audio.ts, ui-state.ts
views/dashboard.ts → dashboard-config.ts, dashboard-models.ts, ui-state.ts
dashboard-config.ts → types.ts
dashboard-models.ts → types.ts
ui-state.ts → audio.ts, types.ts
audio.ts → types.ts (仅 wav 编码)
```

无循环依赖，每个模块单一职责。

---

## 二、electron/main/index.ts 拆分（709 行 → 5 个模块）【优先级 P1】

### 问题

- 权限检查（~160 行）、热键注册（~90 行）、IPC 注册（~120 行）、窗口管理（~80 行）、托盘（~40 行）全在一个文件
- 修改权限逻辑需要读热键代码，修改 IPC 需要读窗口代码

### 拆分方案

```
electron/main/
  permissions.ts    ← PermissionIssue 类型 + 检查/引导/打开设置（~160 行）
  hotkeys.ts        ← parseHotkey / nameToKeycode / registerHotkey（~140 行）
  ipc.ts            ← setupIpc，所有 ipcMain.handle 注册（~120 行）
  windows.ts        ← createWindow / createTray / updateTrayMenu（~120 行）
  index.ts          ← 仅 app.whenReady 生命周期编排 + 模块变量（~60 行）
```

### 注意

- `mainWindow`、`dashboardWindow`、`vadEnabled` 等共享状态需要通过一个 `AppContext` 对象或模块级 getter/setter 传递
- 避免循环依赖：`ipc.ts` 和 `windows.ts` 都需要 mainWindow 引用，统一从 `index.ts` 导出

---

## 三、python/asr_server.py 拆分（725 行 → 4 个模块）【优先级 P1】

### 问题

- 模型缓存检查、ONNX 文件校验、模型创建、VAD 切段、推理、协议处理全在一个文件
- Python 端和 TS 端（model-manager.ts）有重复的模型 ID 映射和缓存检查逻辑

### 拆分方案

```
python/
  asr_server.py       ← 仅 main() + handle_message 协议分发（~100 行）
  model_cache.py      ← resolve_model_id / is_model_cached / download / inspect（~150 行）
  model_factory.py    ← create_asr_model / create_vad_model / create_punc_model（~150 行）
  inference.py        ← split_segments_by_vad / run_asr_once / run_punc / decode_wav（~150 行）
  text_normalize.py   ← normalize_result_text / normalize_hotwords_for_onnx（~60 行）
  compat.py           ← adapt_contextual_quant_model_dir / cleanup（~60 行）
```

---

## 四、focus.ts + focus-controller.ts 合并【优先级 P2】

### 问题

- `focus.ts` 导出 `getFrontmostApp` 和 `restoreFocus`，唯一消费者是 `focus-controller.ts`
- 两个文件加起来才 204 行，拆成两个反而增加认知负担

### 方案

- 将 `focus.ts` 的内容合并到 `focus-controller.ts`，作为私有方法
- 删除 `focus.ts`

---

## 五、前端 HTML/CSS 拆分【优先级 P2】

### 问题

- `index.html`（316 行）包含三个视图的 HTML
- `styles.css`（1328 行）包含三个视图的样式
- 修改浮窗样式需要在 1328 行 CSS 中定位

### 方案

暂不拆分 HTML（electron-vite 单入口限制），但 CSS 可拆：

```
src/
  styles/
    base.css          ← 变量、reset、通用组件
    float.css         ← 浮窗样式
    dashboard.css     ← 控制台样式
    rewrite.css       ← 重写窗样式
  styles.css          ← @import 汇总
```

---

## 六、跨语言重复逻辑统一【优先级 P3】

### 问题

| 逻辑 | TS 端 | Python 端 |
|---|---|---|
| ASR 文本规范化 | `asr-text.ts` | `asr_server.py:normalize_result_text` |
| 模型 ID 映射 | `model-manager.ts:FUNASR_MODEL_ID_MAP` | `asr_server.py:resolve_model_id` |
| 模型缓存路径 | `model-manager.ts:getModelCachePath` | `asr_server.py:get_model_cache_path` |
| ONNX 文件校验 | `model-manager.ts:getMissingOnnxFiles` | `asr_server.py:get_missing_onnx_files` |

### 方案

- 模型 ID 映射和缓存检查：TS 端用于 UI 快速预检（不启动 sidecar），Python 端用于实际下载。两端保留各自实现，但通过 `MODELS` 配置统一数据源，减少手动同步
- ASR 文本规范化：TS 端保留作为兜底，Python 端是主力。可接受的重复

---

## 执行顺序建议

1. **P0** src/main.ts 拆分 — 收益最大，当前最痛
2. **P1** electron/main/index.ts 拆分 — 第二大文件
3. **P1** python/asr_server.py 拆分 — 第三大文件
4. **P2** focus 合并 + CSS 拆分 — 小改动，顺手做
5. **P3** 跨语言重复逻辑 — 低优先级，维护时注意即可
