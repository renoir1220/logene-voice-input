"""模型缓存、下载、依赖检查。"""

import os
import shutil
import tempfile
from typing import Optional

from protocol import send_json

# 兼容目录（某些量化模型文件命名与 funasr_onnx 预期不一致时使用）
_compat_model_dirs: list[str] = []
# 当前热词临时文件路径（用于清理）
_hotword_tmp: Optional[str] = None


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


def cleanup_tmp_files():
    global _hotword_tmp
    if _hotword_tmp and os.path.exists(_hotword_tmp):
        os.unlink(_hotword_tmp)
    _hotword_tmp = None
    while _compat_model_dirs:
        path = _compat_model_dirs.pop()
        shutil.rmtree(path, ignore_errors=True)


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
            raise RuntimeError(f"预下载 {role} 模型失败: {model_name}") from e


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
