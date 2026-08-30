#!/usr/bin/env python3
"""
vnvpro Studio — local Voice 2.0 proxy (runs on the user's OWN machine).

The vnvpro web app (HTTPS) talks to this directly at http://127.0.0.1:8765 —
NO tunnel needed, because the engine and the browser are on the same laptop.
This proxies to the local w-okada engine, exactly like the Isele proxy, with two
differences that make the browser allow the HTTPS->localhost call:

  1. Access-Control-Allow-Private-Network: true   (Chrome/Edge "local network" rule)
  2. CORS locked to https://vnvpro.vercel.app      (so only vnvpro can reach it)

Deps: numpy, soxr, requests (no torch) — freezes small, like the Isele proxy.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np
import soxr
import requests

WOKADA = "http://127.0.0.1:18000"
DEFAULT_PORT = 8765
ALLOWED_ORIGIN = "https://vnvpro.vercel.app"


def _cors(h):
    # Lock to vnvpro so no other website can poke the local engine.
    h.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
    h.send_header("Vary", "Origin")
    h.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "*")
    # Chrome/Edge Private Network Access: required for an HTTPS page to call localhost.
    h.send_header("Access-Control-Allow-Private-Network", "true")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        _cors(self)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, code, data):
        self.send_response(code)
        _cors(self)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        _cors(self)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True})
        if path == "/v2/health":
            try:
                r = requests.get(f"{WOKADA}/api/hello", timeout=5)
                return self._json(200, {"ok": r.status_code == 200})
            except Exception as e:
                return self._json(503, {"ok": False, "error": str(e)})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path
        q = parse_qs(u.query)
        clen = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(clen) if clen else b""

        if path == "/v2/set_slot":
            slot = int(q.get("slot", [0])[0])
            try:
                cfg = requests.get(f"{WOKADA}/api/configuration-manager/configuration", timeout=10).json()
                cfg["current_slot_index"] = slot
                r = requests.put(f"{WOKADA}/api/configuration-manager/configuration", json=cfg, timeout=15)
                return self._json(200, {"ok": r.status_code == 200, "slot": slot})
            except Exception as e:
                return self._json(502, {"ok": False, "error": str(e)})

        if path == "/v2/set_pitch":
            slot = int(q.get("slot", [0])[0])
            pitch = int(q.get("pitch", [0])[0])
            try:
                s = requests.get(f"{WOKADA}/api/slot-manager/slots/{slot}", timeout=10).json()
                s["pitch_shift"] = pitch
                r = requests.put(f"{WOKADA}/api/slot-manager/slots/{slot}", json=s, timeout=15)
                return self._json(200, {"ok": r.status_code == 200, "slot": slot, "pitch": pitch})
            except Exception as e:
                return self._json(502, {"ok": False, "error": str(e)})

        if path == "/v2/convert":
            ts = q.get("ts", ["0"])[0]
            if not body:
                return self._bytes(200, b"")
            in16 = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
            if len(in16) == 0:
                return self._bytes(200, b"")
            up = soxr.resample(in16, 16000, 48000).astype("<f4")
            try:
                files = {"waveform": ("chunk.bin", up.tobytes(), "application/octet-stream")}
                r = requests.post(f"{WOKADA}/api/voice-changer/convert_chunk",
                                  files=files, headers={"x-timestamp": str(ts)}, timeout=30)
            except Exception as e:
                return self._json(502, {"error": "w-okada unreachable", "detail": str(e)})
            if r.status_code != 200:
                return self._json(502, {"error": "convert failed", "detail": r.text[:200]})
            out48 = np.frombuffer(r.content, dtype="<f4")
            if len(out48) == 0:
                return self._bytes(200, b"")
            out16 = soxr.resample(out48, 48000, 16000)
            out16i = np.clip(out16 * 32768.0, -32768, 32767).astype("<i2")
            return self._bytes(200, out16i.tobytes())

        return self._json(404, {"error": "not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    print(f"vnvpro Studio proxy on 127.0.0.1:{port}  ->  w-okada {WOKADA}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
