// VNV Pro — app.js

// ─── STATE ────────────────────────────────────────────────────────────────────
let mode = 'video';
let engine = 'v1';                 // 'v1' (Standard) | 'v2' (Premium)
let selectedVoice = null;
let videoDelayMs = 0;              // ms to buffer video output (delays video to match slow audio)
let frameBuffer = [];              // { time: DOMHighResTimeStamp, bmp: ImageBitmap }
let captureIntervalId = null;      // setInterval handle for frame capture
let delayRafId = null;             // requestAnimationFrame handle for delayed render
let rvcWs = null;
let v2HeartbeatInterval = null;
let v1HeartbeatInterval = null;
let waitPollInterval = null;
let rvcServerUrl = null;
let audioCtx = null;
let playbackCtx = null;
let nextPlayTime = 0;
let micStream = null;
let processor = null;
const RVC_OUTPUT_SR = 48000;
let lastBilledSeconds = 0;
let decartApiKey = null;
let keyLoadPromise = null;
let currentEmail = null;
let coinBalance = 0;
let realtimeClient = null;
let referenceFile = null;
let settingsApplied = false;
let isStreaming = false;
let audioBillingInterval = null;
let audioBillingSeconds = 0;
let voices = [];
let packages = [];
let wallets = {};
let bankInfo = {};
let selectedPkgId = null;
let micLevelInterval = null;
let analyser = null;

// ─── INIT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Session check
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem('vnv_session') || 'null');
  } catch (_) {}

  if (!session || !session.email) {
    window.location.href = 'login.html';
    return;
  }

  currentEmail = session.email;

  // Show the access-code lock screen if this user hasn't acknowledged it yet
  await checkAccessCode();

  // Fire logged-in event
  document.dispatchEvent(new CustomEvent('vnv:logged-in', { detail: { email: currentEmail } }));

  // Heartbeat
  setInterval(() => sendHeartbeat(), 30000);
  sendHeartbeat();

  // Load everything in parallel
  await Promise.all([
    loadBalance(),
    loadVoices(),
    loadRvcUrl(),
    loadPackagesAndWallets()
  ]);

  // Start key load in background for video modes
  keyLoadPromise = fetchApiKey(currentEmail);

  // Set up video sync delay slider
  document.getElementById('delaySlider').addEventListener('input', (e) => {
    setVideoDelay(parseInt(e.target.value));
  });

  // Set up enhance toggle label
  document.getElementById('enhanceToggle').addEventListener('change', (e) => {
    e.target.parentElement.nextElementSibling.textContent = e.target.checked ? 'On' : 'Off';
  });

  setupVideoControls();

  // Apply the default mode layout (Video Only) on load
  setMode('video');
  setEngine('v1');

  // Full-screen pop-out of the AI output in a new tab
  const popoutBtn = document.getElementById('popoutBtn');
  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => {
      if (!window.aiOutputStream) { showToast('Start a video stream first.', 'info'); return; }
      window.open('output.html', '_blank');
    });
  }
});

// ─── ACCESS CODE LOCK SCREEN ───────────────────────────────────────────────────
async function checkAccessCode() {
  let data;
  try {
    const res = await fetch('/api/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_access_code', email: currentEmail })
    });
    data = await res.json();
  } catch (_) { return; }
  if (!data || !data.code) return;  // already acknowledged or none

  const overlay     = document.getElementById('codeOverlay');
  const copyBtn     = document.getElementById('codeCopyBtn');
  const continueBtn = document.getElementById('codeContinueBtn');
  document.getElementById('codeValue').textContent = data.code;
  overlay.style.display = 'flex';

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(data.code).then(
      () => { copyBtn.textContent = '✓ Copied'; setTimeout(() => copyBtn.textContent = 'Copy Code', 1800); },
      () => { copyBtn.textContent = 'Copy failed'; }
    );
  };

  // Block here until the user clicks Continue (which acknowledges in the DB)
  await new Promise(resolve => {
    continueBtn.onclick = async () => {
      continueBtn.disabled = true;
      continueBtn.textContent = 'Saving…';
      try {
        await fetch('/api/signup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ack_code', email: currentEmail })
        });
      } catch (_) {}
      overlay.style.display = 'none';
      resolve();
    };
  });
}

// ─── VIDEO CONTROLS: presets + reference image ─────────────────────────────────
function setupVideoControls() {
  // Presets
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('promptInput').value = btn.dataset.prompt;
    });
  });

  // Reference image upload
  const uploadZone  = document.getElementById('uploadZone');
  const imageUpload = document.getElementById('imageUpload');
  if (uploadZone && imageUpload) {
    uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--accent)'; });
    uploadZone.addEventListener('dragleave', ()  => { uploadZone.style.borderColor = 'var(--border)'; });
    uploadZone.addEventListener('drop', e => {
      e.preventDefault(); uploadZone.style.borderColor = 'var(--border)';
      if (e.dataTransfer.files[0]) handleImageFile(e.dataTransfer.files[0]);
    });
    imageUpload.addEventListener('change', () => { if (imageUpload.files[0]) handleImageFile(imageUpload.files[0]); });
  }

  const removeImage = document.getElementById('removeImage');
  if (removeImage) {
    removeImage.addEventListener('click', () => {
      referenceFile = null;
      document.getElementById('imagePreview').src = '';
      document.getElementById('imagePreviewWrap').style.display = 'none';
      uploadZone.style.display = 'block';
      imageUpload.value = '';
      settingsApplied = false;
    });
  }
}

function handleImageFile(file) {
  if (!file.type.startsWith('image/')) { showToast('Please upload an image file.', 'error'); return; }
  if (file.size > 10 * 1024 * 1024)   { showToast('Image too large. Max 10MB.', 'error'); return; }
  compressImage(file, 1024).then(compressed => {
    referenceFile = compressed;
    document.getElementById('imagePreview').src = URL.createObjectURL(compressed);
    document.getElementById('imagePreviewWrap').style.display = 'block';
    document.getElementById('uploadZone').style.display = 'none';
    settingsApplied = false;
  });
}

function compressImage(file, maxSize = 1024) {
  return new Promise(resolve => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      if (w > h && w > maxSize) { h = (h * maxSize) / w; w = maxSize; }
      else if (h > maxSize)     { w = (w * maxSize) / h; h = maxSize; }
      canvas.width = Math.round(w); canvas.height = Math.round(h);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.95);
    };
    img.onerror = () => resolve(file);
    img.src = url;
  });
}

// ─── VOICE RECORDER (Record → convert → download MP3) ──────────────────────────
const REC_MAX_SEC = 120;
let recMediaRecorder = null;
let recChunks = [];
let recMicStream = null;
let recTimerInterval = null;
let recSeconds = 0;
let recordedDuration = 0;
let recConvertedBlob = null;   // converted WAV from server
let recConvertedMp3 = null;    // encoded MP3 blob

function openRecorder() {
  const modal = document.getElementById('recorderModal');
  const noVoice = document.getElementById('recNoVoice');
  if (!selectedVoice) {
    noVoice.style.display = 'block';
    document.getElementById('recStartBtn').disabled = true;
  } else {
    noVoice.style.display = 'none';
    document.getElementById('recStartBtn').disabled = false;
    document.getElementById('recVoiceName').textContent = selectedVoice.name;
  }
  recReset();
  modal.classList.remove('hidden');
}

function closeRecorder() {
  recStopMic();
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
  document.getElementById('recorderModal').classList.add('hidden');
}

function recStopMic() {
  if (recMediaRecorder && recMediaRecorder.state !== 'inactive') {
    try { recMediaRecorder.stop(); } catch (_) {}
  }
  if (recMicStream) { recMicStream.getTracks().forEach(t => t.stop()); recMicStream = null; }
}

function recReset() {
  recChunks = [];
  recSeconds = 0;
  recordedDuration = 0;
  recConvertedBlob = null;
  recConvertedMp3 = null;
  document.getElementById('recTimer').textContent = '0:00';
  document.getElementById('recStartBtn').style.display = '';
  document.getElementById('recStopBtn').style.display = 'none';
  document.getElementById('recReview').style.display = 'none';
  document.getElementById('recResult').style.display = 'none';
}

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

async function recStart() {
  if (!selectedVoice) { showToast('Select a voice first.', 'error'); return; }
  try {
    recMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true }, video: false
    });
  } catch (_) {
    showToast('Microphone access denied.', 'error'); return;
  }
  recChunks = [];
  recMediaRecorder = new MediaRecorder(recMicStream);
  recMediaRecorder.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
  recMediaRecorder.onstop = onRecStopped;
  recMediaRecorder.start();

  recSeconds = 0;
  document.getElementById('recTimer').textContent = '0:00';
  document.getElementById('recStartBtn').style.display = 'none';
  document.getElementById('recStopBtn').style.display = '';
  document.getElementById('recReview').style.display = 'none';
  document.getElementById('recResult').style.display = 'none';

  recTimerInterval = setInterval(() => {
    recSeconds += 1;
    document.getElementById('recTimer').textContent = fmtTime(recSeconds);
    if (recSeconds >= REC_MAX_SEC) recStop();
  }, 1000);
}

function recStop() {
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
  recStopMic();
  document.getElementById('recStopBtn').style.display = 'none';
}

async function onRecStopped() {
  const blob = new Blob(recChunks, { type: recChunks[0]?.type || 'audio/webm' });
  // Decode to get duration + PCM for clean WAV
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    recordedDuration = buf.duration;
    await ctx.close();
    window._recAudioBuffer = buf;
  } catch (_) {
    recordedDuration = recSeconds;
    window._recAudioBuffer = null;
  }

  document.getElementById('recOriginalAudio').src = URL.createObjectURL(blob);
  const cost = Math.ceil(recordedDuration * 0.3);
  document.getElementById('recCost').textContent = cost;
  document.getElementById('recStartBtn').style.display = '';
  document.getElementById('recReview').style.display = 'block';
}

// Build a 16kHz mono 16-bit WAV blob from an AudioBuffer
function audioBufferToWav(buf, targetSR = 16000) {
  const src = buf.getChannelData(0);
  const ratio = buf.sampleRate / targetSR;
  const outLen = Math.floor(src.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = src[Math.floor(i * ratio)] || 0;
    pcm[i] = Math.max(-32768, Math.min(32767, s * 32767));
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, targetSR, true);
  view.setUint32(28, targetSR * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([view], { type: 'audio/wav' });
}

async function recConvert() {
  if (!rvcServerUrl) { showToast('Voice server not available. Try later.', 'error'); return; }
  if (!window._recAudioBuffer) { showToast('Could not read recording. Record again.', 'error'); return; }

  const cost = Math.ceil(recordedDuration * 0.3);
  if (coinBalance < cost) { showToast(`Need ${cost} coins for this recording. Please top up.`, 'error'); return; }

  const btn = document.getElementById('recConvertBtn');
  btn.disabled = true; btn.textContent = 'Converting…';

  try {
    const wavBlob = audioBufferToWav(window._recAudioBuffer, 16000);
    const fd = new FormData();
    fd.append('voice', selectedVoice.folderName);
    fd.append('pitch', '0');
    fd.append('file', wavBlob, 'recording.wav');

    const res = await fetch(rvcServerUrl.replace(/\/$/, '') + '/convert', {
      method: 'POST',
      headers: { 'ngrok-skip-browser-warning': 'true' },
      body: fd
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Conversion failed');
    }
    recConvertedBlob = await res.blob();

    // Charge coins for the recording length
    await drainCoins(Math.ceil(recordedDuration), 'record');

    // Encode to MP3 for download + preview
    recConvertedMp3 = await wavBlobToMp3(recConvertedBlob);

    document.getElementById('recConvertedAudio').src = URL.createObjectURL(recConvertedMp3 || recConvertedBlob);
    document.getElementById('recReview').style.display = 'none';
    document.getElementById('recResult').style.display = 'block';
  } catch (e) {
    showToast('Conversion error: ' + (e.message || e), 'error');
  }
  btn.disabled = false; btn.textContent = `Convert to Voice (${cost} coins)`;
}

// Convert a WAV blob to an MP3 blob using lamejs (loaded on demand)
async function wavBlobToMp3(wavBlob) {
  try {
    if (typeof lamejs === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
    }
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await wavBlob.arrayBuffer());
    await ctx.close();
    const sr = buf.sampleRate;
    const samples = buf.getChannelData(0);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, samples[i] * 32767));

    const enc = new lamejs.Mp3Encoder(1, sr, 128);
    const block = 1152;
    const out = [];
    for (let i = 0; i < pcm.length; i += block) {
      const chunk = pcm.subarray(i, i + block);
      const mp3buf = enc.encodeBuffer(chunk);
      if (mp3buf.length) out.push(mp3buf);
    }
    const end = enc.flush();
    if (end.length) out.push(end);
    return new Blob(out, { type: 'audio/mp3' });
  } catch (_) {
    return null; // fall back to WAV download
  }
}

function recDownload() {
  const blob = recConvertedMp3 || recConvertedBlob;
  if (!blob) return;
  const ext = recConvertedMp3 ? 'mp3' : 'wav';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vnvpro-${(selectedVoice?.name || 'voice').replace(/\s+/g, '_').toLowerCase()}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── SESSION / AUTH ────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  try {
    await fetch('/api/usercheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'heartbeat', email: currentEmail })
    });
  } catch (_) {}
}

function logout() {
  if (isStreaming) stopStream();
  localStorage.removeItem('vnv_session');
  window.location.href = 'login.html';
}

// ─── BALANCE ───────────────────────────────────────────────────────────────────
async function loadBalance() {
  try {
    const res = await fetch('/api/coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'balance', email: currentEmail })
    });
    const data = await res.json();
    updateCoinDisplay(data.balance ?? 0);
  } catch (_) {}
}

function updateCoinDisplay(balance) {
  coinBalance = balance;
  document.getElementById('coinBalance').textContent = Math.floor(balance).toLocaleString();
}

// ─── API KEY ───────────────────────────────────────────────────────────────────
async function fetchApiKey(email) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch('/api/get-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (data.key) {
        decartApiKey = data.key;
        return true;
      }
    } catch (_) {}
    if (attempt < 5) await delay(attempt * 1500);
  }
  return false;
}

// ─── RVC URL ───────────────────────────────────────────────────────────────────
async function loadRvcUrl() {
  try {
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_rvc_url' })
    });
    const data = await res.json();
    rvcServerUrl = data.url || null;
  } catch (_) {}
}

// ─── VOICES ────────────────────────────────────────────────────────────────────
async function loadVoices() {
  try {
    const res = await fetch('/api/voices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', email: currentEmail })
    });
    const data = await res.json();
    voices = data.voices || [];
    renderVoices();
  } catch (_) {
    renderVoices();
  }
}

function renderVoices() {
  const list = document.getElementById('voicesList');

  if (voices.length === 0) {
    list.innerHTML = `
      <div class="voice-empty">
        <div style="font-size:28px;margin-bottom:8px;">🎙</div>
        <div>No voices available yet.</div>
        <div style="margin-top:8px;font-size:11px;">Request a custom voice below.</div>
      </div>`;
    return;
  }

  list.innerHTML = voices.map(v => {
    const isLocked = !v.isPublic && !v.unlocked;
    const isSelected = selectedVoice && selectedVoice.id === v.id;
    return `
      <div class="voice-card ${isSelected ? 'selected' : ''}" id="vc-${v.id}" onclick="selectVoice('${v.id}')">
        <div class="voice-card-top">
          <div>
            <div class="voice-name">${escHtml(v.name)} ${isLocked ? '🔒' : ''}</div>
            <div class="voice-desc">${escHtml(v.description || '')}</div>
          </div>
        </div>
        <div class="voice-actions">
          ${(v.previewUrl || v.previewBase64) ? `<button class="preview-btn" onclick="playPreview(event, '${v.id}')">▶ Preview</button>` : ''}
          ${isLocked ? `<button class="preview-btn" onclick="openRequestVoice(event)">Request</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function selectVoice(id) {
  const v = voices.find(x => x.id === id);
  if (!v) return;
  const isLocked = !v.isPublic && !v.unlocked;
  if (isLocked) {
    showToast('This is a premium voice. Request it to unlock.', 'info');
    return;
  }
  selectedVoice = v;
  renderVoices(); // re-render to update selection
  showToast(`Voice selected: ${v.name}`, 'success');
}

function playPreview(e, id) {
  e.stopPropagation();
  const v = voices.find(x => x.id === id);
  if (!v) return;

  let url = v.previewUrl || '';
  if (!url && v.previewBase64) {
    url = 'data:audio/mpeg;base64,' + v.previewBase64;
  }
  if (!url) {
    showToast('No preview available.', 'info');
    return;
  }
  const audio = new Audio(url);
  audio.play().catch(() => showToast('Could not play preview.', 'error'));
}

// ─── MODE ──────────────────────────────────────────────────────────────────────
function setMode(m) {
  if (isStreaming) {
    showToast('Stop streaming before changing mode.', 'error');
    return;
  }
  mode = m;

  // Update buttons
  document.getElementById('modeVideoBtn').classList.toggle('active', m === 'video');
  document.getElementById('modeBothBtn').classList.toggle('active', m === 'both');
  document.getElementById('modeAudioBtn').classList.toggle('active', m === 'audio');

  // Update badge
  const badge = document.getElementById('modeBadge');
  if (m === 'video') badge.textContent = 'Video Only';
  else if (m === 'audio') badge.textContent = 'Voice Only';
  else badge.textContent = 'Video + Voice';

  // Show/hide stream areas
  const videoArea = document.getElementById('videoStreamArea');
  const audioDisplay = document.getElementById('audioDisplay');
  const delayControl = document.getElementById('delayControl');
  const promptControl = document.getElementById('promptControl');
  const enhanceControl = document.getElementById('enhanceControl');
  const applyControl = document.getElementById('applyControl');
  const presetControl = document.getElementById('presetControl');
  const referenceControl = document.getElementById('referenceControl');
  const voicePanel = document.getElementById('voicePanel');
  const appColumns = document.querySelector('.app-columns');

  const videoControls = (show) => {
    const v = show ? '' : 'none';
    promptControl.style.display = v;
    enhanceControl.style.display = v;
    applyControl.style.display = v;
    presetControl.style.display = v;
    referenceControl.style.display = v;
  };

  if (m === 'audio') {
    videoArea.style.display = 'none';
    audioDisplay.style.display = 'block';
    delayControl.style.display = 'none';   // no video to sync against in audio-only mode
    videoControls(false);
    voicePanel.style.display = '';
    appColumns.classList.remove('single-col');
  } else if (m === 'both') {
    videoArea.style.display = '';
    audioDisplay.style.display = 'none';
    delayControl.style.display = 'block';  // sync slider only meaningful when both are active
    videoControls(true);
    voicePanel.style.display = '';
    appColumns.classList.remove('single-col');
  } else {
    videoArea.style.display = '';
    audioDisplay.style.display = 'none';
    delayControl.style.display = 'none';
    videoControls(true);
    voicePanel.style.display = 'none';
    appColumns.classList.add('single-col');
  }
}

// ─── STREAM CONTROL ────────────────────────────────────────────────────────────
async function startStream() {
  if (isStreaming) return;

  // Validate
  if (coinBalance <= 0) {
    showToast('You have no coins. Please buy coins to continue.', 'error');
    openBuyCoins();
    return;
  }

  if ((mode === 'audio' || mode === 'both') && !selectedVoice) {
    showToast('Please select a voice first.', 'error');
    return;
  }

  if ((mode === 'audio' || mode === 'both') && engine === 'v1' && !rvcServerUrl) {
    showToast('RVC server URL not configured. Contact support.', 'error');
    return;
  }

  // Voice-engine gating (only for voice modes)
  if (mode === 'audio' || mode === 'both') {
    if (engine === 'v1') {
      const allowed = await checkV1Cap();
      if (!allowed) {
        showToast('High demand right now — please wait a moment and try again, or switch to Voice 2.0.', 'error', 5000);
        return;
      }
    }
    // Voice 2.0 runs on the user's own device via w-okada — no server slot needed
  }

  setStatus('Connecting...', false);
  document.getElementById('startBtn').disabled = true;

  try {
    if (mode === 'video' || mode === 'both') {
      await startVideoStream();
    }
    if (mode === 'audio' || mode === 'both') {
      await startAudioPipeline(selectedVoice);
      if (mode === 'audio') {
        startAudioBilling();
      }
    }

    isStreaming = true;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('modeSelector').style.opacity = '0.5';
    document.getElementById('modeSelector').style.pointerEvents = 'none';
    setStatus('LIVE', true);
    lastBilledSeconds = 0;
    audioBillingSeconds = 0;

    // Keep the Voice 2.0 slot held, or count this as an active Voice 1.0 stream
    if (mode === 'audio' || mode === 'both') startEngineHeartbeat();
  } catch (err) {
    setStatus('IDLE', false);
    document.getElementById('startBtn').disabled = false;
    // release any slot we grabbed before the failure
    if (mode === 'audio' || mode === 'both') {
      voice2Api('v2_release').catch(() => {});
      voice2Api('v1_stop').catch(() => {});
    }
    showToast('Failed to start: ' + (err.message || err), 'error');
  }
}

function stopStream() {
  isStreaming = false;

  // Stop video delay buffering
  stopVideoDelay();

  // Release the voice engine slot / stop the active-stream count
  stopEngineHeartbeat();

  // Stop audio billing
  if (audioBillingInterval) {
    clearInterval(audioBillingInterval);
    audioBillingInterval = null;
  }

  // Stop audio pipeline
  if (processor) {
    try { processor.disconnect(); } catch (_) {}
    processor = null;
  }
  if (analyser) {
    try { analyser.disconnect(); } catch (_) {}
    analyser = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  if (playbackCtx) {
    try { playbackCtx.close(); } catch (_) {}
    playbackCtx = null;
  }
  nextPlayTime = 0;
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (rvcWs) {
    try { rvcWs.close(); } catch (_) {}
    rvcWs = null;
  }

  // Stop mic level
  if (micLevelInterval) {
    clearInterval(micLevelInterval);
    micLevelInterval = null;
  }
  document.getElementById('micLevel').style.height = '0%';
  document.getElementById('spkLevel').style.height = '0%';

  // Stop video
  stopVideoStream();

  // Reset UI
  document.getElementById('startBtn').disabled = false;
  document.getElementById('stopBtn').disabled = true;
  document.getElementById('modeSelector').style.opacity = '';
  document.getElementById('modeSelector').style.pointerEvents = '';
  document.getElementById('billingCounter').style.display = 'none';
  document.getElementById('billingSecs').textContent = '0';
  document.getElementById('voiceStatusText') && (document.getElementById('voiceStatusText').textContent = 'Select a voice and press Start');

  setStatus('IDLE', false);
  lastBilledSeconds = 0;
}

function setStatus(text, live) {
  document.getElementById('statusText').textContent = text;
  const dot = document.getElementById('statusDot');
  if (live) {
    dot.classList.add('streaming');
  } else {
    dot.classList.remove('streaming');
  }
}

// ─── VIDEO SYNC DELAY ─────────────────────────────────────────────────────────
// Buffers Decart output frames as ImageBitmaps and renders the frame from
// videoDelayMs ago, so slow audio (RVC) lines up with the mouth on screen.

function setVideoDelay(ms) {
  videoDelayMs = ms;
  const label = document.getElementById('delayLabel');
  if (label) label.textContent = `Video Delay: ${ms}ms`;
  if (!isStreaming) return;
  const outputVideo = document.getElementById('outputVideo');
  if (!outputVideo.srcObject) return;   // video not started yet
  if (ms > 0) {
    outputVideo.style.display = 'none';
    startVideoDelay();
  } else {
    stopVideoDelay();
    outputVideo.style.display = 'block';
  }
}

function startVideoDelay() {
  stopVideoDelay();   // clear any previous run
  const outputVideo = document.getElementById('outputVideo');
  const outputCanvas = document.getElementById('outputCanvas');
  const ctx = outputCanvas.getContext('2d');

  // Size canvas to match the video's intrinsic resolution (or a safe default)
  function syncSize() {
    if (outputVideo.videoWidth > 0) {
      outputCanvas.width  = outputVideo.videoWidth;
      outputCanvas.height = outputVideo.videoHeight;
    } else {
      outputCanvas.width  = 1280;
      outputCanvas.height = 720;
    }
  }
  syncSize();
  outputVideo.addEventListener('loadedmetadata', syncSize, { once: true });
  outputCanvas.style.display = 'block';

  // Capture a frame every ~33ms (≈30fps)
  captureIntervalId = setInterval(async () => {
    if (!isStreaming || outputVideo.readyState < 2) return;
    try {
      const bmp = await createImageBitmap(outputVideo);
      frameBuffer.push({ time: performance.now(), bmp });
      // Evict frames older than delay + 400ms headroom, freeing GPU memory
      const cutoff = performance.now() - videoDelayMs - 400;
      while (frameBuffer.length > 1 && frameBuffer[0].time < cutoff) {
        frameBuffer[0].bmp.close();
        frameBuffer.shift();
      }
    } catch (_) {}
  }, 33);

  // Render loop — draws the frame closest to videoDelayMs in the past
  function render() {
    if (!isStreaming) return;
    const target = performance.now() - videoDelayMs;
    let best = null;
    for (const f of frameBuffer) {
      if (f.time <= target) best = f;
      else break;
    }
    if (best) ctx.drawImage(best.bmp, 0, 0, outputCanvas.width, outputCanvas.height);
    delayRafId = requestAnimationFrame(render);
  }
  delayRafId = requestAnimationFrame(render);
}

function stopVideoDelay() {
  if (captureIntervalId) { clearInterval(captureIntervalId); captureIntervalId = null; }
  if (delayRafId)        { cancelAnimationFrame(delayRafId);  delayRafId = null; }
  frameBuffer.forEach(f => { try { f.bmp.close(); } catch (_) {} });
  frameBuffer = [];
  const outputCanvas = document.getElementById('outputCanvas');
  if (outputCanvas) outputCanvas.style.display = 'none';
}

// ─── VIDEO STREAM ──────────────────────────────────────────────────────────────
async function startVideoStream() {
  // Ensure API key is loaded
  if (!decartApiKey) {
    const ok = await keyLoadPromise;
    if (!ok) {
      keyLoadPromise = fetchApiKey(currentEmail);
      const ok2 = await keyLoadPromise;
      if (!ok2) throw new Error('Could not load API key. Please try again.');
    }
  }

  settingsApplied = false;

  // Camera
  const camStream = await navigator.mediaDevices.getUserMedia({
    video: { frameRate: { ideal: 30, min: 24 }, width: { ideal: 1920, min: 1280 }, height: { ideal: 1080, min: 720 }, facingMode: 'user' },
    audio: false,
  }).catch(err => {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') throw new Error('Camera access denied. Please allow camera permissions.');
    if (err.name === 'NotFoundError') throw new Error('No camera found. Please connect a webcam.');
    throw err;
  });

  const inputVideo = document.getElementById('inputVideo');
  inputVideo.srcObject = camStream;
  inputVideo.style.display = 'block';
  document.getElementById('inputPlaceholder').style.display = 'none';

  const outputVideo = document.getElementById('outputVideo');

  // Load the proven Decart SDK (same as the original working project)
  const { createDecartClient, models } = await import('https://esm.sh/@decartai/sdk');
  const model = models.realtime('lucy-2.1');
  const client = createDecartClient({ apiKey: decartApiKey });

  realtimeClient = await client.realtime.connect(camStream, {
    model,
    onRemoteStream: (transformedStream) => {
      outputVideo.srcObject = transformedStream;
      document.getElementById('outputPlaceholder').style.display = 'none';
      window.aiOutputStream = transformedStream;
      // Start video delay buffering if slider is non-zero; otherwise show live
      if (videoDelayMs > 0) {
        outputVideo.style.display = 'none';
        startVideoDelay();
      } else {
        outputVideo.style.display = 'block';
      }
    },
  });

  realtimeClient.on('connectionChange', (state) => {
    const s = (state || '').toLowerCase();
    if (s === 'disconnected' && isStreaming) { showToast('Video stream disconnected.', 'error'); stopStream(); }
  });

  realtimeClient.on('generationTick', async ({ seconds }) => {
    if (!isStreaming) return;
    document.getElementById('billingSecs').textContent = seconds;
    document.getElementById('billingCounter').style.display = 'block';
    const elapsed = Math.max(1, seconds - lastBilledSeconds);
    lastBilledSeconds = seconds;
    await drainCoins(elapsed, billMode());
  });

  realtimeClient.on('error', (err) => {
    const msg = err?.message || 'Unknown error';
    if (!msg.toLowerCase().includes('image send timed out')) showToast('Video stream error: ' + msg, 'error');
  });

  // Apply initial prompt / enhance / reference image
  await new Promise(r => setTimeout(r, 1000));
  await applyVideoSettings(true);
}

function stopVideoStream() {
  if (realtimeClient) {
    try { realtimeClient.disconnect?.(); } catch (_) {}
    try { realtimeClient.close?.(); } catch (_) {}
    realtimeClient = null;
  }
  const inputVideo = document.getElementById('inputVideo');
  if (inputVideo.srcObject) {
    inputVideo.srcObject.getTracks().forEach(t => t.stop());
    inputVideo.srcObject = null;
  }
  inputVideo.style.display = 'none';
  document.getElementById('inputPlaceholder').style.display = 'flex';
  const outputVideo = document.getElementById('outputVideo');
  if (outputVideo) { outputVideo.srcObject = null; outputVideo.style.display = 'none'; }
  document.getElementById('outputCanvas').style.display = 'none';
  document.getElementById('outputPlaceholder').style.display = 'flex';
  window.aiOutputStream = null;
  settingsApplied = false;
}

async function applyVideoSettings(initial) {
  if (!realtimeClient) {
    if (!initial) showToast('Start streaming first.', 'info');
    return;
  }
  const prompt = document.getElementById('promptInput').value.trim();
  const enhance = document.getElementById('enhanceToggle').checked;
  const payload = { enhance };
  if (prompt) payload.prompt = prompt;
  if (referenceFile && !settingsApplied) {
    payload.image = referenceFile;
    if (!prompt) payload.prompt = 'Transform my face and body to look exactly like the person in the reference image. Follow my exact movements, pose and hand positions precisely — do not add, invent or change any body or hand movements. Keep all objects, phones, cups and items I hold completely unchanged and clearly visible. Only transform my face, skin, hair and body to match the reference person. Do not blur or remove any objects in the scene.';
  }
  try {
    await realtimeClient.set(payload);
    settingsApplied = true;
    if (!initial) showToast('Settings applied.', 'success');
  } catch (err) {
    if (!initial) showToast('Could not apply settings: ' + (err.message || err), 'error');
  }
}

// ─── AUDIO PIPELINE ────────────────────────────────────────────────────────────

// Voice 2.0 — w-okada runs on the user's own GPU via virtual audio cable.
// The browser just monitors mic level for the meter; no server WebSocket needed.
async function startV2AudioMonitor() {
  audioCtx = new AudioContext({ sampleRate: 16000 });
  playbackCtx = null;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
    video: false
  });
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const statusEl = document.getElementById('voiceStatusText');
  if (statusEl) statusEl.textContent = 'Voice 2.0 Active — w-okada running on your device';

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  micLevelInterval = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    document.getElementById('micLevel').style.height = Math.min(100, Math.sqrt(sum / dataArray.length) * 400) + '%';
  }, 50);
}

async function startAudioPipeline(voice) {
  // Voice 2.0 — no server needed; w-okada handles conversion on user's device
  if (engine === 'v2') {
    await startV2AudioMonitor();
    return;
  }

  // Voice 1.0 — connect to RVC server WebSocket
  const wsUrl = rvcServerUrl.replace(/^http/, 'ws') + '/ws/' + voice.folderName;
  rvcWs = new WebSocket(wsUrl);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('RVC server connection timeout')), 8000);
    rvcWs.onopen = () => { clearTimeout(timeout); resolve(); };
    rvcWs.onerror = () => { clearTimeout(timeout); reject(new Error('Cannot connect to RVC server')); };
  });

  document.getElementById('voiceStatusText') && (document.getElementById('voiceStatusText').textContent = `Voice active: ${voice.name}`);

  // Set up Web Audio — capture at 16k (what the server expects),
  // play back through a separate 48k context (what the server returns)
  audioCtx = new AudioContext({ sampleRate: 16000 });
  playbackCtx = new AudioContext({ sampleRate: RVC_OUTPUT_SR });
  nextPlayTime = 0;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true },
    video: false
  });

  const source = audioCtx.createMediaStreamSource(micStream);

  // Analyser for level meter
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  // AudioWorklet runs on a dedicated real-time thread — no dropped audio frames
  await audioCtx.audioWorklet.addModule('audio-processor.js');
  processor = new AudioWorkletNode(audioCtx, 'audio-capture');
  processor.port.onmessage = (e) => {
    if (!rvcWs || rvcWs.readyState !== WebSocket.OPEN) return;
    const float32 = e.data;
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32767));
    }
    rvcWs.send(int16.buffer);
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);

  // RVC output
  let outputLevel = 0;
  rvcWs.onmessage = async (e) => {
    if (!isStreaming) return;
    try {
      const data = e.data;
      const arrayBuffer = data instanceof Blob ? await data.arrayBuffer() : data;
      const int16 = new Int16Array(arrayBuffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32767;
      }

      // Compute output level
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      outputLevel = Math.min(100, Math.sqrt(sum / float32.length) * 300);

      if (!playbackCtx || !isStreaming) return;
      const buffer = playbackCtx.createBuffer(1, float32.length, RVC_OUTPUT_SR);
      buffer.getChannelData(0).set(float32);
      const src = playbackCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(playbackCtx.destination);

      // Gapless scheduling — schedule each chunk strictly AFTER the previous one.
      // Only ever resync FORWARD (on an underrun/gap); never move a start time
      // backwards, which would overlap already-queued audio and echo/repeat words.
      const now = playbackCtx.currentTime;
      const minStart = now + 0.02;
      const startAt = nextPlayTime > minStart ? nextPlayTime : minStart;
      src.start(startAt);
      nextPlayTime = startAt + buffer.duration;
    } catch (_) {}
  };

  rvcWs.onclose = () => {
    if (isStreaming) {
      showToast('RVC server disconnected.', 'error');
      stopStream();
    }
  };

  // Level meters
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  micLevelInterval = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = (dataArray[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const pct = Math.min(100, rms * 400);
    document.getElementById('micLevel').style.height = pct + '%';
    document.getElementById('spkLevel').style.height = outputLevel + '%';
    outputLevel *= 0.85; // decay
  }, 50);
}

// ─── AUDIO BILLING ─────────────────────────────────────────────────────────────
function startAudioBilling() {
  audioBillingInterval = setInterval(async () => {
    if (!isStreaming) return;
    audioBillingSeconds += 30;
    document.getElementById('billingSecs').textContent = audioBillingSeconds;
    document.getElementById('billingCounter').style.display = 'block';
    await drainCoins(30, billMode());
  }, 30000);
}

// ─── DRAIN COINS ───────────────────────────────────────────────────────────────
// Billing mode reflects both the stream mode and the chosen engine (v2 costs more)
function billMode() {
  if (mode === 'video') return 'video';
  if (mode === 'both')  return engine === 'v2' ? 'both2' : 'both';
  return engine === 'v2' ? 'audio2' : 'audio';   // audio-only
}

async function drainCoins(seconds, modeOverride) {
  const m = modeOverride || mode;
  try {
    const res = await fetch('/api/coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'drain', email: currentEmail, mode: m, seconds })
    });
    if (res.status === 402) {
      showToast('You\'ve run out of coins. Please top up.', 'error');
      stopStream();
    } else if (res.ok) {
      const data = await res.json();
      updateCoinDisplay(data.balance);
    }
  } catch (_) {}
}

// ─── VOICE ENGINE (1.0 vs 2.0, slot + waitlist) ────────────────────────────────
function setEngine(e) {
  if (isStreaming) { showToast('Stop streaming before switching engines.', 'error'); return; }
  engine = e;
  const v1 = document.getElementById('engineV1Btn');
  const v2 = document.getElementById('engineV2Btn');
  const hintText = document.getElementById('engineHintText');
  const guideBtn = document.getElementById('v2GuideBtn');
  v1.classList.toggle('btn-primary', e === 'v1');
  v1.classList.toggle('btn-secondary', e !== 'v1');
  v2.classList.toggle('btn-primary', e === 'v2');
  v2.classList.toggle('btn-secondary', e !== 'v2');
  if (hintText) hintText.textContent = e === 'v2'
    ? 'Premium — ultra-low latency, runs on YOUR device GPU via w-okada. One-time setup required.'
    : 'Standard — powered by our server. Always available.';
  if (guideBtn) guideBtn.style.display = e === 'v2' ? '' : 'none';
}

function openV2Guide() {
  document.getElementById('v2GuideModal').classList.remove('hidden');
}
function closeV2Guide() {
  document.getElementById('v2GuideModal').classList.add('hidden');
}

async function voice2Api(action) {
  const res = await fetch('/api/voice2', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, email: currentEmail })
  });
  return res.json();
}

// Returns true if the Voice 2.0 slot is ours (start now); false if queued (waitlist shown)
async function acquireVoice2() {
  try {
    const r = await voice2Api('v2_acquire');
    if (r.ok && r.state === 'active') return true;
    showWaitlist(r);
    return false;
  } catch (_) {
    showToast('Could not reach the premium queue. Try Voice 1.0.', 'error');
    return false;
  }
}

async function checkV1Cap() {
  try {
    const r = await voice2Api('v1_can_start');
    return !!r.allowed;
  } catch (_) {
    return true; // don't block on a transient error
  }
}

function startEngineHeartbeat() {
  stopEngineHeartbeat();
  if (engine === 'v1') {
    voice2Api('v1_heartbeat').catch(() => {});
    v1HeartbeatInterval = setInterval(() => { voice2Api('v1_heartbeat').catch(() => {}); }, 10000);
  }
  // Voice 2.0 runs on user's device — no server heartbeat needed
}

function stopEngineHeartbeat() {
  if (v2HeartbeatInterval) { clearInterval(v2HeartbeatInterval); v2HeartbeatInterval = null; voice2Api('v2_release').catch(() => {}); }
  if (v1HeartbeatInterval) { clearInterval(v1HeartbeatInterval); v1HeartbeatInterval = null; voice2Api('v1_stop').catch(() => {}); }
}

// (Voice 2.0 waitlist removed — w-okada runs on user's own device, no shared slot needed)

// ─── BUY COINS ─────────────────────────────────────────────────────────────────
async function loadPackagesAndWallets() {
  try {
    const [pkgRes, walletRes, bankRes] = await Promise.all([
      fetch('/api/coins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_packages' }) }),
      fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_wallets' }) }),
      fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_bank_public' }) })
    ]);

    const pkgData = await pkgRes.json();
    packages = pkgData.packages || [];

    const walletData = await walletRes.json();
    wallets = walletData.wallets || {};

    const bankData = await bankRes.json();
    bankInfo = bankData.bank || {};

    // Set wallet addresses
    document.getElementById('buyAddrTrc20').value = wallets.trc20 || 'Address not set';
    document.getElementById('buyAddrErc20').value = wallets.erc20 || 'Address not set';
    document.getElementById('buyAddrBtc').value = wallets.btc || 'Address not set';

    // Bank info
    const bd = document.getElementById('bankInfoDisplay');
    if (bankInfo.bankName) {
      bd.innerHTML = `
        <div style="background:var(--bg);border-radius:8px;padding:12px;font-size:13px;">
          <div style="margin-bottom:4px;"><span style="color:var(--text2)">Bank:</span> <strong>${escHtml(bankInfo.bankName)}</strong></div>
          <div style="margin-bottom:4px;"><span style="color:var(--text2)">Name:</span> <strong>${escHtml(bankInfo.accountName || '')}</strong></div>
          <div><span style="color:var(--text2)">Account:</span> <strong>${escHtml(bankInfo.accountNumber || '')}</strong></div>
          ${bankInfo.sortCode ? `<div style="margin-top:4px;"><span style="color:var(--text2)">Sort Code:</span> <strong>${escHtml(bankInfo.sortCode)}</strong></div>` : ''}
          ${bankInfo.note ? `<div style="margin-top:4px; color:var(--accent2);">${escHtml(bankInfo.note)}</div>` : ''}
        </div>`;
    } else {
      bd.textContent = 'Bank details not available. Please use crypto.';
    }
  } catch (_) {}
}

function openBuyCoins() {
  renderPackages();
  document.getElementById('buyCoinsModal').classList.remove('hidden');
}

function closeBuyCoins() {
  document.getElementById('buyCoinsModal').classList.add('hidden');
}

function renderPackages() {
  const grid = document.getElementById('pkgGrid');
  if (packages.length === 0) {
    grid.innerHTML = '<p style="color:var(--text2);font-size:13px;grid-column:1/-1;">No packages available.</p>';
    return;
  }
  grid.innerHTML = packages.map(p => `
    <div class="coin-pkg ${selectedPkgId === p.id ? 'selected' : ''}" onclick="selectPkg('${p.id}')">
      ${p.featured ? '<div class="featured-tag">POPULAR</div>' : ''}
      <div class="pkg-coins">${p.coins.toLocaleString()}</div>
      <div class="pkg-label">${escHtml(p.label)}</div>
      <div class="pkg-price">₦${p.priceNaira.toLocaleString()} / $${p.priceUsd}</div>
    </div>`).join('');
}

function selectPkg(id) {
  selectedPkgId = id;
  const pkg = packages.find(p => p.id === id);
  if (pkg) {
    document.getElementById('selectedPkgLabel').textContent = pkg.label + ' (' + pkg.coins.toLocaleString() + ' coins)';
    document.getElementById('selectedPkgPrice').textContent = '₦' + pkg.priceNaira.toLocaleString() + ' / $' + pkg.priceUsd;
  }
  renderPackages();
}

function switchNetworkTab(tab, btn) {
  document.querySelectorAll('.network-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.network-pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('n' + tab).classList.add('active');
}

function copyField(id) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.value).then(() => {
    showToast('Copied!', 'success');
  }).catch(() => {
    el.select();
    document.execCommand('copy');
    showToast('Copied!', 'success');
  });
}

async function submitTopup(network) {
  if (!selectedPkgId) {
    showToast('Please select a package first.', 'error');
    return;
  }
  const hashEl = document.getElementById('buyHash' + network.charAt(0).toUpperCase() + network.slice(1));
  const hash = hashEl ? hashEl.value.trim() : '';
  if (!hash) {
    showToast('Please paste your transaction hash.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'topup', email: currentEmail, packageId: selectedPkgId, txHash: hash, network })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      showToast('Payment submitted! We\'ll verify and credit your coins shortly.', 'success');
      closeBuyCoins();
      if (hashEl) hashEl.value = '';
    } else {
      showToast(data.error || 'Submission failed.', 'error');
    }
  } catch (_) {
    showToast('Network error. Please try again.', 'error');
  }
}

async function submitBankTopup() {
  if (!selectedPkgId) {
    showToast('Please select a package first.', 'error');
    return;
  }
  const name = document.getElementById('buyBankName').value.trim();
  const ref = document.getElementById('buyBankRef').value.trim();
  if (!name || !ref) {
    showToast('Please fill in your name and transfer reference.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/coins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bank_request', email: currentEmail, packageId: selectedPkgId, senderName: name, transferRef: ref })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      showToast('Bank transfer submitted! We\'ll verify and credit your coins.', 'success');
      closeBuyCoins();
      document.getElementById('buyBankName').value = '';
      document.getElementById('buyBankRef').value = '';
    } else {
      showToast(data.error || 'Submission failed.', 'error');
    }
  } catch (_) {
    showToast('Network error. Please try again.', 'error');
  }
}

// ─── VOICE REQUEST ─────────────────────────────────────────────────────────────
let voicePrice = { price: 0, priceNaira: 0 };

async function openRequestVoice(e) {
  if (e) e.stopPropagation();
  // Reset to the form view
  document.getElementById('reqFormSection').style.display = '';
  document.getElementById('reqPaySection').style.display = 'none';
  document.getElementById('reqPriceText').textContent = '…';
  document.getElementById('voiceRequestModal').classList.remove('hidden');

  // Fetch and show the fixed price
  try {
    const res = await fetch('/api/voices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_voice_price' })
    });
    voicePrice = await res.json();
    document.getElementById('reqPriceText').textContent =
      `$${voicePrice.price} / ₦${Number(voicePrice.priceNaira).toLocaleString()}`;
  } catch (_) {
    document.getElementById('reqPriceText').textContent = 'unavailable';
  }
}

function closeRequestVoice() {
  document.getElementById('voiceRequestModal').classList.add('hidden');
}

async function submitVoiceRequest() {
  const voiceName = document.getElementById('reqVoiceName').value.trim();
  const description = document.getElementById('reqDescription').value.trim();
  const notes = document.getElementById('reqNotes').value.trim();

  if (!voiceName || !description) {
    showToast('Please fill in the voice name and description.', 'error');
    return;
  }

  const btn = document.getElementById('reqSubmitBtn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/voices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request_voice', email: currentEmail, voiceName, description, notes })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const usd = data.price ?? voicePrice.price;
      const ngn = data.priceNaira ?? voicePrice.priceNaira;
      document.getElementById('reqPayAmount').textContent = `$${usd} / ₦${Number(ngn).toLocaleString()}`;

      // Build payment instructions from the configured wallets + bank details
      let html = '';
      if (bankInfo && bankInfo.bankName) {
        html += `<div style="margin-bottom:10px;"><strong style="color:var(--text);">Bank Transfer</strong><br>
          Bank: <strong>${escHtml(bankInfo.bankName)}</strong><br>
          Name: <strong>${escHtml(bankInfo.accountName || '')}</strong><br>
          Account: <strong>${escHtml(bankInfo.accountNumber || '')}</strong></div>`;
      }
      const w = wallets || {};
      if (w.trc20) html += `<div style="margin-bottom:6px;word-break:break-all;"><strong style="color:var(--text);">USDT (TRC20):</strong><br>${escHtml(w.trc20)}</div>`;
      if (w.erc20) html += `<div style="margin-bottom:6px;word-break:break-all;"><strong style="color:var(--text);">USDT (ERC20):</strong><br>${escHtml(w.erc20)}</div>`;
      if (w.btc)   html += `<div style="margin-bottom:6px;word-break:break-all;"><strong style="color:var(--text);">Bitcoin:</strong><br>${escHtml(w.btc)}</div>`;
      if (!html) html = 'Payment details not configured. Please contact support on WhatsApp.';
      document.getElementById('reqPayDetails').innerHTML = html;

      // Switch to payment view
      document.getElementById('reqFormSection').style.display = 'none';
      document.getElementById('reqPaySection').style.display = 'block';
      document.getElementById('reqVoiceName').value = '';
      document.getElementById('reqDescription').value = '';
      document.getElementById('reqNotes').value = '';
    } else {
      showToast(data.error || 'Failed to submit request.', 'error');
    }
  } catch (_) {
    showToast('Network error. Please try again.', 'error');
  }
  btn.disabled = false; btn.textContent = 'Submit & Pay';
}

// ─── UTILS ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  el.textContent = msg;
  toast.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Close modals on overlay click
document.getElementById('buyCoinsModal').addEventListener('click', function(e) {
  if (e.target === this) closeBuyCoins();
});
document.getElementById('voiceRequestModal').addEventListener('click', function(e) {
  if (e.target === this) closeRequestVoice();
});
