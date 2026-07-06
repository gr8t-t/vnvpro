# ============================================================
#  VNV Pro — Voice Clone server (Seed-VC)
#  Zero-shot voice conversion: convert a source recording into
#  the voice of a short reference sample (no training needed).
#  Runs on 127.0.0.1:18100; proxied by the RVC server (/clone/*)
#  the same way w-okada is proxied (/v2/*).
# ============================================================
import asyncio
import io
import os
import wave
import tempfile

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse, Response

app = FastAPI()
_wrapper = None   # loaded at startup (first run downloads checkpoints from HF)


def _run_convert(src_path, ref_path, steps):
    # convert_voice contains `yield`, so it's a generator even with
    # stream_output=False — the final audio comes back as StopIteration.value.
    gen = _wrapper.convert_voice(src_path, ref_path, diffusion_steps=steps,
                                 f0_condition=False, stream_output=False)
    try:
        while True:
            next(gen)
    except StopIteration as e:
        return e.value


@app.get("/health")
def health():
    return {"ok": _wrapper is not None}


@app.post("/convert")
async def convert(source: UploadFile = File(...), reference: UploadFile = File(...),
                  diffusion: int = Form(25)):
    """source = the speech to convert; reference = 5-30s sample of the target voice.
    Returns mono 16-bit WAV @22050 of the source speech in the reference voice."""
    if _wrapper is None:
        return JSONResponse(status_code=503, content={"error": "models still loading, try again shortly"})

    src_path = tempfile.mktemp(suffix=os.path.splitext(source.filename or ".wav")[1] or ".wav")
    ref_path = tempfile.mktemp(suffix=os.path.splitext(reference.filename or ".wav")[1] or ".wav")
    try:
        with open(src_path, "wb") as f:
            f.write(await source.read())
        with open(ref_path, "wb") as f:
            f.write(await reference.read())

        steps = max(4, min(50, int(diffusion)))
        audio = await asyncio.get_event_loop().run_in_executor(
            None, _run_convert, src_path, ref_path, steps)
        if audio is None:
            return JSONResponse(status_code=500, content={"error": "conversion produced no audio"})
        audio = np.asarray(audio, dtype=np.float32).squeeze()
        pcm = np.clip(audio * 32767.0, -32768, 32767).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(22050)
            w.writeframes(pcm.tobytes())
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        for p in (src_path, ref_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass


if __name__ == "__main__":
    print("=" * 56)
    print("  VNV Pro Voice Clone server (Seed-VC)")
    print("  Loading models... first run downloads ~1-2GB from")
    print("  Hugging Face; later starts take ~30-60s.")
    print("=" * 56)
    from seed_vc_wrapper import SeedVCWrapper
    _wrapper = SeedVCWrapper()
    print("  Models loaded. Listening on http://127.0.0.1:18100")
    uvicorn.run(app, host="127.0.0.1", port=18100)
