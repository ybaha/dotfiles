#!/usr/bin/env python3
"""Local Whisper transcription; stdout is one JSON line only (no secrets)."""
import json
import os
import sys

MAX_TEXT = 8000

def emit(obj: dict, exit_code: int) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)

def main() -> None:
    if len(sys.argv) != 3:
        emit({"ok": False, "code": "VOICE_ARGS"}, 1)
    audio_path, checkpoint = sys.argv[1], sys.argv[2]
    if not os.path.isfile(audio_path) or not os.path.isfile(checkpoint):
        emit({"ok": False, "code": "VOICE_UNAVAILABLE"}, 1)
    try:
        import torch
        torch.set_num_threads(2)
        import whisper
    except Exception:
        emit({"ok": False, "code": "VOICE_UNAVAILABLE"}, 1)
    try:
        model = whisper.load_model(checkpoint, device="cpu")
        result = model.transcribe(
            audio_path,
            task="transcribe",
            fp16=False,
            verbose=False,
        )
        text = (result.get("text") or "").strip()
        lang = result.get("language") or ""
        if not text:
            emit({"ok": False, "code": "VOICE_EMPTY"}, 2)
        if len(text) > MAX_TEXT:
            emit({"ok": False, "code": "VOICE_RESULT_TOO_LARGE"}, 3)
        emit({"ok": True, "text": text, "language": lang}, 0)
    except Exception:
        emit({"ok": False, "code": "VOICE_STT_FAILED"}, 4)

if __name__ == "__main__":
    main()
