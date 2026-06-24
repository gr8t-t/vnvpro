// AudioWorklet processor — runs on a dedicated real-time audio thread.
// This avoids the frame-drop problem with the deprecated ScriptProcessorNode,
// which ran on the main JS thread and got starved by UI work.
class AudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._pos = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this._buf[this._pos++] = channel[i];
      if (this._pos >= 2048) {
        // Transfer ownership of the buffer to the main thread (zero-copy)
        const out = this._buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}

registerProcessor('audio-capture', AudioCapture);
