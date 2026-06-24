// VNV Pro — app.js

// ─── STATE ────────────────────────────────────────────────────────────────────
let mode = 'video';
let selectedVoice = null;
let audioDelay = 0;
let rvcWs = null;
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

  // Set up delay slider
  document.getElementById('delaySlider').addEventListener('input', (e) => {
    audioDelay = parseInt(e.target.value);
    document.getElementById('delayLabel').textContent = `Voice Delay: ${audioDelay}ms (sync with video)`;
  });

  // Set up enhance toggle label
  document.getElementById('enhanceToggle').addEventListener('change', (e) => {
    e.target.parentElement.nextElementSibling.textContent = e.target.checked ? 'On' : 'Off';
  });

  setupVideoControls();

  // Full-screen pop-out of the AI output in a new tab
  const popoutBtn = document.getElementById('popoutBtn');
  if (popoutBtn) {
    popoutBtn.addEventListener('click', () => {
      if (!window.aiOutputStream) { showToast('Start a video stream first.', 'info'); return; }
      window.open('output.html', '_blank');
    });
  }
});

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
    delayControl.style.display = 'block';
    videoControls(false);
    voicePanel.style.display = '';
  } else if (m === 'both') {
    videoArea.style.display = '';
    audioDisplay.style.display = 'none';
    delayControl.style.display = 'block';
    videoControls(true);
    voicePanel.style.display = '';
  } else {
    videoArea.style.display = '';
    audioDisplay.style.display = 'none';
    delayControl.style.display = 'none';
    videoControls(true);
    voicePanel.style.display = 'none';
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

  if ((mode === 'audio' || mode === 'both') && !rvcServerUrl) {
    showToast('RVC server URL not configured. Contact support.', 'error');
    return;
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
  } catch (err) {
    setStatus('IDLE', false);
    document.getElementById('startBtn').disabled = false;
    showToast('Failed to start: ' + (err.message || err), 'error');
  }
}

function stopStream() {
  isStreaming = false;

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
      outputVideo.style.display = 'block';
      document.getElementById('outputPlaceholder').style.display = 'none';
      // expose for the full-screen pop-out tab
      window.aiOutputStream = transformedStream;
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
    await drainCoins(elapsed, mode === 'both' ? 'both' : 'video');
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
    if (!prompt) payload.prompt = 'Transform my face and body to look exactly like the person in the reference image. Keep all objects, phones, cups and items I hold completely unchanged and clearly visible. Only transform my face, skin, hair and body to match the reference person. Do not blur or remove any objects in the scene.';
  }
  try {
    await realtimeClient.set(payload);
    settingsApplied = true;
    if (!initial) showToast('Settings applied.', 'success');
  } catch (err) {
    if (!initial) showToast('Could not apply settings: ' + (err.message || err), 'error');
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ─── AUDIO PIPELINE ────────────────────────────────────────────────────────────
async function startAudioPipeline(voice) {
  // Connect WebSocket
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

  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!rvcWs || rvcWs.readyState !== WebSocket.OPEN) return;
    const float32 = e.inputBuffer.getChannelData(0);
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

      // Gapless scheduling: queue each chunk right after the previous one.
      // audioDelay (slider) adds an initial cushion for syncing with video.
      const now = playbackCtx.currentTime;
      const startAt = Math.max(now + (audioDelay / 1000), nextPlayTime);
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
    await drainCoins(30, 'audio');
  }, 30000);
}

// ─── DRAIN COINS ───────────────────────────────────────────────────────────────
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
function openRequestVoice(e) {
  if (e) e.stopPropagation();
  document.getElementById('voiceRequestModal').classList.remove('hidden');
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

  try {
    const res = await fetch('/api/voices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request_voice', email: currentEmail, voiceName, description, notes })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      showToast('Request submitted! Send your 15-20 second audio sample to our WhatsApp support.', 'success');
      closeRequestVoice();
      document.getElementById('reqVoiceName').value = '';
      document.getElementById('reqDescription').value = '';
      document.getElementById('reqNotes').value = '';
    } else {
      showToast(data.error || 'Failed to submit request.', 'error');
    }
  } catch (_) {
    showToast('Network error. Please try again.', 'error');
  }
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
