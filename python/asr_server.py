#!/usr/bin/env python3
"""
ASR Sidecar 进程 — 基于 FunASR，通过 stdin/stdout JSON 协议与 Electron 主进程通信。

协议格式（每行一个 JSON）：
  → {"id":1, "cmd":"init", "modelName":"paraformer-zh", "backend":"funasr_torch", "quantize":false, "hotwords":"肉眼所见 20\n鳞状上皮 20"}
  ← {"id":1, "progress":30}          （下载进度，可多次）
  ← {"id":1, "ok":true}

  → {"id":2, "cmd":"recognize", "wavBase64":"UklGR..."}
  ← {"id":2, "ok":true, "text":"肉眼所见灰白色组织"}

  → {"id":3, "cmd":"check", "modelName":"paraformer-zh"}
  ← {"id":3, "ok":true, "downloaded":true}

  → {"id":4, "cmd":"dispose"}
  ← {"id":4, "ok":true}
"""

import sys
import json
import base64
import os
import tempfile
import traceback
import threading
import shutil

import numpy as np

# 当前模型实例
model = None
# 当前热词临时文件路径（用于清理）
_hotword_tmp = None
# 兼容目录（某些量化模型文件命名与 funasr_onnx 预期不一致时使用）
_compat_model_dirs = []
# 输出锁（多线程安全写 stdout）
_stdout_lock = threading.Lock()


def send_json(obj: dict):
    """线程安全地向 stdout 写一行 JSON"""
    line = json.dumps(obj, ensure_ascii=False)
    with _stdout_lock:
        print(line, flush=True)


def download_model_with_progress(model_name: str, msg_id: int, backend: str, quantize: bool):
    """使用 modelscope snapshot_download 预下载模型，上报进度"""
    from modelscope.hub.snapshot_download import snapshot_download

    models_to_download = [model_name]

    # torch 全量 Paraformer 还需要标点模型
    if backend == "funasr_torch" and "paraformer" in model_name.lower():
        models_to_download.append("ct-punc")

    total = len(models_to_download)
    for i, m in enumerate(models_to_download):
        base_progress = int((i / total) * 100)
        next_progress = int(((i + 1) / total) * 100)

        try:
            # 尝试用 funasr 的方式解析真实 model_id
            resolved = resolve_model_id(m)
            if is_model_cached(resolved):
                if backend.startswith("funasr_onnx"):
                    validate_onnx_files(get_model_cache_path(resolved), backend, quantize)
                send_json({"id": msg_id, "progress": next_progress})
                continue

            send_json({"id": msg_id, "progress": base_progress, "status": f"下载 {m}..."})
            model_dir = snapshot_download(resolved)
            if backend.startswith("funasr_onnx"):
                validate_onnx_files(model_dir, backend, quantize)
            send_json({"id": msg_id, "progress": next_progress})
        except Exception as e:
            # 下载失败不阻断，AutoModel 会再尝试
            sys.stderr.write(f"预下载 {m} 失败: {e}\n")
            sys.stderr.flush()
            send_json({"id": msg_id, "progress": next_progress})


def resolve_model_id(model_name: str) -> str:
    """将 FunASR 短名解析为 ModelScope model_id"""
    funasr_map = {
        "paraformer-zh": "iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "ct-punc": "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    }
    return funasr_map.get(model_name, model_name)


def get_model_cache_path(model_id: str) -> str:
    cache_root = os.path.join(
        os.path.expanduser("~"), ".cache", "modelscope", "hub", "models"
    )
    return os.path.join(cache_root, model_id.replace("/", os.sep))


def is_model_cached(model_id: str) -> bool:
    """检查模型是否已在 ModelScope 缓存中"""
    # model_id 如 "iic/SenseVoiceSmall" → 缓存路径 models/iic/SenseVoiceSmall
    model_path = get_model_cache_path(model_id)
    if os.path.isdir(model_path):
        # 检查目录非空
        for _, _, files in os.walk(model_path):
            if files:
                return True
    return False


def validate_onnx_files(model_dir: str, backend: str, quantize: bool):
    missing = []
    if quantize:
        if not os.path.exists(os.path.join(model_dir, "model_quant.onnx")):
            missing.append("model_quant.onnx")
    else:
        if not os.path.exists(os.path.join(model_dir, "model.onnx")):
            missing.append("model.onnx")

    if backend == "funasr_onnx_contextual":
        if quantize:
            has_quant_eb = os.path.exists(os.path.join(model_dir, "model_eb_quant.onnx"))
            has_plain_eb = os.path.exists(os.path.join(model_dir, "model_eb.onnx"))
            if not (has_quant_eb or has_plain_eb):
                missing.append("model_eb_quant.onnx|model_eb.onnx")
        else:
            if not os.path.exists(os.path.join(model_dir, "model_eb.onnx")):
                missing.append("model_eb.onnx")

    if missing:
        raise RuntimeError(
            f"ONNX 模型文件缺失: {', '.join(missing)}。请确认模型仓库包含完整 ONNX 文件，避免回退到 .pt 导出。"
        )


def resolve_model_dir(model_name: str) -> str:
    resolved = resolve_model_id(model_name)
    candidates = [resolved]
    if model_name != resolved:
        candidates.append(model_name)
    for candidate in candidates:
        cache_path = get_model_cache_path(candidate)
        if os.path.isdir(cache_path):
            return cache_path
    return model_name


def _copy_or_link(src: str, dst: str):
    try:
        os.symlink(src, dst)
    except Exception:
        shutil.copy2(src, dst)


def adapt_contextual_quant_model_dir(model_dir: str, quantize: bool):
    if not quantize:
        return model_dir, False

    quant_bb = os.path.join(model_dir, "model_quant.onnx")
    quant_eb = os.path.join(model_dir, "model_eb_quant.onnx")
    plain_eb = os.path.join(model_dir, "model_eb.onnx")
    if os.path.exists(quant_bb) and os.path.exists(quant_eb):
        return model_dir, True
    if not (os.path.exists(quant_bb) and os.path.exists(plain_eb)):
        return model_dir, True

    compat_dir = tempfile.mkdtemp(prefix="funasr-ctx-compat-")
    for filename in ("config.yaml", "am.mvn", "tokens.json", "configuration.json"):
        src = os.path.join(model_dir, filename)
        if os.path.exists(src):
            _copy_or_link(src, os.path.join(compat_dir, filename))
    _copy_or_link(quant_bb, os.path.join(compat_dir, "model.onnx"))
    _copy_or_link(plain_eb, os.path.join(compat_dir, "model_eb.onnx"))
    _compat_model_dirs.append(compat_dir)
    return compat_dir, False


def cleanup_tmp_files():
    global _hotword_tmp
    if _hotword_tmp and os.path.exists(_hotword_tmp):
        os.unlink(_hotword_tmp)
    _hotword_tmp = None
    while _compat_model_dirs:
        path = _compat_model_dirs.pop()
        shutil.rmtree(path, ignore_errors=True)


def normalize_hotwords_for_onnx(hotwords: str) -> str:
    words = []
    seen = set()
    for line in hotwords.splitlines():
        parts = line.strip().split()
        if not parts:
            continue
        word = parts[0]
        if word not in seen:
            seen.add(word)
            words.append(word)
    if not words:
        for word in hotwords.strip().split():
            if word and word not in seen:
                seen.add(word)
                words.append(word)
    # ContextualParaformer 空热词会异常，给一个中性占位符
    if not words:
        words.append("。")
    return " ".join(words)


def normalize_result_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, (list, tuple)):
        if (
            len(value) >= 2
            and isinstance(value[0], str)
            and any(not isinstance(item, str) for item in value[1:])
        ):
            first = value[0].strip()
            if first:
                return first
        parts = [normalize_result_text(item) for item in value]
        parts = [part for part in parts if part]
        return "".join(parts)
    if isinstance(value, dict):
        for key in ("text", "preds", "pred", "sentence", "transcript"):
            if key in value:
                normalized = normalize_result_text(value.get(key))
                if normalized:
                    return normalized
        return ""
    return str(value)


def create_model(model_name: str, hotwords: str, backend: str, quantize: bool):
    if backend == "funasr_onnx_contextual":
        try:
            from funasr_onnx import ContextualParaformer
        except ImportError as e:
            raise RuntimeError("缺少 funasr_onnx 依赖，请安装 requirements.txt 后重试") from e

        model_dir = resolve_model_dir(model_name)
        model_dir, effective_quantize = adapt_contextual_quant_model_dir(
            model_dir, bool(quantize)
        )
        model = ContextualParaformer(
            model_dir=model_dir,
            quantize=effective_quantize,
            device_id="-1",
            intra_op_num_threads=4,
        )
        # 部分 funasr_onnx 版本未初始化 language 字段，运行 __call__ 时会报错。
        if not hasattr(model, "language"):
            model.language = "zh-cn"
        return model

    if backend == "funasr_onnx_paraformer":
        try:
            from funasr_onnx import Paraformer
        except ImportError as e:
            raise RuntimeError("缺少 funasr_onnx 依赖，请安装 requirements.txt 后重试") from e

        return Paraformer(
            model_dir=resolve_model_dir(model_name),
            quantize=bool(quantize),
            device_id="-1",
            intra_op_num_threads=4,
        )

    # 默认 torch 后端
    from funasr import AutoModel

    kwargs = {
        "model": model_name,
        "device": "cpu",
    }
    if "paraformer" in model_name.lower():
        # 不加 VAD：Electron 端已做切段，保留标点
        kwargs["punc_model"] = "ct-punc"

    return AutoModel(**kwargs)


def write_hotwords_tmp(hotwords: str) -> str:
    """将热词字符串写入临时文件，返回路径"""
    global _hotword_tmp
    if _hotword_tmp and os.path.exists(_hotword_tmp):
        os.unlink(_hotword_tmp)
        _hotword_tmp = None

    if not hotwords or not hotwords.strip():
        return ""

    fd, path = tempfile.mkstemp(suffix=".txt", prefix="funasr-hotwords-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(hotwords)
    _hotword_tmp = path
    return path


def decode_wav(wav_bytes: bytes) -> np.ndarray:
    """解析 WAV 字节，返回 float32 采样数组（跳过 44 字节头）"""
    pcm = wav_bytes[44:]
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def check_model_downloaded(model_name: str, backend: str, quantize: bool) -> bool:
    """检查模型是否已在缓存中"""
    resolved = resolve_model_id(model_name)
    if is_model_cached(resolved):
        if backend.startswith("funasr_onnx"):
            try:
                validate_onnx_files(get_model_cache_path(resolved), backend, quantize)
            except Exception:
                return False
        return True
    # 对于 iic/ 开头的模型名，直接检查
    if model_name != resolved:
        if not is_model_cached(model_name):
            return False
        if backend.startswith("funasr_onnx"):
            try:
                validate_onnx_files(get_model_cache_path(model_name), backend, quantize)
            except Exception:
                return False
        return True
    return False


def handle_message(msg: dict) -> dict:
    """处理单条请求，返回响应"""
    global model
    cmd = msg.get("cmd")
    msg_id = msg.get("id", 0)

    if cmd == "init":
        # 释放旧实例
        model = None
        cleanup_tmp_files()
        model_name = msg["modelName"]
        backend = msg.get("backend", "funasr_torch")
        quantize = bool(msg.get("quantize", False))
        hotwords = msg.get("hotwords", "")

        # 先预下载模型（带进度上报）
        send_json({"id": msg_id, "progress": 0, "status": "检查模型..."})
        download_model_with_progress(model_name, msg_id, backend, quantize)

        # 写热词临时文件
        hotword_file = write_hotwords_tmp(hotwords)

        # 加载模型
        send_json({"id": msg_id, "progress": 95, "status": "加载模型..."})
        model = create_model(model_name, hotwords, backend, quantize)
        model._backend = backend
        model._quantize = quantize
        model._hotwords_str = hotwords
        model._hotword_file = hotword_file
        return {"id": msg_id, "ok": True}

    elif cmd == "recognize":
        if model is None:
            return {"id": msg_id, "ok": False, "error": "识别器未初始化"}

        wav_bytes = base64.b64decode(msg["wavBase64"])
        samples = decode_wav(wav_bytes)

        backend = getattr(model, "_backend", "funasr_torch")
        hotwords_str = getattr(model, "_hotwords_str", "")
        if backend == "funasr_onnx_contextual":
            hotwords = normalize_hotwords_for_onnx(hotwords_str)
            result = model(samples, hotwords=hotwords)
        elif backend == "funasr_onnx_paraformer":
            result = model(samples)
        else:
            gen_kwargs = dict(input=samples)
            if hotwords_str:
                gen_kwargs["hotword"] = hotwords_str
            result = model.generate(**gen_kwargs)

        text = ""
        if result and len(result) > 0:
            item = result[0]
            if hasattr(item, "text"):
                text = normalize_result_text(item.text)
            else:
                text = normalize_result_text(item)

        return {"id": msg_id, "ok": True, "text": text}

    elif cmd == "check":
        model_name = msg["modelName"]
        backend = msg.get("backend", "funasr_torch")
        quantize = bool(msg.get("quantize", False))
        downloaded = check_model_downloaded(model_name, backend, quantize)
        return {"id": msg_id, "ok": True, "downloaded": downloaded}

    elif cmd == "dispose":
        model = None
        cleanup_tmp_files()
        return {"id": msg_id, "ok": True}

    elif cmd == "ping":
        return {"id": msg_id, "ok": True}

    else:
        return {"id": msg_id, "ok": False, "error": f"未知命令: {cmd}"}


def main():
    """主循环：逐行读取 stdin JSON，处理后写入 stdout"""
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    # 启动就绪信号
    send_json({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            resp = handle_message(msg)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            resp = {"id": msg.get("id", 0) if isinstance(msg, dict) else 0,
                    "ok": False, "error": str(e)}
        send_json(resp)


if __name__ == "__main__":
    main()
