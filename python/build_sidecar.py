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
HIDDEN_IMPORTS: list[str] = [
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


def patch_funasr_onnx_numpy2() -> None:
    """修补 funasr_onnx/vad_bin.py 以兼容 numpy 2.x。
    numpy 2.x 不再允许对 1 维数组调用 int()，需要先用 .item() 转为标量。
    """
    # 直接通过 site-packages 路径定位，避免触发 funasr_onnx 的 import（会拉 torch）
    import site
    # 优先检查项目 venv
    venv_sp = ROOT / "python" / ".venv" / "Lib" / "site-packages" / "funasr_onnx" / "vad_bin.py"
    candidates_paths = [venv_sp] + [Path(sp) / "funasr_onnx" / "vad_bin.py" for sp in site.getsitepackages() + [site.getusersitepackages()]]
    vad_file = None
    for p in candidates_paths:
        if p.exists():
            vad_file = p
            break
    if vad_file is None:
        print("跳过 patch: 未找到 funasr_onnx/vad_bin.py")
        return
    src = vad_file.read_text(encoding="utf-8")

    # 已经 patch 过则跳过
    marker = "# [patched] numpy2 compat"
    if marker in src:
        print(f"vad_bin.py 已 patch，跳过: {vad_file}")
        return

    # 在 feats, feats_len = self.extract_feat(waveform) 后面插入标量转换
    old = "            feats, feats_len = self.extract_feat(waveform)"
    new = (
        "            feats, feats_len = self.extract_feat(waveform)\n"
        "            feats_len = int(feats_len.flat[0])  " + marker
    )
    if old not in src:
        print(f"警告: vad_bin.py 结构不匹配，跳过 patch: {vad_file}")
        return

    patched = src.replace(old, new, 1)
    # feats_len 已是 int，.max() 无意义，直接替换
    patched = patched.replace(
        "step = int(min(feats_len.max(), 6000))",
        "step = min(feats_len, 6000)  " + marker,
    )
    vad_file.write_text(patched, encoding="utf-8")
    print(f"已 patch vad_bin.py (numpy2 兼容): {vad_file}")


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


def ensure_venv() -> Path:
    """确保项目 venv 存在并安装好依赖，返回 venv Python 路径。"""
    is_win = platform.system().lower() == "windows"
    venv_dir = ROOT / "python" / ".venv"
    python_exe = venv_dir / ("Scripts/python.exe" if is_win else "bin/python3")
    pip_exe = venv_dir / ("Scripts/pip.exe" if is_win else "bin/pip")
    req = ROOT / "python" / "requirements.txt"

    if not python_exe.exists():
        print("创建 venv...")
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        print("安装依赖（funasr-onnx 跳过版本约束）...")
        # 先装除 funasr-onnx 以外的所有依赖
        deps = [l.strip() for l in req.read_text().splitlines() if l.strip() and not l.startswith("funasr")]
        subprocess.run([str(pip_exe), "install"] + deps + ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"], check=True)
        # funasr-onnx 单独用 --no-deps 安装，绕过 numpy 版本约束
        subprocess.run([str(pip_exe), "install", "funasr-onnx", "--no-deps", "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"], check=True)
        print("venv 初始化完成")
    return python_exe



    plat = get_platform_name()
    out_dir = ROOT / "dist" / "sidecar" / plat

    print(f"打包平台: {plat}")
    print(f"输出目录: {out_dir}")

    # 打包前修补 funasr_onnx 以兼容 numpy 2.x
    patch_funasr_onnx_numpy2()

    # 确保 venv 存在并使用它的 Python 构建
    python_exe = str(ensure_venv())
    print(f"使用 Python: {python_exe}")

    cmd = [
        python_exe, "-m", "PyInstaller",
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
