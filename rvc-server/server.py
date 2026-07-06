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
import asyncio
import json
import wave
import tempfile
import threading
import numpy as np
import requests
import soxr   # high-quality, anti-aliased resampling for the Voice 2.0 proxy

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn

from rvc_python.infer import RVCInference

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR  = os.path.join(BASE_DIR, "models")
DEVICE      = "cuda:0"          # set to "cpu" if no NVIDIA GPU
OUTPUT_SR   = 48000             # rvc-python outputs 48 kHz mono
INPUT_SR    = 16000             # what the browser sends us
WOKADA_URL  = "http://127.0.0.1:18000"   # local w-okada (Voice 2.0). 127.0.0.1 (not "localhost") avoids the ~2s IPv6-resolution stall in requests
CLONE_URL   = "http://127.0.0.1:18100"   # local Seed-VC clone server (zero-shot voice cloning)

# Real-time tuning (seconds) — Voice 1.0 (Standard)
BLOCK_SEC      = 1.00           # audio gathered before each conversion (lower = less delay)
CONTEXT_SEC    = 0.25           # past audio prepended for pitch context (smaller = less word clipping)
CROSSFADE_SEC  = 0.10           # overlap blended between consecutive outputs (bigger = smoother)
SILENCE_RMS    = 0.0025         # gate only near-silence; lower so quiet word onsets/endings survive

# Voice 2.0 (Premium) — windowed overlap-add: emits the artifact-free CENTRE of each
# inference, with context on BOTH sides, so chunk-edge breakage is avoided.
V2_HOP_SEC       = 0.50         # new audio emitted per step
V2_LOOKBACK_SEC  = 0.50         # past context fed into each inference
V2_LOOKAHEAD_SEC = 0.50         # future context fed into each inference (adds this much latency)
V2_XFADE_SEC     = 0.10         # crossfade between consecutive emitted segments

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
        # protect < 0.5: lower value keeps MORE of the clean original voice on
        # breath/unvoiced frames (pipeline blends feats*protect + original*(1-protect)).
        # 0.33 reduces the "background tearing/noise" RVC otherwise synthesizes there.
        rvc.set_params(f0method="rmvpe", f0up_key=0, index_rate=0.5, protect=0.33)
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


async def _edge_synth(text, base):
    """Synthesize text with edge-tts. Returns MP3 bytes (raises on failure)."""
    import edge_tts
    buf = io.BytesIO()
    com = edge_tts.Communicate(text, base)
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    return buf.getvalue()


@app.post("/tts")
async def tts(request: Request):
    """Text-to-Speech: edge-tts neural synth, optionally converted through an
    RVC character voice. JSON body: { text, base?, voice?, pitch? }.
    - base: edge-tts voice id (default en-US-JennyNeural)
    - voice: RVC model folderName; omit for the plain neural voice (returns MP3)
    - pitch: semitone shift for the RVC conversion (default 0)
    Returns MP3 (no voice) or WAV (converted)."""
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "JSON body required"})
    text = (data.get("text") or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "text required"})
    if len(text) > 1200:
        return JSONResponse(status_code=400, content={"error": "text too long (max 1200 characters)"})
    base = data.get("base") or "en-US-JennyNeural"
    voice = data.get("voice") or None
    pitch = int(data.get("pitch") or 0)

    try:
        mp3 = await _edge_synth(text, base)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"TTS synth failed: {e}"})
    if not mp3:
        return JSONResponse(status_code=502, content={"error": "TTS produced no audio"})

    if not voice:
        return Response(content=mp3, media_type="audio/mpeg")

    # Convert through the requested RVC character voice (same path as /convert)
    try:
        rvc = get_model(voice)
    except Exception as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
    import librosa
    y, _sr = librosa.load(io.BytesIO(mp3), sr=16000)
    rvc.set_params(f0method="rmvpe", f0up_key=pitch, index_rate=0.75, protect=0.33)
    try:
        out, out_sr = await asyncio.get_event_loop().run_in_executor(
            None, _infer_array, rvc, y.astype(np.float32), 16000)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"conversion failed: {e}"})
    pcm = np.clip(out * 32767.0, -32768, 32767).astype(np.int16)
    wb = io.BytesIO()
    with wave.open(wb, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(out_sr)
        w.writeframes(pcm.tobytes())
    return Response(content=wb.getvalue(), media_type="audio/wav")


# ── Voice cloning (Seed-VC) proxy ─────────────────────────────────────────────
# Zero-shot cloning: users upload a 5-30s sample of a voice, and their recording
# (or TTS narration) is converted into THAT voice. The Seed-VC server (18100) is
# local-only, so we proxy it here for CORS + one tunnel, like w-okada (/v2/*).

@app.get("/clone/health")
def clone_health():
    """Is the Seed-VC clone server up (and are its models loaded)?"""
    try:
        r = requests.get(f"{CLONE_URL}/health", timeout=5)
        return {"ok": r.status_code == 200 and r.json().get("ok") is True}
    except Exception as e:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})


@app.post("/clone/convert")
async def clone_convert(source: UploadFile = File(...), reference: UploadFile = File(...)):
    """Convert `source` speech into the voice of the `reference` sample."""
    src = await source.read()
    ref = await reference.read()

    def _do():
        return requests.post(f"{CLONE_URL}/convert", files={
            "source": (source.filename or "source.wav", src, "application/octet-stream"),
            "reference": (reference.filename or "reference.wav", ref, "application/octet-stream"),
        }, timeout=600)

    try:
        r = await asyncio.get_event_loop().run_in_executor(None, _do)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"clone server unreachable: {e}"})
    if r.status_code != 200:
        try:
            detail = r.json().get("error", r.text[:200])
        except Exception:
            detail = r.text[:200]
        return JSONResponse(status_code=502, content={"error": detail})
    return Response(content=r.content, media_type="audio/wav")


@app.post("/tts_clone")
async def tts_clone(text: str = Form(...), base: str = Form("en-US-JennyNeural"),
                    reference: UploadFile = File(...)):
    """Text-to-Speech in a CLONED voice: edge-tts narrates the text, then the
    Seed-VC server converts the narration into the uploaded reference voice."""
    text = (text or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "text required"})
    if len(text) > 1200:
        return JSONResponse(status_code=400, content={"error": "text too long (max 1200 characters)"})
    try:
        mp3 = await _edge_synth(text, base)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"TTS synth failed: {e}"})
    if not mp3:
        return JSONResponse(status_code=502, content={"error": "TTS produced no audio"})

    ref = await reference.read()

    def _do():
        return requests.post(f"{CLONE_URL}/convert", files={
            "source": ("narration.mp3", mp3, "application/octet-stream"),
            "reference": (reference.filename or "reference.wav", ref, "application/octet-stream"),
        }, timeout=600)

    try:
        r = await asyncio.get_event_loop().run_in_executor(None, _do)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"clone server unreachable: {e}"})
    if r.status_code != 200:
        try:
            detail = r.json().get("error", r.text[:200])
        except Exception:
            detail = r.text[:200]
        return JSONResponse(status_code=502, content={"error": detail})
    return Response(content=r.content, media_type="audio/wav")


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
    min_flush_n = int(0.08 * INPUT_SR)          # flush short tails too, so the last word isn't dropped
    # The browser sends ~0.256s chunks (ScriptProcessor 4096 @ 16kHz). FLUSH_IDLE
    # MUST be larger than that gap, or the server times out between every chunk
    # and processes tiny 0.25s fragments instead of full BLOCK_SEC blocks — which
    # makes RVC choppy and unclear. 0.50s lets chunks accumulate into real blocks
    # and only flushes the tail on an actual speech pause.
    FLUSH_IDLE  = 0.50                          # seconds of no audio before flushing tail

    state = {
        "context":   np.zeros(0, dtype=np.float32),  # trailing input context (16k)
        "prev_tail": np.zeros(0, dtype=np.float32),  # previous output tail for crossfade (48k)
    }
    in_buf = np.zeros(0, dtype=np.float32)           # pending input (16k)

    async def process_block(block, is_flush=False):
        # Silence gate: skip the model on near-silent blocks (no hiss conversion)
        rms = float(np.sqrt(np.mean(block * block))) if len(block) else 0.0
        if rms < SILENCE_RMS:
            state["context"] = block[-context_n:] if context_n else np.zeros(0, dtype=np.float32)
            state["prev_tail"] = np.zeros(0, dtype=np.float32)
            sil = np.zeros(int(len(block) * OUTPUT_SR / INPUT_SR), dtype=np.int16)
            await websocket.send_bytes(sil.tobytes())
            return

        context = state["context"]
        window  = np.concatenate([context, block]) if len(context) else block
        ctx_len = len(context)

        out, _ = _infer_array(rvc, window, INPUT_SR)

        # drop the output region that corresponds to the prepended context
        if ctx_len:
            drop = int(len(out) * ctx_len / len(window))
            out = out[drop:]

        # crossfade with the previous block's tail to avoid clicks
        prev_tail = state["prev_tail"]
        if len(prev_tail) and len(out) > xfade_out_n:
            fade = min(xfade_out_n, len(prev_tail), len(out))
            ramp = np.linspace(0, 1, fade, dtype=np.float32)
            out[:fade] = out[:fade] * ramp + prev_tail[:fade] * (1 - ramp)

        # On a flush (end of utterance) send the whole tail so the last word completes
        if not is_flush and len(out) > xfade_out_n:
            state["prev_tail"] = out[-xfade_out_n:].copy()
            send = out[:-xfade_out_n]
        else:
            state["prev_tail"] = np.zeros(0, dtype=np.float32)
            send = out

        state["context"] = block[-context_n:] if context_n else np.zeros(0, dtype=np.float32)
        pcm = np.clip(send * 32767.0, -32768, 32767).astype(np.int16)
        await websocket.send_bytes(pcm.tobytes())

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_bytes(), timeout=FLUSH_IDLE)
            except asyncio.TimeoutError:
                # paused/stopped talking — flush whatever is left so words finish
                if len(in_buf) >= min_flush_n:
                    await process_block(in_buf, is_flush=True)
                    in_buf = np.zeros(0, dtype=np.float32)
                continue

            chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32767.0
            in_buf = np.concatenate([in_buf, chunk])

            while len(in_buf) >= block_n:
                block  = in_buf[:block_n]
                in_buf = in_buf[block_n:]
                await process_block(block)

    except WebSocketDisconnect:
        print(f"[RVC] WS disconnected -> {voice_folder}")
    except Exception as e:
        print(f"[RVC] WS error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass


# ── WebSocket: Voice 2.0 (Premium) — windowed overlap-add ─────────────────────
@app.websocket("/ws2/{voice_folder}")
async def voice_ws2(websocket: WebSocket, voice_folder: str):
    await websocket.accept()
    print(f"[RVC] WS2 connected -> {voice_folder}")
    try:
        rvc = get_model(voice_folder)
    except Exception as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    hop_n       = int(V2_HOP_SEC * INPUT_SR)
    lookback_n  = int(V2_LOOKBACK_SEC * INPUT_SR)
    lookahead_n = int(V2_LOOKAHEAD_SEC * INPUT_SR)
    xfade_out_n = int(V2_XFADE_SEC * OUTPUT_SR)
    FLUSH_IDLE  = 0.25

    state = {
        "history":   np.zeros(0, dtype=np.float32),  # past input kept as lookback (16k)
        "prev_tail": np.zeros(0, dtype=np.float32),  # previous emitted output tail (48k)
    }
    in_buf = np.zeros(0, dtype=np.float32)            # unconsumed input (16k)

    async def process(hop, lookahead, is_flush=False):
        history = state["history"]
        window  = np.concatenate([history, hop, lookahead]) if (len(history) or len(lookahead)) else hop
        if len(window) == 0:
            return

        # Silence gate on the hop itself
        rms = float(np.sqrt(np.mean(hop * hop))) if len(hop) else 0.0
        if rms < SILENCE_RMS:
            state["history"] = (np.concatenate([history, hop]))[-lookback_n:] if lookback_n else np.zeros(0, dtype=np.float32)
            state["prev_tail"] = np.zeros(0, dtype=np.float32)
            sil = np.zeros(int(len(hop) * OUTPUT_SR / INPUT_SR), dtype=np.int16)
            await websocket.send_bytes(sil.tobytes())
            return

        out, _ = _infer_array(rvc, window, INPUT_SR)

        # Emit only the CENTRE region that corresponds to `hop` (skip lookback &
        # lookahead portions). Centre is artifact-free since both sides had context.
        total = len(window)
        start = int(len(out) * len(history) / total)
        end   = int(len(out) * (len(history) + len(hop)) / total)
        seg   = out[start:end].copy()

        # crossfade with previous emitted tail to smooth the join
        prev_tail = state["prev_tail"]
        if len(prev_tail) and len(seg) > xfade_out_n:
            fade = min(xfade_out_n, len(prev_tail), len(seg))
            ramp = np.linspace(0, 1, fade, dtype=np.float32)
            seg[:fade] = seg[:fade] * ramp + prev_tail[:fade] * (1 - ramp)

        if not is_flush and len(seg) > xfade_out_n:
            state["prev_tail"] = seg[-xfade_out_n:].copy()
            send = seg[:-xfade_out_n]
        else:
            state["prev_tail"] = np.zeros(0, dtype=np.float32)
            send = seg

        state["history"] = (np.concatenate([history, hop]))[-lookback_n:] if lookback_n else np.zeros(0, dtype=np.float32)
        pcm = np.clip(send * 32767.0, -32768, 32767).astype(np.int16)
        await websocket.send_bytes(pcm.tobytes())

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_bytes(), timeout=FLUSH_IDLE)
            except asyncio.TimeoutError:
                # flush trailing audio (no lookahead available at end)
                if len(in_buf) >= int(0.20 * INPUT_SR):
                    await process(in_buf, np.zeros(0, dtype=np.float32), is_flush=True)
                    in_buf = np.zeros(0, dtype=np.float32)
                continue

            chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32767.0
            in_buf = np.concatenate([in_buf, chunk])

            # need hop + lookahead available before emitting a hop
            while len(in_buf) >= hop_n + lookahead_n:
                hop       = in_buf[:hop_n]
                lookahead = in_buf[hop_n:hop_n + lookahead_n]   # peek, not consumed
                in_buf    = in_buf[hop_n:]                       # consume only the hop
                await process(hop, lookahead)

    except WebSocketDisconnect:
        print(f"[RVC] WS2 disconnected -> {voice_folder}")
    except Exception as e:
        print(f"[RVC] WS2 error: {e}")
        try:
            await websocket.close()
        except Exception:
            pass


# ── Voice 2.0 proxy → local w-okada server ────────────────────────────────────
# The browser can't call w-okada directly (it sends no CORS headers). This server
# DOES have CORS (allow_origins=*), so vnvpro hits these /v2 endpoints on the SAME
# tunnel and we forward to w-okada on localhost. Keeps Voice 1.0 + 2.0 on one tunnel.

@app.get("/v2/health")
def v2_health():
    """Is the w-okada (Voice 2.0) engine up?"""
    try:
        r = requests.get(f"{WOKADA_URL}/api/hello", timeout=5)
        return {"ok": r.status_code == 200}
    except Exception as e:
        return JSONResponse(status_code=503, content={"ok": False, "error": str(e)})


@app.post("/v2/set_slot")
def v2_set_slot(slot: int):
    """Select which w-okada voice (model slot) to convert with."""
    try:
        cfg = requests.get(f"{WOKADA_URL}/api/configuration-manager/configuration", timeout=10).json()
        cfg["current_slot_index"] = int(slot)
        r = requests.put(f"{WOKADA_URL}/api/configuration-manager/configuration", json=cfg, timeout=15)
        return {"ok": r.status_code == 200, "slot": int(slot)}
    except Exception as e:
        return JSONResponse(status_code=502, content={"ok": False, "error": str(e)})


@app.post("/v2/set_pitch")
def v2_set_pitch(slot: int, pitch: int = 0):
    """Set a w-okada slot's pitch shift (semitones), live. Backs the Voice 2.0
    pitch slider so different speakers can dial themselves into the target range."""
    try:
        s = requests.get(f"{WOKADA_URL}/api/slot-manager/slots/{slot}", timeout=10).json()
        s["pitch_shift"] = int(pitch)
        r = requests.put(f"{WOKADA_URL}/api/slot-manager/slots/{slot}", json=s, timeout=15)
        return {"ok": r.status_code == 200, "slot": int(slot), "pitch": int(pitch)}
    except Exception as e:
        return JSONResponse(status_code=502, content={"ok": False, "error": str(e)})


@app.post("/v2/convert")
async def v2_convert(request: Request, ts: int = 0):
    """Voice 2.0 chunk convert, bandwidth-optimised for the tunnel.

    The browser sends int16 mono @16k (small). We upsample to float32 @48k for
    w-okada's convert_chunk, then downsample its float32 @48k output back to
    int16 @16k for the browser. 16k carries no quality loss for the conversion
    (w-okada works at 16k internally); it just keeps the tunnel payload ~6x smaller.
    `ts` is a monotonic counter so w-okada stitches consecutive chunks smoothly."""
    raw = await request.body()
    in16 = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if len(in16) == 0:
        return Response(content=b"", media_type="application/octet-stream")
    # upsample 16k -> 48k for w-okada (soxr = anti-aliased, clean)
    up = soxr.resample(in16, 16000, 48000).astype("<f4")

    def _do():
        files = {"waveform": ("chunk.bin", up.tobytes(), "application/octet-stream")}
        return requests.post(f"{WOKADA_URL}/api/voice-changer/convert_chunk",
                             files=files, headers={"x-timestamp": str(ts)}, timeout=30)

    try:
        r = await asyncio.get_event_loop().run_in_executor(None, _do)
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": "w-okada unreachable", "detail": str(e)})
    if r.status_code != 200:
        return JSONResponse(status_code=502, content={"error": "convert failed", "detail": r.text[:200]})

    out48 = np.frombuffer(r.content, dtype="<f4")
    if len(out48) == 0:
        return Response(content=b"", media_type="application/octet-stream")
    # downsample 48k -> 16k for the browser (soxr = anti-aliased, no muddy artifacts)
    out16 = soxr.resample(out48, 48000, 16000)
    out16i = np.clip(out16 * 32768.0, -32768, 32767).astype("<i2")
    return Response(content=out16i.tobytes(), media_type="application/octet-stream")


if __name__ == "__main__":
    print("=" * 56)
    print("  VNV Pro RVC Server")
    print("  Models dir:", MODELS_DIR)
    print("  Device:", DEVICE)
    print("  Realtime WS:   /ws/{voice_folder}   (Voice 1.0)")
    print("  Premium WS:    /ws2/{voice_folder}  (Voice 2.0)")
    print("  File convert:  POST /convert")
    print("=" * 56)
    uvicorn.run(app, host="0.0.0.0", port=8765)
