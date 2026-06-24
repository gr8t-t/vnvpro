"""
VNV Pro — RVC Voice Conversion Server
─────────────────────────────────────
Two capabilities:
  1. /ws/{voice_folder}  — real-time streaming voice conversion (WebSocket)
  2. /convert            — file-based conversion for the Record→MP3 feature (HTTP POST)

The RVC model is loaded ONCE per voice folder and kept warm in GPU memory.
Warm inference on this project's test machine runs ~14x faster than realtime,
which makes chunked real-time streaming viable.

Run:
    venv\\Scripts\\python.exe server.py
Requires the venv created during setup (torch cu118 + rvc-python).
"""

import sys
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import os
import io
import time
import json
import wave
import tempfile
import threading
import numpy as np

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

from rvc_python.infer import RVCInference

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR  = os.path.join(BASE_DIR, "models")
DEVICE      = "cuda:0"          # set to "cpu" if no NVIDIA GPU
OUTPUT_SR   = 48000             # rvc-python outputs 48 kHz mono
INPUT_SR    = 16000             # what the browser sends us

# Real-time tuning (seconds)
BLOCK_SEC      = 1.30           # audio gathered before each conversion (bigger = clearer words)
CONTEXT_SEC    = 0.35           # past audio prepended for pitch context
CROSSFADE_SEC  = 0.08           # overlap blended between consecutive outputs
SILENCE_RMS    = 0.012          # blocks quieter than this are treated as silence (skip noise)

app = FastAPI(title="VNV Pro RVC Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Model cache ───────────────────────────────────────────────────────────────
# One RVCInference instance per voice folder, loaded lazily and kept warm.
_models = {}
_models_lock = threading.Lock()


def _find_files(folder):
    folder_path = os.path.join(MODELS_DIR, folder)
    if not os.path.isdir(folder_path):
        raise FileNotFoundError(f"Model folder not found: {folder}")
    pth = next((os.path.join(folder_path, f) for f in os.listdir(folder_path) if f.endswith(".pth")), None)
    idx = next((os.path.join(folder_path, f) for f in os.listdir(folder_path) if f.endswith(".index")), None)
    if not pth:
        raise FileNotFoundError(f"No .pth file in models/{folder}")
    return pth, idx or ""


def get_model(folder):
    """Load (once) and return a warm RVCInference for the given voice folder."""
    with _models_lock:
        if folder in _models:
            return _models[folder]
        pth, idx = _find_files(folder)
        print(f"[RVC] Loading model '{folder}' ...")
        t0 = time.time()
        rvc = RVCInference(device=DEVICE)
        rvc.load_model(pth, index_path=idx)
        # index_rate kept moderate: too high adds warble/artifacts on short blocks
        rvc.set_params(f0method="rmvpe", f0up_key=0, index_rate=0.5, protect=0.40)
        # Warm up so the first real request is fast
        try:
            warm = np.zeros(INPUT_SR, dtype=np.float32)  # 1s of silence
            _infer_array(rvc, warm, INPUT_SR)
        except Exception as e:
            print(f"[RVC] warmup note: {e}")
        print(f"[RVC] Model '{folder}' ready in {time.time()-t0:.1f}s")
        _models[folder] = rvc
        return rvc


# ── Inference helpers ─────────────────────────────────────────────────────────
def _write_wav(path, audio_f32, sr):
    pcm = np.clip(audio_f32 * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def _read_wav_f32(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32767.0
    return pcm, sr


def _infer_array(rvc, audio_f32, in_sr):
    """Convert a float32 mono array. Returns (out_f32, out_sr) via temp files."""
    in_path = tempfile.mktemp(suffix=".wav")
    out_path = tempfile.mktemp(suffix=".wav")
    try:
        _write_wav(in_path, audio_f32, in_sr)
        rvc.infer_file(in_path, out_path)
        return _read_wav_f32(out_path)
    finally:
        for p in (in_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass


# ── HTTP endpoints ──────────────────────────────────────────────────────────--
@app.get("/health")
async def health():
    return {"status": "ok", "loaded": list(_models.keys())}


@app.get("/models")
async def list_models():
    models = []
    if os.path.isdir(MODELS_DIR):
        for d in os.listdir(MODELS_DIR):
            if os.path.isdir(os.path.join(MODELS_DIR, d)):
                try:
                    _find_files(d)
                    models.append(d)
                except FileNotFoundError:
                    pass
    return {"models": models}


@app.post("/convert")
async def convert(voice: str = Form(...), pitch: int = Form(0), file: UploadFile = File(...)):
    """Record→MP3 feature: take an uploaded clip, convert, return a WAV."""
    try:
        rvc = get_model(voice)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    data = await file.read()
    in_path = tempfile.mktemp(suffix=os.path.splitext(file.filename or ".wav")[1] or ".wav")
    out_path = tempfile.mktemp(suffix=".wav")
    try:
        with open(in_path, "wb") as f:
            f.write(data)
        rvc.set_params(f0method="rmvpe", f0up_key=int(pitch), index_rate=0.75, protect=0.33)
        rvc.infer_file(in_path, out_path)
        with open(out_path, "rb") as f:
            out_bytes = f.read()
        return StreamingResponse(io.BytesIO(out_bytes), media_type="audio/wav",
                                 headers={"Content-Disposition": 'attachment; filename="converted.wav"'})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        for p in (in_path, out_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass


# ── WebSocket: real-time streaming ────────────────────────────────────────────
@app.websocket("/ws/{voice_folder}")
async def voice_ws(websocket: WebSocket, voice_folder: str):
    await websocket.accept()
    print(f"[RVC] WS connected -> {voice_folder}")
    try:
        rvc = get_model(voice_folder)
    except Exception as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    block_n     = int(BLOCK_SEC * INPUT_SR)
    context_n   = int(CONTEXT_SEC * INPUT_SR)
    xfade_out_n = int(CROSSFADE_SEC * OUTPUT_SR)

    in_buf    = np.zeros(0, dtype=np.float32)   # pending input (16k)
    context   = np.zeros(0, dtype=np.float32)   # trailing input context (16k)
    prev_tail = np.zeros(0, dtype=np.float32)   # previous output tail for crossfade (48k)

    try:
        while True:
            data = await websocket.receive_bytes()
            chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32767.0
            in_buf = np.concatenate([in_buf, chunk])

            while len(in_buf) >= block_n:
                block  = in_buf[:block_n]
                in_buf = in_buf[block_n:]

                # Silence gate: don't run the model on near-silent blocks (avoids
                # turning background hiss into warbly artifacts). Emit matching silence.
                rms = float(np.sqrt(np.mean(block * block))) if len(block) else 0.0
                if rms < SILENCE_RMS:
                    context = block[-context_n:] if context_n else np.zeros(0, dtype=np.float32)
                    prev_tail = np.zeros(0, dtype=np.float32)
                    sil = np.zeros(int(len(block) * OUTPUT_SR / INPUT_SR), dtype=np.int16)
                    await websocket.send_bytes(sil.tobytes())
                    continue

                # prepend context so pitch detection has history
                window = np.concatenate([context, block]) if len(context) else block
                ctx_len = len(context)

                out, out_sr = _infer_array(rvc, window, INPUT_SR)

                # drop the part of the output that corresponds to the context region
                if ctx_len:
                    drop = int(len(out) * ctx_len / len(window))
                    out = out[drop:]

                # crossfade with the previous block's tail to avoid clicks
                if len(prev_tail) and len(out) > xfade_out_n:
                    fade = min(xfade_out_n, len(prev_tail), len(out))
                    ramp = np.linspace(0, 1, fade, dtype=np.float32)
                    out[:fade] = out[:fade] * ramp + prev_tail[:fade] * (1 - ramp)

                if len(out) > xfade_out_n:
                    prev_tail = out[-xfade_out_n:].copy()
                    send = out[:-xfade_out_n]
                else:
                    send = out

                # update context window (keep last context_n input samples)
                context = block[-context_n:] if context_n else np.zeros(0, dtype=np.float32)

                pcm = np.clip(send * 32767.0, -32768, 32767).astype(np.int16)
                await websocket.send_bytes(pcm.tobytes())

    except WebSocketDisconnect:
        print(f"[RVC] WS disconnected -> {voice_folder}")
    except Exception as e:
        print(f"[RVC] WS error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    print("=" * 56)
    print("  VNV Pro RVC Server")
    print("  Models dir:", MODELS_DIR)
    print("  Device:", DEVICE)
    print("  Realtime WS:  /ws/{voice_folder}")
    print("  File convert: POST /convert")
    print("=" * 56)
    uvicorn.run(app, host="0.0.0.0", port=8765)
