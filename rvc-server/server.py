"""
VNV Pro — RVC Voice Conversion Server
Run: python server.py
Requires: pip install fastapi uvicorn websockets rvc-python numpy soundfile
GPU: CUDA required for low latency
"""
import asyncio
import json
import numpy as np
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="VNV Pro RVC Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"]
)

MODELS_DIR = Path("models")
SAMPLE_RATE = 16000
CHUNK_SIZE = 4096

# Cache loaded models: { folder_name: rvc_instance }
model_cache = {}


def get_model(folder_name: str):
    if folder_name in model_cache:
        return model_cache[folder_name]

    model_dir = MODELS_DIR / folder_name
    if not model_dir.exists():
        raise ValueError(f"Model directory not found: models/{folder_name}/")

    pth_files = list(model_dir.glob("*.pth"))
    index_files = list(model_dir.glob("*.index"))

    if not pth_files:
        raise ValueError(f"No .pth file found in models/{folder_name}/")

    from rvc_python.infer import RVCInference
    rvc = RVCInference(device="cuda:0")  # change to "cpu" if no GPU
    rvc.load_model(
        str(pth_files[0]),
        str(index_files[0]) if index_files else ""
    )
    model_cache[folder_name] = rvc
    print(f"[RVC] Loaded model: {folder_name}")
    return rvc


@app.get("/health")
async def health():
    return {"status": "ok", "models_dir": str(MODELS_DIR.absolute())}


@app.get("/models")
async def list_models():
    models = []
    if MODELS_DIR.exists():
        for d in MODELS_DIR.iterdir():
            if d.is_dir() and list(d.glob("*.pth")):
                models.append(d.name)
    return {"models": models}


@app.websocket("/ws/{voice_folder}")
async def voice_ws(websocket: WebSocket, voice_folder: str):
    await websocket.accept()
    print(f"[RVC] Client connected → voice: {voice_folder}")

    try:
        rvc = get_model(voice_folder)
    except Exception as e:
        await websocket.send_text(json.dumps({"error": str(e)}))
        await websocket.close()
        return

    audio_buffer = np.array([], dtype=np.float32)
    MIN_PROCESS_SAMPLES = SAMPLE_RATE // 2  # 0.5 second minimum chunk

    try:
        while True:
            data = await websocket.receive_bytes()

            # Convert int16 bytes → float32
            int16_arr = np.frombuffer(data, dtype=np.int16)
            float32_arr = int16_arr.astype(np.float32) / 32767.0

            # Accumulate buffer
            audio_buffer = np.concatenate([audio_buffer, float32_arr])

            # Process when we have enough audio
            if len(audio_buffer) >= MIN_PROCESS_SAMPLES:
                chunk = audio_buffer[:MIN_PROCESS_SAMPLES]
                audio_buffer = audio_buffer[MIN_PROCESS_SAMPLES:]

                try:
                    # Run RVC inference
                    converted = rvc.infer(
                        audio_data=chunk,
                        f0_up_key=0,           # pitch shift (0 = no shift)
                        f0_method="rmvpe",     # pitch extraction method
                        index_rate=0.75,       # index influence
                        protect=0.5
                    )

                    # Convert back to int16 and send
                    out_int16 = (np.clip(converted, -1.0, 1.0) * 32767).astype(np.int16)
                    await websocket.send_bytes(out_int16.tobytes())

                except Exception as e:
                    print(f"[RVC] Inference error: {e}")
                    # Send silence on error
                    silence = np.zeros(MIN_PROCESS_SAMPLES, dtype=np.int16)
                    await websocket.send_bytes(silence.tobytes())

    except WebSocketDisconnect:
        print(f"[RVC] Client disconnected from {voice_folder}")
    except Exception as e:
        print(f"[RVC] Error: {e}")


if __name__ == "__main__":
    print("=" * 50)
    print("VNV Pro RVC Server starting...")
    print(f"Models directory: {MODELS_DIR.absolute()}")
    print("Place voice models in: models/{voice_name}/model.pth")
    print("=" * 50)

    # Create models dir if it doesn't exist
    MODELS_DIR.mkdir(exist_ok=True)

    uvicorn.run(app, host="0.0.0.0", port=8765)
