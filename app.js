// VNV Pro — app.js

// ─── STATE ────────────────────────────────────────────────────────────────────
let mode = 'video';
let engine = 'v1';                 // 'v1' (Standard) | 'v2' (Premium)
let v2Pitch = 0;                   // Voice 2.0 pitch shift (semitones), user-adjustable slider
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
let enginesOnline = { v1: true, v2: true };   // updated by health polling; greys engines when servers are off
let engineHealthInterval = null;
let audioCtx = null;
let playbackCtx = null;
let nextPlayTime = 0;
let micStream = null;
let processor = null;
const RVC_OUTPUT_SR = 48000;
const PREROLL_SEC = 0.5;   // jitter-buffer cushion before playback — absorbs network/inference jitter so audio doesn't starve & crack (measured: underruns 29 -> 3)
const MAX_V2_LEAD = 3.0;   // hard cap on Voice 2.0 playback delay — if the buffered lead drifts past this (bursts / voice-switch reloads), drop the backlog and resync so latency can't grow to 10-12s
let lastBilledSeconds = 0;
let decartApiKey = null;
let keyLoadPromise = null;
let currentEmail = null;
let coinBalance = 0;
let realtimeClient = null;
let referenceFile = null;
let backgroundFile = null;       // optional uploaded background (composited behind the avatar)
let bgRemovalMod = null;         // lazy-loaded @imgly/background-removal module
let setupAllowed = false;        // admin permits Setup Mode for this user (from balance)
let setupActive = false;         // user has Setup Mode toggled on (free, no Decart, no coins)
let setupCanvasStream = null;    // image-as-video stream fed into the SAME output surface as Decart
let setupDrawInterval = null;
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

  // Refresh balance + Setup-Mode availability periodically so an admin revoke
  // takes effect within ~30s without the user needing to reload.
  setInterval(() => loadBalance(), 30000);

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

  // Set up Voice 2.0 pitch sliders — left panel (video+voice) and centered (voice-only).
  // Both drive the same v2Pitch and stay in sync.
  wirePitchSlider('pitchSlider');
  wirePitchSlider('audioPitchSlider');

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

  // Optional background image (composited behind the avatar)
  const bgUpload = document.getElementById('bgUpload');
  if (bgUpload) {
    bgUpload.addEventListener('change', () => { if (bgUpload.files[0]) handleBgFile(bgUpload.files[0]); });
  }
  const removeBg = document.getElementById('removeBg');
  if (removeBg) {
    removeBg.addEventListener('click', () => {
      backgroundFile = null;
      document.getElementById('bgPreview').src = '';
      document.getElementById('bgPreviewWrap').style.display = 'none';
      document.getElementById('bgUploadZone').style.display = 'block';
      if (bgUpload) bgUpload.value = '';
      settingsApplied = false;
    });
  }
}

function handleBgFile(file) {
  if (!file.type.startsWith('image/')) { showToast('Please upload an image file.', 'error'); return; }
  if (file.size > 10 * 1024 * 1024)   { showToast('Image too large. Max 10MB.', 'error'); return; }
  compressImage(file, 1280).then(compressed => {
    backgroundFile = compressed;
    document.getElementById('bgPreview').src = URL.createObjectURL(compressed);
    document.getElementById('bgPreviewWrap').style.display = 'block';
    document.getElementById('bgUploadZone').style.display = 'none';
    settingsApplied = false;
  });
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

// Upload an existing audio file (instead of recording) and run it through the
// same convert → MP3 path as a live recording.
async function recUploadFile(file) {
  if (!file) return;
  if (!selectedVoice) { showToast('Select a voice first (close this and pick one).', 'error'); return; }
  const okType = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(file.name);
  if (!okType) { showToast('Please choose an audio file (MP3, WAV, M4A…).', 'error'); return; }
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    await ctx.close();
    if (buf.duration > REC_MAX_SEC) { showToast(`Max ${REC_MAX_SEC}s — please trim the file and try again.`, 'error'); return; }
    window._recAudioBuffer = buf;
    recordedDuration = buf.duration;
  } catch (_) {
    showToast('Could not read that audio file. Try MP3 or WAV.', 'error');
    return;
  }
  document.getElementById('recOriginalAudio').src = URL.createObjectURL(file);
  document.getElementById('recCost').textContent = Math.ceil(recordedDuration * 0.3);
  document.getElementById('recTimer').textContent = fmtTime(recordedDuration);
  document.getElementById('recResult').style.display = 'none';
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
    setupAllowed = data.setupMode !== false;
    applySetupAvailability();
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
  const modeSelect = document.getElementById('modeSelect');
  if (modeSelect && modeSelect.value !== m) modeSelect.value = m;

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

  // Health-poll the voice engines only while a voice mode is active (saves ngrok requests)
  if (m === 'audio' || m === 'both') startEngineHealthPoll();
  else stopEngineHealthPoll();

  updatePitchControlVisibility();
}

// ─── STREAM CONTROL ────────────────────────────────────────────────────────────
async function startStream() {
  if (isStreaming) return;

  // Validate (Setup Mode is free, so a 0-coin user is still allowed)
  if (!setupActive && coinBalance <= 0) {
    showToast('You have no coins. Please buy coins to continue.', 'error');
    openBuyCoins();
    return;
  }

  if ((mode === 'audio' || mode === 'both') && !selectedVoice) {
    showToast('Please select a voice first.', 'error');
    return;
  }

  if ((mode === 'audio' || mode === 'both') && !rvcServerUrl) {
    showToast('Voice server URL not configured. Contact support.', 'error');
    return;
  }

  if ((mode === 'audio' || mode === 'both') && !enginesOnline[engine]) {
    showToast(`Voice ${engine === 'v2' ? '2.0' : '1.0'} is offline right now. Please try again in a moment.`, 'error', 5000);
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
    } else { // Voice 2.0 — single w-okada engine: needs a slot + must claim the slot
      if (selectedVoice.wokadaSlot === null || selectedVoice.wokadaSlot === undefined) {
        showToast('This voice isn\'t available on Voice 2.0 yet. Pick another or use Voice 1.0.', 'error', 5000);
        return;
      }
      const got = await acquireVoice2();
      if (!got) { showToast('Voice 2.0 is in use right now — please try again shortly.', 'info', 5000); return; }
    }
  }

  setStatus('Connecting...', false);
  document.getElementById('startBtn').disabled = true;

  try {
    if (mode === 'video' || mode === 'both') {
      if (setupActive) await startSetupVideo();   // show uploaded image, no Decart
      else await startVideoStream();
    }
    if (mode === 'audio' || mode === 'both') {
      await startAudioPipeline(selectedVoice);
      if (mode === 'audio' && !setupActive) {
        startAudioBilling();
      }
    }

    isStreaming = true;
    document.getElementById('startBtn').disabled = true;
    document.getElementById('stopBtn').disabled = false;
    document.getElementById('modeSelector').style.opacity = '0.5';
    document.getElementById('modeSelector').style.pointerEvents = 'none';
    setStatus(setupActive ? 'SETUP · free' : 'LIVE', true);
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
  stopSetupVideo();

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

// Hard ceiling on buffered frames (backstop vs. runaway GPU memory). At the
// 6000ms max + 400ms headroom and ~30fps capture, normal use stays ~192 frames;
// 240 gives margin without ever interfering with the time-based eviction.
const MAX_DELAY_FRAMES = 240;

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
      // Safety cap: never hold more than MAX_DELAY_FRAMES (backstop vs. runaway memory)
      while (frameBuffer.length > MAX_DELAY_FRAMES) {
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

// ─── SETUP MODE ────────────────────────────────────────────────────────────────
// Free, admin-gated mode for first-time users to practise their OBS / WhatsApp
// setup without burning Decart or coins. It paints the user's uploaded reference
// image (or a placeholder) into a canvas and streams it into the SAME output
// surface Decart uses (outputVideo + window.aiOutputStream) — so the popout/OBS
// source is identical to live mode and needs no re-setup when they go live.
// Voice still runs (free). Admin disables it per-user once setup is confirmed.
const SETUP_PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='1280' height='720'>" +
  "<rect width='1280' height='720' fill='black'/>" +
  "<text x='640' y='342' fill='white' font-family='Arial' font-size='54' font-weight='bold' text-anchor='middle'>SETUP MODE</text>" +
  "<text x='640' y='404' fill='rgb(160,160,160)' font-family='Arial' font-size='26' text-anchor='middle'>Upload a reference image to preview it here</text>" +
  "</svg>"
);

function applySetupAvailability() {
  const btn = document.getElementById('setupModeBtn');
  if (btn) btn.style.display = setupAllowed ? '' : 'none';
  if (!setupAllowed && setupActive && !isStreaming) setupActive = false;
  updateSetupUI();
}

function updateSetupUI() {
  const btn = document.getElementById('setupModeBtn');
  const badge = document.getElementById('setupBadge');
  if (btn) {
    btn.textContent = setupActive ? '🛠 Setup: ON' : '🛠 Setup Mode';
    btn.style.background = setupActive ? '#f59e0b' : '';
    btn.style.color = setupActive ? '#1a1a1a' : '';
    btn.style.borderColor = setupActive ? '#f59e0b' : '';
  }
  if (badge) badge.style.display = setupActive ? '' : 'none';
  const banner = document.getElementById('setupBanner');
  if (banner) banner.style.display = setupActive ? 'flex' : 'none';
}

function toggleSetupMode() {
  if (isStreaming) { showToast('Stop before toggling Setup Mode.', 'error'); return; }
  if (!setupAllowed) { showToast("Setup Mode isn't available for your account.", 'info'); return; }
  setupActive = !setupActive;
  updateSetupUI();
  showToast(setupActive
    ? 'Setup Mode ON — free preview, no coins charged.'
    : 'Setup Mode off — normal (paid) streaming.', setupActive ? 'success' : 'info');
}

async function startSetupVideo() {
  const outputVideo = document.getElementById('outputVideo');
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');

  const src = referenceFile ? URL.createObjectURL(referenceFile) : SETUP_PLACEHOLDER;
  const img = new Image();
  await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; img.src = src; });

  // Stretch the image to fill the 16:9 frame (fills the screen in fullscreen)
  const draw = () => {
    try { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); } catch (_) {}
  };
  draw();
  setupDrawInterval = setInterval(draw, 100);   // keep the captured stream live
  if (src.startsWith('blob:')) { try { URL.revokeObjectURL(src); } catch (_) {} }

  setupCanvasStream = canvas.captureStream(15);
  outputVideo.srcObject = setupCanvasStream;
  outputVideo.style.display = 'block';
  document.getElementById('outputCanvas').style.display = 'none';
  document.getElementById('outputPlaceholder').style.display = 'none';
  window.aiOutputStream = setupCanvasStream;   // identical surface to live Decart → OBS unchanged
}

function stopSetupVideo() {
  if (setupDrawInterval) { clearInterval(setupDrawInterval); setupDrawInterval = null; }
  if (setupCanvasStream) {
    if (window.aiOutputStream === setupCanvasStream) window.aiOutputStream = null;
    try { setupCanvasStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    setupCanvasStream = null;
    const outputVideo = document.getElementById('outputVideo');
    if (outputVideo) { outputVideo.srcObject = null; outputVideo.style.display = 'none'; }
    const ph = document.getElementById('outputPlaceholder');
    if (ph) ph.style.display = 'flex';
  }
}

// Load an image Blob/File into an <img>
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

// Draw an image to fill w×h (cover), centered
function drawCover(ctx, img, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const iw = img.width * r, ih = img.height * r;
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
}

// Produce the single reference image to send to Decart. With an optional
// background, we cut the person out of the face image and composite them over
// the background at full resolution (face kept large & sharp -> Decart's
// identity quality is preserved), since Decart only accepts one image.
async function buildReferenceImage() {
  if (!backgroundFile || !referenceFile) return referenceFile;
  try {
    showToast('Preparing your background… (first time downloads a small model)', 'info', 6000);
    if (!bgRemovalMod) {
      const m = await import('https://esm.sh/@imgly/background-removal@1.5.8');
      bgRemovalMod = m.removeBackground || (m.default && m.default.removeBackground) || m.default || m;
    }
    const removeBackground = bgRemovalMod.removeBackground || bgRemovalMod;
    const cutoutBlob = await removeBackground(referenceFile);        // transparent PNG of the person
    const [bgImg, personImg] = await Promise.all([blobToImage(backgroundFile), blobToImage(cutoutBlob)]);
    const W = 1280, H = 720;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    drawCover(ctx, bgImg, W, H);                                     // new background fills the frame
    const scale = (H * 0.96) / personImg.height;                    // person nearly full height, centered
    const pw = personImg.width * scale, ph = personImg.height * scale;
    ctx.drawImage(personImg, (W - pw) / 2, H - ph, pw, ph);
    return await new Promise(res => canvas.toBlob(b => res(b || referenceFile), 'image/jpeg', 0.95));
  } catch (e) {
    showToast('Could not process the background — using your face image only.', 'error', 6000);
    return referenceFile;
  }
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
    payload.image = await buildReferenceImage();
    const usingBg = !!backgroundFile;
    if (!prompt) payload.prompt = usingBg
      ? 'Transform my face and body to look exactly like the person in the reference image, and place me in the same background scene shown behind them in the reference image. Follow my exact movements, pose and hand positions precisely — do not add, invent or change any body or hand movements. Only change my appearance and the background.'
      : 'Transform my face and body to look exactly like the person in the reference image. Follow my exact movements, pose and hand positions precisely — do not add, invent or change any body or hand movements. Keep all objects, phones, cups and items I hold completely unchanged and clearly visible. Only transform my face, skin, hair and body to match the reference person. Do not blur or remove any objects in the scene.';
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

// Voice 2.0 — stream the mic to w-okada via the RVC server's /v2 proxy.
// Bandwidth-optimised for the tunnel: send 16kHz int16 (the proxy expands to
// 48k float32 for w-okada and shrinks the result back). Requests are PIPELINED
// (sent concurrently, not one-at-a-time) so the tunnel's round-trip latency
// overlaps instead of stacking; responses are played back in timestamp order
// through the jitter buffer.
// ─── MIC GUARD + NOISE GATE (echo protection) ─────────────────────────────────
// The caller can only ever hear themselves if THEIR voice gets into OUR mic
// input and is converted. Two doors, both closed here:
//  1) Windows per-app overrides can silently redirect Chrome's default mic to a
//     virtual/loopback device (NDI Webcam Audio, CABLE Output, Stereo Mix,
//     Voicemod…) that carries the call's own audio. getSafeMicStream() detects
//     that and re-grabs a real microphone explicitly by deviceId — explicit
//     device requests bypass Windows' default-device redirects entirely.
//  2) The far end's voice can bleed faintly into a wired headset mic
//     (electrical crosstalk / earpiece leakage). makeNoiseGate() mutes anything
//     far below direct-speech level BEFORE it reaches the converter. Direct
//     speech passes untouched — no model/quality change, quiet junk is silenced.
const BAD_MIC_RE = /cable|vb-?audio|virtual|ndi|webcam|web camera|stereo mix|what u hear|loopback|monitor|voicemod/i;

async function getSafeMicStream(audioConstraints) {
  let stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  const label = (stream.getAudioTracks()[0] || {}).label || '';
  if (!BAD_MIC_RE.test(label)) return stream;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const real = devs.find(d => d.kind === 'audioinput'
      && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'
      && d.label && !BAD_MIC_RE.test(d.label));
    if (real) {
      stream.getTracks().forEach(t => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...audioConstraints, deviceId: { exact: real.deviceId } }, video: false
      });
      showToast(`Mic was "${label}" (loops call audio) — switched to "${real.label}".`, 'info');
      return stream;
    }
  } catch (_) {}
  showToast(`Mic is "${label}" — a virtual device that echoes the call back. Select your real microphone in Windows sound settings.`, 'error');
  return stream;
}

const GATE_OPEN_RMS  = 0.010;  // ~-40 dBFS; direct speech is typically 5-20x louder
const GATE_CLOSE_RMS = 0.005;  // hysteresis so held notes don't flutter
const GATE_HANG_SEC  = 0.5;    // stay open through natural pauses between words
function makeNoiseGate(sampleRate) {
  let open = false, hang = 0;
  return (block) => {
    let s = 0; for (let i = 0; i < block.length; i++) s += block[i] * block[i];
    const rms = Math.sqrt(s / block.length);
    if (rms >= GATE_OPEN_RMS) { open = true; hang = GATE_HANG_SEC * sampleRate; }
    else if (open) { hang -= block.length; if (hang <= 0 && rms < GATE_CLOSE_RMS) open = false; }
    if (!open) block.fill(0);
  };
}

const V2_RATE = 16000;
const V2_CHUNK = 8000;    // 0.5s @ 16k per request
async function startV2Pipeline(voice) {
  const base = rvcServerUrl.replace(/\/$/, '');
  if (voice.wokadaSlot === null || voice.wokadaSlot === undefined) {
    throw new Error('This voice is not set up for Voice 2.0 yet.');
  }
  const slotRes = await fetch(`${base}/v2/set_slot?slot=${voice.wokadaSlot}`, {
    method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }
  }).catch(() => null);
  if (!slotRes || !slotRes.ok) throw new Error('Voice 2.0 engine not reachable. Try again.');

  // Start at the current pitch-slider value
  try {
    await fetch(`${base}/v2/set_pitch?slot=${voice.wokadaSlot}&pitch=${v2Pitch}`, {
      method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }
    });
  } catch (_) {}

  audioCtx = new AudioContext({ sampleRate: V2_RATE });
  playbackCtx = new AudioContext({ sampleRate: V2_RATE });
  nextPlayTime = 0;
  micStream = await getSafeMicStream({ echoCancellation: true, autoGainControl: false, noiseSuppression: true });
  const source = audioCtx.createMediaStreamSource(micStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const gate = makeNoiseGate(V2_RATE);

  const statusEl = document.getElementById('voiceStatusText');
  if (statusEl) statusEl.textContent = `Voice 2.0 active: ${voice.name}`;

  let acc = new Float32Array(0);
  let sentSamples = 0;          // cumulative ts (monotonic, for ordering + stitching)
  let expectedTs = 0;           // next ts to play, so we play strictly in order
  const outBuf = new Map();     // ts -> Float32Array (converted, awaiting its turn)
  let outputLevel = 0;
  let scheduled = [];           // {src, end} of queued playback nodes, for catch-up

  function schedule(f32) {
    if (!playbackCtx) return;
    let s = 0; for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
    outputLevel = Math.min(100, Math.sqrt(s / f32.length) * 300);
    const now = playbackCtx.currentTime;
    // Latency guard: if the buffered lead has ballooned (bursts, voice-switch
    // reloads), stop the pending backlog and resync to a small lead so the
    // delay can't creep up to 10-12s over a session.
    if (nextPlayTime - now > MAX_V2_LEAD) {
      for (const it of scheduled) { if (it.end > now) { try { it.src.stop(); } catch (_) {} } }
      scheduled = [];
      nextPlayTime = 0;   // forces the reset branch below
    }
    const b = playbackCtx.createBuffer(1, f32.length, V2_RATE);
    b.getChannelData(0).set(f32);
    const src = playbackCtx.createBufferSource();
    src.buffer = b; src.connect(playbackCtx.destination);
    const startAt = (nextPlayTime <= now + 0.001) ? now + PREROLL_SEC : nextPlayTime;
    src.start(startAt);
    nextPlayTime = startAt + b.duration;
    scheduled.push({ src, end: nextPlayTime });
    if (scheduled.length > 48) scheduled = scheduled.filter(it => it.end > now - 0.5);
  }

  function flush() {
    while (outBuf.has(expectedTs)) {
      schedule(outBuf.get(expectedTs)); outBuf.delete(expectedTs); expectedTs += V2_CHUNK;
    }
    // if the next chunk is missing/late but others have piled up, skip ahead
    if (!outBuf.has(expectedTs) && outBuf.size > 3) {
      const minTs = Math.min(...outBuf.keys());
      if (minTs > expectedTs) expectedTs = minTs;
      while (outBuf.has(expectedTs)) {
        schedule(outBuf.get(expectedTs)); outBuf.delete(expectedTs); expectedTs += V2_CHUNK;
      }
    }
  }

  async function send(int16, ts) {
    try {
      const res = await fetch(`${base}/v2/convert?ts=${ts}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'ngrok-skip-browser-warning': 'true' },
        body: int16.buffer
      });
      if (!res.ok || !isStreaming || !playbackCtx) return;
      const i16 = new Int16Array(await res.arrayBuffer());
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      outBuf.set(ts, f32);
      flush();
    } catch (_) {}
  }

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!isStreaming) return;
    const inb = e.inputBuffer.getChannelData(0);
    gate(inb);   // mute sub-speech-level bleed before it can be converted
    const merged = new Float32Array(acc.length + inb.length);
    merged.set(acc); merged.set(inb, acc.length);
    acc = merged;
    while (acc.length >= V2_CHUNK) {
      const chunk = acc.slice(0, V2_CHUNK);
      acc = acc.slice(V2_CHUNK);
      const i16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) i16[i] = Math.max(-32768, Math.min(32767, chunk[i] * 32768));
      send(i16, sentSamples);     // pipelined: fire concurrently, don't await
      sentSamples += V2_CHUNK;
    }
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);

  // level meters
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  micLevelInterval = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) { const v = (dataArray[i] - 128) / 128; sum += v * v; }
    document.getElementById('micLevel').style.height = Math.min(100, Math.sqrt(sum / dataArray.length) * 400) + '%';
    const spk = document.getElementById('spkLevel');
    if (spk) spk.style.height = outputLevel + '%';
    outputLevel *= 0.85;
  }, 50);
}

async function startAudioPipeline(voice) {
  // Voice 2.0 — stream to w-okada via the RVC server's /v2 proxy
  if (engine === 'v2') {
    await startV2Pipeline(voice);
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
  // echoCancellation MUST be on: the converted voice plays out the speakers,
  // and without AEC the mic re-captures it, the server re-converts it, and it
  // loops/stacks — the "repeating continuously" bug. AEC cancels that playback
  // out of the mic signal (same as video calls) while keeping your dry voice.
  micStream = await getSafeMicStream({ echoCancellation: true, autoGainControl: false, noiseSuppression: true });

  const source = audioCtx.createMediaStreamSource(micStream);
  const gate = makeNoiseGate(16000);

  // Analyser for level meter
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!rvcWs || rvcWs.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
    gate(float32);   // mute sub-speech-level bleed before it can be converted
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
  let scheduled = [];           // {src, end} of queued playback nodes, for catch-up
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

      // Jitter-buffered, forward-only scheduling. When the queue is empty (first
      // chunk, or after a drain) we don't play immediately — we schedule PREROLL_SEC
      // ahead to build a cushion that absorbs late chunks (network/inference jitter),
      // which is what was starving the queue and cracking. Otherwise play gaplessly
      // right after the previous chunk; the start time is never moved backward, so
      // converted audio can never overlap/stack on itself.
      const now = playbackCtx.currentTime;
      // Latency guard (same as Voice 2.0): if the buffered lead balloons, drop
      // the backlog and resync so the delay can't creep up over a session.
      if (nextPlayTime - now > MAX_V2_LEAD) {
        for (const it of scheduled) { if (it.end > now) { try { it.src.stop(); } catch (_) {} } }
        scheduled = [];
        nextPlayTime = 0;
      }
      let startAt;
      if (nextPlayTime <= now + 0.001) {
        startAt = now + PREROLL_SEC;
      } else {
        startAt = nextPlayTime;
      }
      src.start(startAt);
      nextPlayTime = startAt + buffer.duration;
      scheduled.push({ src, end: nextPlayTime });
      if (scheduled.length > 48) scheduled = scheduled.filter(it => it.end > now - 0.5);
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
  if (setupActive) return;   // Setup Mode is free — never deduct coins
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
    ? 'Premium — smoother, more natural voice. One person at a time; costs more coins.'
    : 'Standard — always available.';
  if (guideBtn) guideBtn.style.display = 'none';   // Voice 2.0 is server-side now; no user setup
  updatePitchControlVisibility();
}

// Pitch slider is Voice 2.0 only. Voice-only mode uses the big centered slider;
// video+voice keeps the compact one in the left panel.
function updatePitchControlVisibility() {
  const isV2 = engine === 'v2';
  const panel  = document.getElementById('pitchControl');       // left panel (video+voice)
  const center = document.getElementById('audioPitchControl');  // centered (voice-only)
  if (panel)  panel.style.display  = (isV2 && mode === 'both')  ? '' : 'none';
  if (center) center.style.display = (isV2 && mode === 'audio') ? '' : 'none';
  setPitchUI(v2Pitch);   // keep both sliders + labels in sync
}

function setPitchUI(val) {
  v2Pitch = val;
  const txt = `Voice Pitch: ${val > 0 ? '+' : ''}${val}`;
  ['pitchSlider', 'audioPitchSlider'].forEach(id => {
    const s = document.getElementById(id); if (s && parseInt(s.value) !== val) s.value = val;
  });
  ['pitchLabel', 'audioPitchLabel'].forEach(id => {
    const l = document.getElementById(id); if (l) l.textContent = txt;
  });
}

function wirePitchSlider(id) {
  const s = document.getElementById(id);
  if (!s) return;
  s.addEventListener('input', (e) => setPitchUI(parseInt(e.target.value)));
  s.addEventListener('change', () => applyV2Pitch());
}

// Push the current pitch to w-okada live (used on slider release + at stream start)
async function applyV2Pitch() {
  if (!isStreaming || engine !== 'v2' || !selectedVoice || selectedVoice.wokadaSlot == null || !rvcServerUrl) return;
  const base = rvcServerUrl.replace(/\/$/, '');
  try {
    await fetch(`${base}/v2/set_pitch?slot=${selectedVoice.wokadaSlot}&pitch=${v2Pitch}`, {
      method: 'POST', headers: { 'ngrok-skip-browser-warning': 'true' }
    });
  } catch (_) {}
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

// Returns true if the Voice 2.0 slot is ours (start now); false if busy.
async function acquireVoice2() {
  try {
    const r = await voice2Api('v2_acquire');
    return !!(r.ok && r.state === 'active');
  } catch (_) {
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
  } else { // Voice 2.0 — hold the single w-okada slot while streaming
    v2HeartbeatInterval = setInterval(async () => {
      try { const r = await voice2Api('v2_heartbeat'); if (r && r.lost) { showToast('Voice 2.0 session ended.', 'info'); stopStream(); } }
      catch (_) {}
    }, 10000);
  }
}

function stopEngineHeartbeat() {
  if (v2HeartbeatInterval) { clearInterval(v2HeartbeatInterval); v2HeartbeatInterval = null; voice2Api('v2_release').catch(() => {}); }
  if (v1HeartbeatInterval) { clearInterval(v1HeartbeatInterval); v1HeartbeatInterval = null; voice2Api('v1_stop').catch(() => {}); }
}

// ─── ENGINE AVAILABILITY (grey out when the host laptop/servers are offline) ───
// Polls the RVC server's health endpoints (only while in a voice mode, to spare
// the ngrok request budget). /health = Voice 1.0 (RVC) up; /v2/health = Voice 2.0
// (w-okada) reachable. When the laptop is off the tunnel is dead → both go grey;
// they light back up on their own once the servers are running again.
async function pingHealth(path) {
  if (!rvcServerUrl) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(rvcServerUrl.replace(/\/+$/, '') + path, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    if (path === '/v2/health') return data.ok === true;   // w-okada reachable
    return data.status === 'ok';                           // RVC server up
  } catch (_) {
    return false;   // network error / timeout / tunnel down
  }
}

async function checkEnginesHealth() {
  if (!rvcServerUrl) { enginesOnline = { v1: false, v2: false }; applyEngineAvailability(); return; }
  const [v1, v2] = await Promise.all([pingHealth('/health'), pingHealth('/v2/health')]);
  enginesOnline = { v1, v2 };
  applyEngineAvailability();
}

function applyEngineAvailability() {
  const map = [['v1', 'engineV1Btn', 'engStatusV1', 'Voice 1.0'], ['v2', 'engineV2Btn', 'engStatusV2', 'Voice 2.0']];
  for (const [key, btnId, statId, label] of map) {
    const on = !!enginesOnline[key];
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.disabled = !on;
      btn.style.opacity = on ? '' : '0.4';
      btn.style.filter  = on ? '' : 'grayscale(1)';
      btn.style.cursor  = on ? '' : 'not-allowed';
      btn.title = on ? '' : `${label} is offline right now (host laptop/servers are off).`;
    }
    const stat = document.getElementById(statId);
    if (stat) {
      const color = on ? '#36d399' : '#9aa0a6';
      stat.innerHTML = `<span style="color:${color};">●</span> ${label}: ${on ? 'online' : 'offline'}`;
    }
  }
}

function startEngineHealthPoll() {
  stopEngineHealthPoll();
  checkEnginesHealth();
  engineHealthInterval = setInterval(checkEnginesHealth, 30000);
}
function stopEngineHealthPoll() {
  if (engineHealthInterval) { clearInterval(engineHealthInterval); engineHealthInterval = null; }
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
