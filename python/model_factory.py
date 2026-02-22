"""模型工厂 — 创建 ASR / VAD / PUNC 模型实例。"""

import importlib.machinery
import importlib
import importlib.util
import sys
import types

from model_cache import resolve_model_dir, adapt_contextual_quant_model_dir


def _ensure_funasr_onnx_namespace():
    pkg_name = "funasr_onnx"
    pkg = sys.modules.get(pkg_name)
    if pkg and hasattr(pkg, "__path__"):
        return pkg

    pkg_spec = importlib.util.find_spec(pkg_name)
    if not pkg_spec or not pkg_spec.submodule_search_locations:
        raise ImportError("funasr_onnx is not installed")

    pkg_dir = str(next(iter(pkg_spec.submodule_search_locations)))
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [pkg_dir]
    pkg.__package__ = pkg_name
    pkg.__spec__ = importlib.machinery.ModuleSpec(pkg_name, loader=None, is_package=True)
    sys.modules[pkg_name] = pkg
    return pkg


def _load_funasr_onnx_submodule(module_name: str):
    _ensure_funasr_onnx_namespace()
    full_name = f"funasr_onnx.{module_name}"
    loaded = sys.modules.get(full_name)
    if loaded is not None:
        return loaded

    try:
        return importlib.import_module(full_name)
    except Exception as e:
        raise ImportError(f"unable to import {full_name}: {e}") from e


def create_asr_model(model_name: str, backend: str, quantize: bool):
    if backend == "funasr_onnx_contextual":
        try:
            paraformer_bin = _load_funasr_onnx_submodule("paraformer_bin")
            ContextualParaformer = paraformer_bin.ContextualParaformer
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
            paraformer_bin = _load_funasr_onnx_submodule("paraformer_bin")
            Paraformer = paraformer_bin.Paraformer
        except ImportError as e:
            raise RuntimeError("缺少 funasr_onnx 依赖，请安装 requirements.txt 后重试") from e
        return Paraformer(
            model_dir=resolve_model_dir(model_name),
            quantize=bool(quantize),
            device_id="-1",
            intra_op_num_threads=4,
        )

    raise RuntimeError(f"不支持的 ASR backend: {backend}")


def create_vad_model(model_name: str, backend: str, quantize: bool):
    if not model_name:
        return None
    if backend == "funasr_onnx_vad":
        try:
            vad_bin = _load_funasr_onnx_submodule("vad_bin")
            Fsmn_vad = vad_bin.Fsmn_vad
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
    if backend == "funasr_onnx_punc":
        try:
            punc_bin = _load_funasr_onnx_submodule("punc_bin")
            CT_Transformer = punc_bin.CT_Transformer
        except ImportError as e:
            raise RuntimeError("缺少 funasr_onnx 依赖，请安装 requirements.txt 后重试") from e

        return CT_Transformer(
            model_dir=resolve_model_dir(model_name),
            quantize=True,
            device_id="-1",
            intra_op_num_threads=2,
        )

    raise RuntimeError(f"不支持的 PUNC backend: {backend}")
