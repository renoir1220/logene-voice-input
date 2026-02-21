#!/usr/bin/env python3
"""
PyInstaller 打包脚本 — 将 asr_server.py 打包为平台特定目录版(sidecar onedir)可执行文件。

用法：python3 python/build_sidecar.py
输出：dist/sidecar/{mac|win|linux}/asr_server/asr_server[.exe]
"""

import platform
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "python" / "asr_server.py"


def get_platform_name() -> str:
    s = platform.system().lower()
    if s == "darwin":
        return "mac"
    elif s == "windows":
        return "win"
    else:
        return "linux"


def get_add_data_sep() -> str:
    return ";" if platform.system().lower() == "windows" else ":"


def try_get_funasr_version_file() -> Optional[Path]:
    spec = find_spec("funasr")
    if not spec or not spec.origin:
        return None
    pkg_dir = Path(spec.origin).resolve().parent
    version_file = pkg_dir / "version.txt"
    if version_file.exists():
        return version_file
    return None


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
        "--hidden-import", "funasr.tokenizer.char_tokenizer",
        "--hidden-import", "funasr.models.ct_transformer.model",
        "--hidden-import", "funasr.models.sanm.encoder",
        str(SCRIPT),
    ]

    funasr_version = try_get_funasr_version_file()
    if funasr_version:
        add_data = f"{funasr_version}{get_add_data_sep()}funasr"
        cmd.insert(-1, "--add-data")
        cmd.insert(-1, add_data)
        print(f"附加 funasr 数据文件: {funasr_version}")
    else:
        print("未找到 funasr/version.txt，跳过附加数据文件")

    print(f"执行: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    executable_name = "asr_server.exe" if platform.system().lower() == "windows" else "asr_server"
    print(f"打包完成: {out_dir / 'asr_server' / executable_name}")


if __name__ == "__main__":
    main()
