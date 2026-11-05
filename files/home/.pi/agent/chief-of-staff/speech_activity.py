#!/usr/bin/env python3
"""Conservative PCM energy silence guard (not VAD / not a speech classifier)."""
import json
import os
import subprocess
import sys

SAMPLE_RATE = 16000
MAX_SECONDS = 120
MAX_BYTES = SAMPLE_RATE * 4 * MAX_SECONDS
FRAME_SAMPLES = 320  # 20 ms at 16 kHz
FRAME_RMS_THRESHOLD = 1e-4
GLOBAL_PEAK_THRESHOLD = 5e-4


def emit(obj: dict, code: int) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    raise SystemExit(code)


def main() -> None:
    if len(sys.argv) != 3:
        emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
    audio, ffmpeg = sys.argv[1:]
    if not os.path.isfile(audio) or not os.path.isfile(ffmpeg):
        emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
    try:
        proc = subprocess.run(
            [ffmpeg, "-nostdin", "-v", "error", "-i", audio, "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-t", str(MAX_SECONDS), "-f", "f32le", "pipe:1"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=15,
            check=False,
        )
    except Exception:
        emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
    pcm = proc.stdout
    if proc.returncode or not pcm or len(pcm) > MAX_BYTES or len(pcm) % 4:
        emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
    try:
        import numpy as np
        samples = np.frombuffer(pcm, dtype="<f4")
        if not samples.size or not np.isfinite(samples).all():
            emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
        peak = float(np.max(np.abs(samples)))
        frames = samples[: (samples.size // FRAME_SAMPLES) * FRAME_SAMPLES].reshape(-1, FRAME_SAMPLES)
        has_active_frame = bool(frames.size and np.any(np.sqrt(np.mean(frames * frames, axis=1)) > FRAME_RMS_THRESHOLD))
        speech = has_active_frame or peak > GLOBAL_PEAK_THRESHOLD
    except SystemExit:
        raise
    except Exception:
        emit({"ok": False, "code": "VOICE_ACTIVITY_FAILED"}, 1)
    emit({"ok": True, "speech": speech}, 0)


if __name__ == "__main__":
    main()
