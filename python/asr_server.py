#!/usr/bin/env python3
"""
ASR Sidecar 进程 — 基于 FunASR，通过 stdin/stdout JSON 协议与 Electron 主进程通信。

协议格式（每行一个 JSON）：
  → {
      "id":1,
      "cmd":"init",
      "modelName":"paraformer-zh",
      "backend":"funasr_torch",
      "quantize":false,
      "vadModelName":"iic/speech_fsmn_vad_zh-cn-16k-common-onnx",
      "vadBackend":"funasr_onnx_vad",
      "vadQuantize":true,
      "puncModelName":"iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
      "puncBackend":"funasr_torch_punc",
      "hotwords":"肉眼所见 20\\n鳞状上皮 20"
    }
  ← {"id":1, "progress":30}
  ← {"id":1, "ok":true}
"""

import base64
import inspect
import json
import os
import shutil
import sys
import tempfile
import threading
import traceback

import numpy as np


_orig_getsourcelines = inspect.getsourcelines


def _safe_getsourcelines(obj):
    try:
        return _orig_getsourcelines(obj)
    except OSError:
        # PyInstaller onefile 下某些模块没有可回溯源码；返回占位行避免注册器崩溃。
        return ([""], 1)


inspect.getsourcelines = _safe_getsourcelines

# 当前运行时模型
asr_model = None
vad_model = None
punc_model = None
asr_backend = "funasr_torch"
asr_hotwords_str = ""

# 当前热词临时文件路径（用于清理）
_hotword_tmp = None
# 兼容目录（某些量化模型文件命名与 funasr_onnx 预期不一致时使用）
_compat_model_dirs = []
# 输出锁（多线程安全写 stdout）
_stdout_lock = threading.Lock()


def send_json(obj: dict):
    line = json.dumps(obj, ensure_ascii=False)
    with _stdout_lock:
        print(line, flush=True)


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
    model_path = get_model_cache_path(model_id)
    if os.path.isdir(model_path):
        for _, _, files in os.walk(model_path):
            if files:
                return True
    return False


def validate_onnx_files(model_dir: str, backend: str, quantize: bool):
    missing = get_missing_onnx_files(model_dir, backend, quantize)
    if missing:
        raise RuntimeError(
            f"ONNX 模型文件缺失: {', '.join(missing)}。请确认模型仓库包含完整 ONNX 文件。"
        )


def get_missing_onnx_files(model_dir: str, backend: str, quantize: bool):
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
    return missing


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


def reset_runtime_models():
    global asr_model, vad_model, punc_model, asr_backend, asr_hotwords_str
    asr_model = None
    vad_model = None
    punc_model = None
    asr_backend = "funasr_torch"
    asr_hotwords_str = ""


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


def write_hotwords_tmp(hotwords: str) -> str:
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
    pcm = wav_bytes[44:]
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def build_dependencies(
    model_name: str,
    backend: str,
    quantize: bool,
    vad_model_name: str,
    vad_backend: str,
    vad_quantize: bool,
    punc_model_name: str,
    punc_backend: str,
):
    deps = [
        {
            "role": "ASR",
            "modelName": model_name,
            "backend": backend,
            "quantize": bool(quantize),
        }
    ]
    if vad_model_name:
        deps.append(
            {
                "role": "VAD",
                "modelName": vad_model_name,
                "backend": vad_backend,
                "quantize": bool(vad_quantize),
            }
        )
    if punc_model_name:
        deps.append(
            {
                "role": "PUNC",
                "modelName": punc_model_name,
                "backend": punc_backend,
                "quantize": False,
            }
        )
    return deps


def download_model_with_progress(dependencies, msg_id: int):
    from modelscope.hub.snapshot_download import snapshot_download

    total = len(dependencies)
    if total == 0:
        send_json({"id": msg_id, "progress": 90})
        return

    for i, dep in enumerate(dependencies):
        model_name = dep["modelName"]
        backend = dep.get("backend", "")
        quantize = bool(dep.get("quantize", False))
        role = dep.get("role", "Model")
        base_progress = int((i / total) * 90)
        next_progress = int(((i + 1) / total) * 90)

        try:
            resolved = resolve_model_id(model_name)
            if is_model_cached(resolved):
                if backend.startswith("funasr_onnx"):
                    validate_onnx_files(get_model_cache_path(resolved), backend, quantize)
                send_json({"id": msg_id, "progress": next_progress})
                continue

            send_json(
                {
                    "id": msg_id,
                    "progress": base_progress,
                    "status": f"下载{role}模型 {model_name}...",
                }
            )
            model_dir = snapshot_download(resolved)
            if backend.startswith("funasr_onnx"):
                validate_onnx_files(model_dir, backend, quantize)
            send_json({"id": msg_id, "progress": next_progress})
        except Exception as e:
            sys.stderr.write(f"预下载 {role} 模型 {model_name} 失败: {e}\n")
            sys.stderr.flush()
            send_json({"id": msg_id, "progress": next_progress})


def is_dependency_downloaded(dep) -> bool:
    model_name = dep["modelName"]
    backend = dep.get("backend", "")
    quantize = bool(dep.get("quantize", False))

    resolved = resolve_model_id(model_name)
    if is_model_cached(resolved):
        if backend.startswith("funasr_onnx"):
            try:
                validate_onnx_files(get_model_cache_path(resolved), backend, quantize)
            except Exception:
                return False
        return True
    if model_name != resolved and is_model_cached(model_name):
        if backend.startswith("funasr_onnx"):
            try:
                validate_onnx_files(get_model_cache_path(model_name), backend, quantize)
            except Exception:
                return False
        return True
    return False


def inspect_dependency(dep):
    model_name = dep["modelName"]
    backend = dep.get("backend", "")
    quantize = bool(dep.get("quantize", False))

    resolved = resolve_model_id(model_name)
    candidates = [resolved]
    if model_name != resolved:
        candidates.append(model_name)

    existing_model_dir = ""
    for candidate in candidates:
        model_dir = get_model_cache_path(candidate)
        if os.path.isdir(model_dir):
            existing_model_dir = model_dir
            break

    cached = bool(existing_model_dir)
    missing_files = []
    complete = False
    issue = ""
    if not cached:
        issue = "模型未下载"
    else:
        if backend.startswith("funasr_onnx"):
            missing_files = get_missing_onnx_files(existing_model_dir, backend, quantize)
            if missing_files:
                issue = f"缺失文件: {', '.join(missing_files)}"
            else:
                complete = True
        else:
            complete = True

    return {
        "role": dep.get("role", "Model"),
        "modelName": model_name,
        "backend": backend,
        "quantize": quantize,
        "cached": cached,
        "complete": complete,
        "missingFiles": missing_files,
        "issue": issue,
    }


def check_dependencies_downloaded(dependencies) -> bool:
    for dep in dependencies:
        if not is_dependency_downloaded(dep):
            return False
    return True


def create_asr_model(model_name: str, backend: str, quantize: bool):
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

    from funasr import AutoModel

    model_ref = resolve_model_dir(model_name)
    return AutoModel(
        model=model_ref,
        device="cpu",
        disable_update=True,
    )


def create_vad_model(model_name: str, backend: str, quantize: bool):
    if not model_name:
        return None
    if backend == "funasr_onnx_vad":
        try:
            from funasr_onnx import Fsmn_vad
        except ImportError as e:
            raise RuntimeError("缺少 funasr_onnx 依赖，请安装 requirements.txt 后重试") from e
        return Fsmn_vad(
            model_dir=resolve_model_dir(model_name),
            quantize=bool(quantize),
            device_id="-1",
            intra_op_num_threads=2,
        )

    raise RuntimeError(f"不支持的 VAD backend: {backend}")


def create_punc_model(model_name: str, backend: str):
    if not model_name:
        return None
    if backend == "funasr_torch_punc":
        # PyInstaller 场景下，CharTokenizer 可能不会被自动收集，导致 tables.tokenizer_classes 缺项。
        # 显式导入可确保注册逻辑执行并纳入打包。
        import funasr.tokenizer.char_tokenizer  # noqa: F401
        # PUNC 使用 CTTransformer；显式导入触发 register.table 注册。
        import funasr.models.ct_transformer.model  # noqa: F401
        from funasr import AutoModel

        model_ref = resolve_model_dir(model_name)
        return AutoModel(
            model=model_ref,
            device="cpu",
            disable_update=True,
        )

    raise RuntimeError(f"不支持的 PUNC backend: {backend}")


def _extract_vad_pairs(node, pairs):
    if isinstance(node, (list, tuple)):
        if (
            len(node) == 2
            and isinstance(node[0], (int, float))
            and isinstance(node[1], (int, float))
        ):
            pairs.append((float(node[0]), float(node[1])))
            return
        for item in node:
            _extract_vad_pairs(item, pairs)


def split_segments_by_vad(samples: np.ndarray):
    if vad_model is None:
        return [samples]
    try:
        vad_output = vad_model(samples)
    except Exception as e:
        sys.stderr.write(f"VAD 推理失败，回退整段识别: {e}\n")
        sys.stderr.flush()
        return [samples]

    pairs = []
    _extract_vad_pairs(vad_output, pairs)
    if not pairs:
        return [samples]

    # 去重 + 按起点排序，避免同一段重复切分导致重复识别。
    deduped = []
    seen = set()
    for start_ms, end_ms in pairs:
        key = (int(round(float(start_ms))), int(round(float(end_ms))))
        if key in seen:
            continue
        seen.add(key)
        deduped.append((float(start_ms), float(end_ms)))
    deduped.sort(key=lambda item: (item[0], item[1]))

    segmented = []
    total = len(samples)
    for start_ms, end_ms in deduped:
        start = max(0, int(start_ms * 16))
        end = min(total, int(end_ms * 16))
        if end <= start:
            continue
        if end - start < 320:
            continue
        segmented.append(samples[start:end])

    return segmented or [samples]


def run_asr_once(samples: np.ndarray) -> str:
    if asr_model is None:
        return ""

    if asr_backend == "funasr_onnx_contextual":
        hotwords = normalize_hotwords_for_onnx(asr_hotwords_str)
        result = asr_model(samples, hotwords=hotwords)
    elif asr_backend == "funasr_onnx_paraformer":
        result = asr_model(samples)
    else:
        gen_kwargs = dict(input=samples)
        if asr_hotwords_str:
            gen_kwargs["hotword"] = asr_hotwords_str
        result = asr_model.generate(**gen_kwargs)

    text = ""
    if result and len(result) > 0:
        item = result[0]
        if hasattr(item, "text"):
            text = normalize_result_text(item.text)
        else:
            text = normalize_result_text(item)
    return text


def run_punc(text: str) -> str:
    if not text or not text.strip():
        return ""
    if punc_model is None:
        return text
    try:
        result = punc_model.generate(input=text)
        if result and len(result) > 0:
            normalized = normalize_result_text(result[0])
            if normalized:
                return normalized
    except Exception as e:
        sys.stderr.write(f"PUNC 推理失败，回退原文: {e}\n")
        sys.stderr.flush()
    return text


def handle_message(msg: dict) -> dict:
    global asr_model, vad_model, punc_model, asr_backend, asr_hotwords_str

    cmd = msg.get("cmd")
    msg_id = msg.get("id", 0)

    if cmd == "init":
        reset_runtime_models()
        cleanup_tmp_files()

        model_name = msg["modelName"]
        backend = msg.get("backend", "funasr_torch")
        quantize = bool(msg.get("quantize", False))
        hotwords = msg.get("hotwords", "")
        vad_model_name = msg.get("vadModelName", "")
        vad_backend = msg.get("vadBackend", "funasr_onnx_vad")
        vad_quantize = bool(msg.get("vadQuantize", True))
        punc_model_name = msg.get("puncModelName", "")
        punc_backend = msg.get("puncBackend", "funasr_torch_punc")

        dependencies = build_dependencies(
            model_name,
            backend,
            quantize,
            vad_model_name,
            vad_backend,
            vad_quantize,
            punc_model_name,
            punc_backend,
        )

        send_json({"id": msg_id, "progress": 0, "status": "检查模型..."})
        download_model_with_progress(dependencies, msg_id)

        hotword_file = write_hotwords_tmp(hotwords)

        send_json({"id": msg_id, "progress": 92, "status": "加载 ASR 模型..."})
        sys.stderr.write("[DEBUG] init: before create_asr_model\n")
        sys.stderr.flush()
        asr_model = create_asr_model(model_name, backend, quantize)
        sys.stderr.write("[DEBUG] init: after create_asr_model\n")
        sys.stderr.flush()
        asr_backend = backend
        asr_hotwords_str = hotwords

        send_json({"id": msg_id, "progress": 96, "status": "加载 VAD 模型..."})
        sys.stderr.write("[DEBUG] init: before create_vad_model\n")
        sys.stderr.flush()
        vad_model = create_vad_model(vad_model_name, vad_backend, vad_quantize)
        sys.stderr.write("[DEBUG] init: after create_vad_model\n")
        sys.stderr.flush()

        send_json({"id": msg_id, "progress": 98, "status": "加载 PUNC 模型..."})
        sys.stderr.write("[DEBUG] init: before create_punc_model\n")
        sys.stderr.flush()
        punc_model = create_punc_model(punc_model_name, punc_backend)
        sys.stderr.write("[DEBUG] init: after create_punc_model\n")
        sys.stderr.flush()

        _ = hotword_file
        sys.stderr.write("[DEBUG] init: return ok\n")
        sys.stderr.flush()
        return {"id": msg_id, "ok": True}

    if cmd == "recognize":
        if asr_model is None:
            return {"id": msg_id, "ok": False, "error": "识别器未初始化"}

        wav_bytes = base64.b64decode(msg["wavBase64"])
        samples = decode_wav(wav_bytes)

        segments = split_segments_by_vad(samples)
        # 避免“分段分别识别后拼接”带来的边界词重复：
        # VAD 仅用于裁剪无声片段，ASR 统一单次解码。
        merged = None
        if len(segments) <= 1:
            merged = segments[0] if segments else samples
        else:
            valid_segments = [seg for seg in segments if isinstance(seg, np.ndarray) and seg.size > 0]
            if valid_segments:
                merged = np.concatenate(valid_segments)
            else:
                merged = samples

        raw_text = run_asr_once(merged).strip()
        text = run_punc(raw_text)

        return {
            "id": msg_id,
            "ok": True,
            "text": text,
            "rawText": raw_text,
            "segmentCount": len(segments),
            "asrPasses": 1,
        }

    if cmd == "check":
        model_name = msg["modelName"]
        backend = msg.get("backend", "funasr_torch")
        quantize = bool(msg.get("quantize", False))
        vad_model_name = msg.get("vadModelName", "")
        vad_backend = msg.get("vadBackend", "funasr_onnx_vad")
        vad_quantize = bool(msg.get("vadQuantize", True))
        punc_model_name = msg.get("puncModelName", "")
        punc_backend = msg.get("puncBackend", "funasr_torch_punc")

        dependencies = build_dependencies(
            model_name,
            backend,
            quantize,
            vad_model_name,
            vad_backend,
            vad_quantize,
            punc_model_name,
            punc_backend,
        )
        dependency_status = [inspect_dependency(dep) for dep in dependencies]
        downloaded = all(item.get("complete") for item in dependency_status)
        asr_cached = any(
            item.get("role") == "ASR" and item.get("cached")
            for item in dependency_status
        )
        # 仅在“ASR 主模型已缓存但整体未就绪”时标记为不完整，
        # 避免 VAD/PUNC 共享缓存导致未下载模型被误报。
        incomplete = asr_cached and not downloaded
        return {
            "id": msg_id,
            "ok": True,
            "downloaded": downloaded,
            "incomplete": incomplete,
            "dependencies": dependency_status,
        }

    if cmd == "dispose":
        reset_runtime_models()
        cleanup_tmp_files()
        return {"id": msg_id, "ok": True}

    if cmd == "ping":
        return {"id": msg_id, "ok": True}

    return {"id": msg_id, "ok": False, "error": f"未知命令: {cmd}"}


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    send_json({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            resp = handle_message(msg)
        except Exception as e:
            tb = traceback.format_exc()
            sys.stderr.write(tb)
            sys.stderr.flush()
            resp = {
                "id": msg.get("id", 0) if isinstance(msg, dict) else 0,
                "ok": False,
                "error": f"sidecar 内部异常: {type(e).__name__}: {e}",
                "details": tb,
            }
        send_json(resp)


if __name__ == "__main__":
    main()
