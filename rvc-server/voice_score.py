"""
VNV Pro - Voice Match scoring (CAMPPlus speaker verification)
─────────────────────────────────────────────────────────────
Measures how close a converted-voice output sounds to the REAL target voice,
returned as a 0-100% score (100 = identical to the real voice, 0 = a stranger).

Reference per voice:
  - trained voices  -> the training audio the user uploaded
  - imported voices -> that voice's preview clip (from Redis previewBase64)

Reference embeddings are precomputed once into voice_refs.json (run this file
directly to (re)build). At runtime the server loads that small JSON + the
CAMPPlus model and scores incoming 16kHz mono int16 PCM.
"""
import os, sys, io, json, re, base64, wave, tempfile, subprocess
import numpy as np
import torch, torchaudio

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
SEEDVC_DIR   = r"C:\Users\USER\seed-vc"
CAMPPLUS_BIN = os.path.join(SEEDVC_DIR, "campplus_cn_common.bin")
FFMPEG       = r"C:\Users\USER\Desktop\Applio\ffmpeg.exe"
REFS_FILE    = os.path.join(BASE_DIR, "voice_refs.json")
DEVICE       = "cuda:0" if torch.cuda.is_available() else "cpu"
FLOOR        = 0.30   # cosine at/below this reads as 0% (a different person)

# Trained voices: the reference is the real audio the user uploaded to train.
TRAINED_AUDIO = {
    "gleencook": [r"C:\Users\USER\Desktop\Applio\datasets\gleencook\gleencook.wav",
                  r"C:\Users\USER\Desktop\Applio\_gleen_new.wav"],
    "george":    [r"C:\Users\USER\Desktop\Applio\datasets\george\george_combined.wav"],
}

_cp = None
def _model():
    global _cp
    if _cp is None:
        if SEEDVC_DIR not in sys.path:
            sys.path.insert(0, SEEDVC_DIR)
        from modules.campplus.DTDNN import CAMPPlus
        m = CAMPPlus(feat_dim=80, embedding_size=192)
        m.load_state_dict(torch.load(CAMPPLUS_BIN, map_location="cpu"))
        m.eval().to(DEVICE)
        _cp = m
    return _cp

def _read_wav16(path):
    with wave.open(path, "rb") as w:
        n, ch = w.getnframes(), w.getnchannels()
        raw = w.readframes(n)
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(1)
    return a

def _decode_to_wav16(in_bytes=None, in_path=None):
    """Any audio (mp3/m4a/wav) -> float32 mono @16k, via ffmpeg."""
    outp = tempfile.mktemp(suffix=".wav")
    src = in_path
    tmp_in = None
    if src is None:
        tmp_in = tempfile.mktemp(suffix=".bin"); open(tmp_in, "wb").write(in_bytes); src = tmp_in
    subprocess.run([FFMPEG, "-y", "-i", src, "-ac", "1", "-ar", "16000", outp],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        y = _read_wav16(outp)
    finally:
        for p in (outp, tmp_in):
            if p:
                try: os.remove(p)
                except Exception: pass
    return y

def _embed(y):
    """Mean CAMPPlus embedding over ~4s voiced chunks. y = float32 mono @16k."""
    m = _model()
    embs = []
    step = 16000 * 4
    for i in range(0, len(y), step):
        c = y[i:i + step]
        if len(c) < 16000:                         # need >=1s
            continue
        if np.sqrt(np.mean(c ** 2)) < 0.005:       # skip near-silence
            continue
        w = torch.from_numpy(np.ascontiguousarray(c)).float().unsqueeze(0).to(DEVICE)
        f = torchaudio.compliance.kaldi.fbank(w, num_mel_bins=80, dither=0, sample_frequency=16000)
        f = f - f.mean(0, keepdim=True)
        with torch.no_grad():
            e = m(f.unsqueeze(0)).squeeze(0).cpu().numpy()
        embs.append(e / (np.linalg.norm(e) + 1e-9))
    if not embs:
        return None
    v = np.mean(embs, 0)
    return v / (np.linalg.norm(v) + 1e-9)

# ---- build references (run once; re-run when a voice/preview changes) --------
def build(admin_password):
    import requests
    refs = {}
    voices = requests.post("https://vnvpro.vercel.app/api/voices",
                           json={"action": "list", "password": admin_password},
                           timeout=30).json().get("voices", [])
    for v in voices:
        folder = v.get("folderName")
        if not folder:
            continue
        ys = []
        if folder in TRAINED_AUDIO:
            for p in TRAINED_AUDIO[folder]:
                if os.path.exists(p):
                    ys.append(_decode_to_wav16(in_path=p))
        else:
            pv = v.get("previewBase64") or ""
            if pv:
                pv = re.sub(r'^data:[^,]+,', '', pv)
                try:
                    ys.append(_decode_to_wav16(in_bytes=base64.b64decode(pv)))
                except Exception as e:
                    print("  preview decode failed for", folder, e)
        if not ys:
            print("  (no reference audio for", folder, "- skipped)")
            continue
        y = np.concatenate(ys)
        ref = _embed(y)
        if ref is None:
            continue
        h = len(y) // 2
        e1, e2 = _embed(y[:h]), _embed(y[h:])
        self_sim = float(np.dot(e1, e2)) if (e1 is not None and e2 is not None) else 0.9
        ceil = max(0.60, min(0.97, self_sim))       # "100%" = identical to the real voice
        refs[folder] = {"ref": ref.tolist(), "ceil": ceil}
        print(f"  built {folder:14s} ceil={ceil:.3f}")
    json.dump(refs, open(REFS_FILE, "w"))
    print(f"saved {REFS_FILE}  ({len(refs)} voices)")

# ---- runtime scoring --------------------------------------------------------
_refs = None
def _load_refs():
    global _refs
    if _refs is None:
        _refs = json.load(open(REFS_FILE)) if os.path.exists(REFS_FILE) else {}
    return _refs

def reload_refs():
    global _refs
    _refs = None
    return _load_refs()

def score_pcm16(pcm_bytes, folder):
    """pcm_bytes = 16kHz mono int16. Returns {ok, percent, cosine}."""
    r = _load_refs().get(folder)
    if not r:
        return {"ok": False, "error": f"no reference for '{folder}'"}
    y = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if len(y) < 16000:                              # <1s = not enough to judge
        return {"ok": False, "error": "need at least ~1s of speech"}
    e = _embed(y)
    if e is None:
        return {"ok": False, "error": "no voiced audio detected"}
    cos = float(np.dot(e, np.array(r["ref"], dtype=np.float32)))
    ceil = r["ceil"]
    pct = int(round(max(0.0, min(1.0, (cos - FLOOR) / (ceil - FLOOR))) * 100))
    return {"ok": True, "percent": pct, "cosine": round(cos, 3)}

if __name__ == "__main__":
    pw = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("ADMIN_PW", "")
    build(pw)
