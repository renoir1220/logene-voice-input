"""模型工厂 — 创建 ASR / VAD / PUNC 模型实例。"""

from model_cache import resolve_model_dir, adapt_contextual_quant_model_dir


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
        import funasr.tokenizer.char_tokenizer  # noqa: F401
        import funasr.models.ct_transformer.model  # noqa: F401
        import funasr.models.sanm.encoder  # noqa: F401
        from funasr import AutoModel

        model_ref = resolve_model_dir(model_name)
        return AutoModel(
            model=model_ref,
            device="cpu",
            disable_update=True,
        )

    raise RuntimeError(f"不支持的 PUNC backend: {backend}")
