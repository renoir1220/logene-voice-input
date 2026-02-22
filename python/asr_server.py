#!/usr/bin/env python3
"""
ASR Sidecar 进程 — 基于 FunASR，通过 stdin/stdout JSON 协议与 Electron 主进程通信。

协议格式（每行一个 JSON）：
  → {
      "id":1,
      "cmd":"init",
      "modelName":"iic/speech_paraformer-large-contextual_asr_nat-zh-cn-16k-common-vocab8404-onnx",
      "backend":"funasr_onnx_contextual",
      "quantize":false,
      "vadModelName":"iic/speech_fsmn_vad_zh-cn-16k-common-onnx",
      "vadBackend":"funasr_onnx_vad",
      "vadQuantize":true,
      "usePunc":true,
      "puncModelName":"damo/punc_ct-transformer_cn-en-common-vocab471067-large-onnx",
      "puncBackend":"funasr_onnx_punc",
      "hotwords":"肉眼所见 鳞状上皮"
    }
  ← {"id":1, "progress":30}
  ← {"id":1, "ok":true}
"""

import base64
import inspect
import json
import sys

import numpy as np

from protocol import send_json, error_response, error_from_exception
from model_cache import (
    build_dependencies,
    download_model_with_progress,
    check_dependencies_downloaded,
    inspect_dependency,
    cleanup_tmp_files,
    write_hotwords_tmp,
)
from model_factory import create_asr_model, create_vad_model, create_punc_model
from inference import (
    asr_model, vad_model, punc_model,
    reset_runtime_models,
    decode_wav,
    split_segments_by_vad,
    run_asr_once,
    run_punc,
    inspect_hotword_state_for_model,
)
import inference


_orig_getsourcelines = inspect.getsourcelines


def _safe_getsourcelines(obj):
    try:
        return _orig_getsourcelines(obj)
    except OSError:
        return ([""], 1)


inspect.getsourcelines = _safe_getsourcelines


def handle_message(msg: dict) -> dict:
    cmd = msg.get("cmd")
    msg_id = msg.get("id", 0)

    if cmd == "init":
        reset_runtime_models()
        cleanup_tmp_files()

        model_name = msg["modelName"]
        backend = msg.get("backend", "funasr_onnx_contextual")
        quantize = bool(msg.get("quantize", False))
        hotwords = msg.get("hotwords", "")
        vad_model_name = msg.get("vadModelName", "")
        vad_backend = msg.get("vadBackend", "funasr_onnx_vad")
        vad_quantize = bool(msg.get("vadQuantize", True))
        use_punc = bool(msg.get("usePunc", True))
        punc_model_name = msg.get("puncModelName", "") if use_punc else ""
        punc_backend = msg.get("puncBackend", "funasr_onnx_punc") if use_punc else ""

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

        if not check_dependencies_downloaded(dependencies):
            send_json({"id": msg_id, "progress": 5, "status": "下载模型..."})
            try:
                download_model_with_progress(dependencies, msg_id)
            except Exception as e:
                return error_from_exception(
                    msg_id=msg_id,
                    code="MODEL_DOWNLOAD_FAILED",
                    message="模型下载失败",
                    phase="init/download",
                    exc=e,
                )

        inference.asr_backend = backend
        inference.asr_hotwords_str = hotwords

        if hotwords:
            write_hotwords_tmp(hotwords)

        send_json({"id": msg_id, "progress": 92, "status": "加载 ASR 模型..."})
        try:
            inference.asr_model = create_asr_model(model_name, backend, quantize)
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="ASR_MODEL_INIT_FAILED",
                message=f"ASR 模型初始化失败: {model_name}",
                phase="init/asr",
                exc=e,
                data={"modelName": model_name, "backend": backend, "quantize": quantize},
            )

        send_json({"id": msg_id, "progress": 96, "status": "加载 VAD 模型..."})
        try:
            inference.vad_model = create_vad_model(vad_model_name, vad_backend, vad_quantize)
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="VAD_MODEL_INIT_FAILED",
                message=f"VAD 模型初始化失败: {vad_model_name}",
                phase="init/vad",
                exc=e,
                data={
                    "modelName": vad_model_name,
                    "backend": vad_backend,
                    "quantize": vad_quantize,
                },
            )

        if use_punc:
            send_json({"id": msg_id, "progress": 98, "status": "加载 PUNC 模型..."})
            try:
                inference.punc_model = create_punc_model(punc_model_name, punc_backend)
            except Exception as e:
                return error_from_exception(
                    msg_id=msg_id,
                    code="PUNC_MODEL_INIT_FAILED",
                    message=f"PUNC 模型初始化失败: {punc_model_name}",
                    phase="init/punc",
                    exc=e,
                    data={"modelName": punc_model_name, "backend": punc_backend},
                )
        else:
            inference.punc_model = None
            send_json({"id": msg_id, "progress": 98, "status": "跳过 PUNC 模型（已关闭）"})

        hotword_stats = inspect_hotword_state_for_model(
            inference.asr_model,
            backend,
            hotwords,
        )
        return {"id": msg_id, "ok": True, "hotwordStats": hotword_stats}

    if cmd == "recognize":
        if inference.asr_model is None:
            return error_response(
                msg_id=msg_id,
                code="RECOGNIZER_NOT_INITIALIZED",
                message="识别器未初始化",
                phase="recognize/precheck",
            )

        try:
            wav_bytes = base64.b64decode(msg["wavBase64"])
            samples = decode_wav(wav_bytes)
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="AUDIO_DECODE_FAILED",
                message="音频解码失败",
                phase="recognize/decode",
                exc=e,
            )

        if not isinstance(samples, np.ndarray) or samples.size == 0:
            return {
                "id": msg_id,
                "ok": True,
                "text": "",
                "rawText": "",
                "segmentCount": 0,
                "asrPasses": 0,
            }

        try:
            segments = split_segments_by_vad(samples)
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="VAD_INFER_FAILED",
                message="VAD 推理失败",
                phase="recognize/vad",
                exc=e,
            )

        merged = None
        if len(segments) <= 1:
            merged = segments[0] if segments else samples
        else:
            valid_segments = [seg for seg in segments if isinstance(seg, np.ndarray) and seg.size > 0]
            if valid_segments:
                merged = np.concatenate(valid_segments)
            else:
                merged = samples

        try:
            raw_text = run_asr_once(merged).strip()
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="ASR_INFER_FAILED",
                message="ASR 推理失败",
                phase="recognize/asr",
                exc=e,
            )
        try:
            text = run_punc(raw_text)
        except Exception as e:
            return error_from_exception(
                msg_id=msg_id,
                code="PUNC_INFER_FAILED",
                message="标点恢复失败",
                phase="recognize/punc",
                exc=e,
            )

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
        backend = msg.get("backend", "funasr_onnx_contextual")
        quantize = bool(msg.get("quantize", False))
        vad_model_name = msg.get("vadModelName", "")
        vad_backend = msg.get("vadBackend", "funasr_onnx_vad")
        vad_quantize = bool(msg.get("vadQuantize", True))
        use_punc = bool(msg.get("usePunc", True))
        punc_model_name = msg.get("puncModelName", "") if use_punc else ""
        punc_backend = msg.get("puncBackend", "funasr_onnx_punc") if use_punc else ""

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

    return error_response(
        msg_id=msg_id,
        code="UNKNOWN_COMMAND",
        message=f"未知命令: {cmd}",
        phase="router",
    )


def main():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    send_json({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            resp = error_from_exception(
                msg_id=0,
                code="PARSE_ERROR",
                message="请求 JSON 解析失败",
                phase="parse",
                exc=e,
                data={"linePreview": line[:200]},
            )
            send_json(resp)
            continue

        try:
            resp = handle_message(msg)
        except Exception as e:
            safe_id = msg.get("id", 0) if isinstance(msg, dict) else 0
            resp = error_from_exception(
                msg_id=safe_id,
                code="INTERNAL_ERROR",
                message="sidecar 内部异常",
                phase="dispatch",
                exc=e,
            )
        send_json(resp)


if __name__ == "__main__":
    main()
