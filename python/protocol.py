"""JSON 协议工具 — stdin/stdout 通信辅助函数。"""

import json
import sys
import threading
import traceback

_stdout_lock = threading.Lock()


def send_json(obj: dict):
    line = json.dumps(obj, ensure_ascii=False)
    with _stdout_lock:
        print(line, flush=True)


def error_response(
    msg_id: int,
    code: str,
    message: str,
    phase: str = "",
    details: str = "",
    data=None,
) -> dict:
    err = {
        "code": code,
        "message": str(message),
    }
    if phase:
        err["phase"] = phase
    if details:
        err["details"] = details
    if data is not None:
        err["data"] = data
    return {"id": msg_id, "ok": False, "error": err}


def error_from_exception(
    msg_id: int,
    code: str,
    message: str,
    phase: str,
    exc: Exception,
    data=None,
) -> dict:
    tb = traceback.format_exc()
    sys.stderr.write(tb)
    sys.stderr.flush()
    return error_response(
        msg_id=msg_id,
        code=code,
        message=f"{message}: {type(exc).__name__}: {exc}",
        phase=phase,
        details=tb,
        data=data,
    )
