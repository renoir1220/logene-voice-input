import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type RecordState = "idle" | "recording" | "recognizing";

let state: RecordState = "idle";
let recordBtn: HTMLButtonElement;
let statusText: HTMLSpanElement;
let vadIndicator: HTMLSpanElement;

// 更新 UI 状态
function setState(newState: RecordState, text?: string) {
  state = newState;
  recordBtn.classList.remove("recording", "recognizing");

  switch (newState) {
    case "idle":
      statusText.textContent = text || "就绪";
      statusText.classList.remove("result");
      break;
    case "recording":
      recordBtn.classList.add("recording");
      statusText.textContent = "录音中...";
      statusText.classList.remove("result");
      break;
    case "recognizing":
      recordBtn.classList.add("recognizing");
      statusText.textContent = "识别中...";
      statusText.classList.remove("result");
      break;
  }
}

// 显示识别结果（短暂显示后恢复）
function showResult(text: string) {
  statusText.textContent = text || "（空）";
  statusText.classList.add("result");
  setTimeout(() => {
    if (state === "idle") {
      statusText.textContent = "就绪";
      statusText.classList.remove("result");
    }
  }, 3000);
}

// 点击按钮录音
async function onRecordClick() {
  if (state === "recognizing") return;

  if (state === "idle") {
    try {
      await invoke("start_recording");
      setState("recording");
    } catch (e) {
      statusText.textContent = `错误: ${e}`;
    }
  } else if (state === "recording") {
    setState("recognizing");
    try {
      const result = await invoke<string>("stop_recording_and_recognize");
      setState("idle");
      showResult(result);
    } catch (e) {
      setState("idle", `错误: ${e}`);
    }
  }
}

// 初始化 VAD 状态
async function initVad() {
  try {
    const enabled = await invoke<boolean>("get_vad_enabled");
    vadIndicator.classList.toggle("active", enabled);
  } catch (_) {}
}

// 切换 VAD
async function toggleVad() {
  try {
    const enabled = await invoke<boolean>("toggle_vad");
    vadIndicator.classList.toggle("active", enabled);
    statusText.textContent = enabled ? "VAD 已开启" : "VAD 已关闭";
    setTimeout(() => {
      if (state === "idle") statusText.textContent = "就绪";
    }, 2000);
  } catch (e) {
    statusText.textContent = `VAD 错误: ${e}`;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
  statusText = document.getElementById("status-text") as HTMLSpanElement;
  vadIndicator = document.getElementById("vad-indicator") as HTMLSpanElement;

  recordBtn.addEventListener("click", onRecordClick);

  // 监听热键状态变化
  listen<string>("hotkey-state", (event) => {
    const s = event.payload;
    if (s === "recording") setState("recording");
    else if (s === "recognizing") setState("recognizing");
    else setState("idle");
  });

  // 监听热键识别结果
  listen<string>("hotkey-result", (event) => {
    setState("idle");
    showResult(event.payload);
  });

  // 监听托盘 VAD 切换事件
  listen("toggle-vad", toggleVad);

  initVad();
});
