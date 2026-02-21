#!/usr/bin/env python3
"""
PyInstaller 打包脚本 — 将 asr_server.py 打包为平台特定目录版(sidecar onedir)可执行文件。

用法：python3 python/build_sidecar.py
输出：dist/sidecar/{mac|win|linux}/asr_server/asr_server[.exe]
"""

import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "python" / "asr_server.py"
EXCLUDED_MODULES = [
    # Safe exclusions: these are not needed by current ONNX ASR runtime path.
    "torch",
    "torchaudio",
    "tensorflow",
    "tensorboard",
]
HIDDEN_IMPORTS = [
    "funasr_onnx.paraformer_bin",
    "funasr_onnx.vad_bin",
    "funasr_onnx.punc_bin",
]
EXCLUDED_TOP_LEVEL_DIRS = [
    "torch",
    "torchaudio",
    "tensorflow",
    "tensorboard",
]
EXCLUDED_DIST_INFO_PREFIXES = [
    "torch",
    "torchaudio",
    "tensorflow",
    "tensorboard",
]


def get_platform_name() -> str:
    s = platform.system().lower()
    if s == "darwin":
        return "mac"
    elif s == "windows":
        return "win"
    else:
        return "linux"


def cleanup_excluded_artifacts(sidecar_dir: Path) -> None:
    internal = sidecar_dir / "_internal"
    if not internal.exists():
        return

    for name in EXCLUDED_TOP_LEVEL_DIRS:
        target = internal / name
        if target.exists():
            print(f"清理排除目录: {target}")
            shutil.rmtree(target, ignore_errors=True)

    for prefix in EXCLUDED_DIST_INFO_PREFIXES:
        for target in internal.glob(f"{prefix}-*.dist-info"):
            if target.exists():
                print(f"清理排除元数据: {target}")
                shutil.rmtree(target, ignore_errors=True)


def main():
    plat = get_platform_name()
    out_dir = ROOT / "dist" / "sidecar" / plat

    print(f"打包平台: {plat}")
    print(f"输出目录: {out_dir}")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onedir",
        "--name", "asr_server",
        "--distpath", str(out_dir),
        "--workpath", str(ROOT / "build" / "sidecar_build"),
        "--specpath", str(ROOT / "build"),
        "--clean",
        "--noconfirm",
    ]
    for module in HIDDEN_IMPORTS:
        cmd.extend(["--hidden-import", module])
    for module in EXCLUDED_MODULES:
        cmd.extend(["--exclude-module", module])
    cmd.append(str(SCRIPT))

    print(f"执行: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    executable_name = "asr_server.exe" if platform.system().lower() == "windows" else "asr_server"
    cleanup_excluded_artifacts(out_dir / "asr_server")
    print(f"打包完成: {out_dir / 'asr_server' / executable_name}")


if __name__ == "__main__":
    main()
