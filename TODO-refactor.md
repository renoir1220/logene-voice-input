# 重构计划

## 目标

结构清晰、可持续优化、对 AI 友好。

---

## 一、src/main.ts 拆分 ✅ 已完成

1663 行 → 10 个文件：

```
src/main.ts               19 行（路由分发）
src/types.ts             114 行（类型声明）
src/audio.ts             170 行（录音 + VAD）
src/ui-state.ts          412 行（UI 状态 + 错误上报）
src/utils.ts              10 行（withTimeout）
src/dashboard-config.ts  318 行（配置表单 + 热词）
src/dashboard-models.ts  298 行（模型管理 + 日志）
src/views/float.ts       168 行（浮窗视图）
src/views/dashboard.ts   126 行（控制台视图）
src/views/rewrite.ts      88 行（重写视图）
```

## 二、electron/main/index.ts 拆分 ✅ 已完成

949 行 → 5 个文件：

```
electron/main/index.ts        196 行（生命周期编排）
electron/main/app-context.ts   87 行（共享状态 + 诊断）
electron/main/permissions.ts  163 行（权限检查引导）
electron/main/hotkeys.ts      143 行（热键注册）
electron/main/ipc.ts          310 行（IPC + ASR 运行时）
```

## 三、python/asr_server.py 拆分 ✅ 已完成

895 行 → 5 个文件：

```
python/asr_server.py     319 行（协议分发 + main）
python/protocol.py        56 行（JSON 协议工具）
python/model_cache.py    287 行（模型缓存/下载/检查）
python/model_factory.py   83 行（模型工厂）
python/inference.py      174 行（推理 + 文本归一化）
```

## 四、focus.ts + focus-controller.ts 合并 ✅ 已完成

两个文件合并为 `focus-controller.ts`，删除 `focus.ts`。

## 五、CSS 按视图拆分 ✅ 已完成

```
src/styles.css            4 行（@import 汇总）
src/styles/base.css      39 行
src/styles/float.css    274 行
src/styles/dashboard.css 838 行
src/styles/rewrite.css  177 行
```

## 六、Tauri 残留清理 ✅ 已完成

README.md、.vscode/extensions.json 中的 Tauri 引用已清除。

## 七、跨语言重复逻辑统一【P3 — 暂不处理】

TS 端和 Python 端各自保留模型 ID 映射和缓存检查实现，维护时注意同步即可。
