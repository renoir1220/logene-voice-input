"""推理运行时 — ASR / VAD / PUNC 推理 + 文本归一化。"""

import numpy as np


# ── 运行时模型状态 ──

asr_model = None
vad_model = None
punc_model = None
asr_backend = "funasr_torch"
asr_hotwords_str = ""


def reset_runtime_models():
    global asr_model, vad_model, punc_model, asr_backend, asr_hotwords_str
    asr_model = None
    vad_model = None
    punc_model = None
    asr_backend = "funasr_torch"
    asr_hotwords_str = ""


# ── 文本归一化 ──

def normalize_hotwords_for_onnx(hotwords: str) -> str:
    words = []
    seen: set[str] = set()
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


def decode_wav(wav_bytes: bytes) -> np.ndarray:
    pcm = wav_bytes[44:]
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


# ── VAD 分段 ──

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
        raise RuntimeError("VAD 推理失败") from e

    pairs: list[tuple[float, float]] = []
    _extract_vad_pairs(vad_output, pairs)
    if not pairs:
        return [samples]

    deduped: list[tuple[float, float]] = []
    seen: set[tuple[int, int]] = set()
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


# ── ASR / PUNC 推理 ──

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
        raise RuntimeError("PUNC 推理失败") from e
    return text
