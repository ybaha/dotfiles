#!/usr/bin/env python3
"""Offline local MLX Whisper adapter; emits one sanitized JSON result."""
import contextlib
import json
import os
import sys

MAX_TEXT = 8000


def emit(obj: dict, code: int) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(code)


def main() -> None:
    if len(sys.argv) != 3:
        emit({"ok": False, "code": "VOICE_ARGS"}, 1)
    audio_path, model_dir = sys.argv[1:]
    if not os.path.isfile(audio_path) or not os.path.isdir(model_dir):
        emit({"ok": False, "code": "VOICE_UNAVAILABLE"}, 1)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    try:
        import mlx_whisper
    except Exception:
        emit({"ok": False, "code": "VOICE_UNAVAILABLE"}, 1)
    try:
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=model_dir,
                task="transcribe",
                language=None,
                verbose=False,
            )
        text = (result.get("text") or "").strip()
        language = result.get("language") or ""
        if not text:
            emit({"ok": False, "code": "VOICE_EMPTY"}, 2)
        if len(text) > MAX_TEXT:
            emit({"ok": False, "code": "VOICE_RESULT_TOO_LARGE"}, 3)
        emit({"ok": True, "text": text, "language": language}, 0)
    except SystemExit:
        raise
    except Exception:
        emit({"ok": False, "code": "VOICE_STT_FAILED"}, 4)


if __name__ == "__main__":
    main()
