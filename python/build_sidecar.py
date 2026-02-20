#!/usr/bin/env python3
"""
PyInstaller 打包脚本 — 将 asr_server.py 打包为平台特定的单文件二进制。

用法：python3 python/build_sidecar.py
输出：dist/sidecar/{mac|win|linux}/asr_server[.exe]
"""

import platform
import subprocess
import sys
from pathlib import Path

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


def main():
    plat = get_platform_name()
    out_dir = ROOT / "dist" / "sidecar" / plat

    print(f"打包平台: {plat}")
    print(f"输出目录: {out_dir}")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", "asr_server",
        "--distpath", str(out_dir),
        "--workpath", str(ROOT / "build" / "sidecar_build"),
        "--specpath", str(ROOT / "build"),
        "--clean",
        "--noconfirm",
        str(SCRIPT),
    ]

    print(f"执行: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    print(f"打包完成: {out_dir / 'asr_server'}")


if __name__ == "__main__":
    main()
