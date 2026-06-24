import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const VOICES_KEY = 'vnv_voices';
const REQUESTS_KEY = 'vnv_voice_requests';
const USER_VOICES_KEY = 'vnv_user_voices';
const USERS_KEY = 'vnv_users';
const VOICE_PRICE_KEY = 'vnv_voice_price';          // fixed custom-voice price (USD)
const VOICE_PRICE_NAIRA_KEY = 'vnv_voice_price_naira';
const DEFAULT_VOICE_PRICE = 20;
const DEFAULT_VOICE_PRICE_NAIRA = 32000;

async function readVoicePrice() {
  const [usd, ngn] = await Promise.all([
    redis.get(VOICE_PRICE_KEY),
    redis.get(VOICE_PRICE_NAIRA_KEY),
  ]);
  return {
    price: usd ? parseFloat(usd) : DEFAULT_VOICE_PRICE,
    priceNaira: ngn ? parseFloat(ngn) : DEFAULT_VOICE_PRICE_NAIRA,
  };
}

function genId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

async function getVoices() {
  const raw = await redis.get(VOICES_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function setVoices(voices) {
  await redis.set(VOICES_KEY, JSON.stringify(voices));
}

async function getRequests() {
  const raw = await redis.get(REQUESTS_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function setRequests(requests) {
  await redis.set(REQUESTS_KEY, JSON.stringify(requests));
}

async function getUserVoices() {
  const raw = await redis.get(USER_VOICES_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function setUserVoices(map) {
  await redis.set(USER_VOICES_KEY, JSON.stringify(map));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { action, password, email } = body;

  if (!action) return res.status(400).json({ error: 'Missing action' });

  const isAdmin = password === ADMIN_PASSWORD;

  try {

    // ── list (public) ──────────────────────────────────────────────────────────
    if (action === 'list') {
      const voices = await getVoices();
      const userVoicesMap = await getUserVoices();
      const unlockedIds = email ? (userVoicesMap[email] || []) : [];

      const result = voices
        .filter(v => v.isPublic || unlockedIds.includes(v.id) || isAdmin)
        .map(v => ({
          ...v,
          previewBase64: v.previewBase64 ? v.previewBase64 : undefined,
          unlocked: v.isPublic || unlockedIds.includes(v.id)
        }));

      return res.status(200).json({ voices: result });
    }

    // ── add_voice (admin) ──────────────────────────────────────────────────────
    if (action === 'add_voice') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { name, folderName, description, previewUrl, previewBase64, isPublic, isPremium, price } = body;
      if (!name || !folderName) return res.status(400).json({ error: 'Name and folderName required' });

      const voices = await getVoices();
      const newVoice = {
        id: genId('voice'),
        name,
        description: description || '',
        folderName,
        previewUrl: previewUrl || '',
        previewBase64: previewBase64 || '',
        isPublic: isPublic !== false,
        isPremium: !!isPremium,
        price: parseFloat(price) || 0,
        createdAt: Date.now()
      };

      voices.push(newVoice);
      await setVoices(voices);
      return res.status(200).json({ ok: true, voice: newVoice });
    }

    // ── update_voice (admin) ───────────────────────────────────────────────────
    if (action === 'update_voice') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const voices = await getVoices();
      const idx = voices.findIndex(v => v.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Voice not found' });

      const allowed = ['name', 'description', 'folderName', 'previewUrl', 'previewBase64', 'isPublic', 'isPremium', 'price'];
      for (const key of allowed) {
        if (body[key] !== undefined) voices[idx][key] = body[key];
      }
      voices[idx].updatedAt = Date.now();

      await setVoices(voices);
      return res.status(200).json({ ok: true, voice: voices[idx] });
    }

    // ── delete_voice (admin) ───────────────────────────────────────────────────
    if (action === 'delete_voice') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const voices = await getVoices();
      const filtered = voices.filter(v => v.id !== id);
      if (filtered.length === voices.length) return res.status(404).json({ error: 'Voice not found' });

      await setVoices(filtered);
      return res.status(200).json({ ok: true });
    }

    // ── upload_preview (admin) ─────────────────────────────────────────────────
    if (action === 'upload_preview') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id, previewBase64 } = body;
      if (!id || !previewBase64) return res.status(400).json({ error: 'Missing id or previewBase64' });

      const voices = await getVoices();
      const idx = voices.findIndex(v => v.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Voice not found' });

      voices[idx].previewBase64 = previewBase64;
      voices[idx].previewUrl = '';
      await setVoices(voices);
      return res.status(200).json({ ok: true });
    }

    // ── get_user_voices ────────────────────────────────────────────────────────
    if (action === 'get_user_voices') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const map = await getUserVoices();
      return res.status(200).json({ voiceIds: map[email] || [] });
    }

    // ── get_voice_price (public) ─────────────────────────────────────────────────
    if (action === 'get_voice_price') {
      return res.status(200).json(await readVoicePrice());
    }

    // ── set_voice_price (admin) ───────────────────────────────────────────────────
    if (action === 'set_voice_price') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { price, priceNaira } = body;
      if (price !== undefined && !isNaN(parseFloat(price))) await redis.set(VOICE_PRICE_KEY, parseFloat(price).toString());
      if (priceNaira !== undefined && !isNaN(parseFloat(priceNaira))) await redis.set(VOICE_PRICE_NAIRA_KEY, parseFloat(priceNaira).toString());
      return res.status(200).json({ ok: true, ...(await readVoicePrice()) });
    }

    // ── request_voice (user) ───────────────────────────────────────────────────
    if (action === 'request_voice') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const { voiceName, description, notes } = body;
      if (!voiceName || !description) return res.status(400).json({ error: 'voiceName and description required' });

      // Verify user exists
      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const user = users.find(u => u.email === email);
      if (!user || !user.active) return res.status(403).json({ error: 'Account not found or inactive' });

      // Attach the current fixed price so the user pays a known amount up front
      const { price, priceNaira } = await readVoicePrice();

      const requests = await getRequests();
      const reqId = genId('vreq');
      requests.push({
        id: reqId,
        email,
        voiceName,
        description,
        notes: notes || '',
        status: 'pending',
        price,
        priceNaira,
        createdAt: Date.now(),
        approvedAt: null,
        paidAt: null
      });

      await setRequests(requests);
      return res.status(200).json({ ok: true, id: reqId, price, priceNaira });
    }

    // ── get_requests (admin) ───────────────────────────────────────────────────
    if (action === 'get_requests') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const requests = await getRequests();
      return res.status(200).json({ requests });
    }

    // ── set_request_price (admin) ──────────────────────────────────────────────
    if (action === 'set_request_price') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id, price } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const requests = await getRequests();
      const idx = requests.findIndex(r => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Request not found' });

      requests[idx].price = parseFloat(price) || 0;
      await setRequests(requests);
      return res.status(200).json({ ok: true });
    }

    // ── approve_request (admin) ────────────────────────────────────────────────
    if (action === 'approve_request') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id, price } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const requests = await getRequests();
      const idx = requests.findIndex(r => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Request not found' });

      requests[idx].status = 'approved';
      requests[idx].approvedAt = Date.now();
      if (price !== undefined) requests[idx].price = parseFloat(price) || 0;
      await setRequests(requests);
      return res.status(200).json({ ok: true });
    }

    // ── reject_request (admin) ─────────────────────────────────────────────────
    if (action === 'reject_request') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });

      const requests = await getRequests();
      const idx = requests.findIndex(r => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Request not found' });

      requests[idx].status = 'rejected';
      requests[idx].rejectedAt = Date.now();
      await setRequests(requests);
      return res.status(200).json({ ok: true });
    }

    // ── confirm_payment (admin) ────────────────────────────────────────────────
    if (action === 'confirm_payment') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { id, folderName } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!folderName) return res.status(400).json({ error: 'Missing folderName for the voice model' });

      const requests = await getRequests();
      const idx = requests.findIndex(r => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Request not found' });

      const req = requests[idx];
      if (req.status !== 'approved') return res.status(400).json({ error: 'Request is not in approved state' });

      // Add voice model (non-public, for this user)
      const voices = await getVoices();
      const voiceId = genId('voice');
      voices.push({
        id: voiceId,
        name: req.voiceName,
        description: req.description,
        folderName,
        previewUrl: '',
        previewBase64: '',
        isPublic: false,
        isPremium: true,
        price: req.price || 0,
        createdAt: Date.now()
      });
      await setVoices(voices);

      // Unlock for user
      const map = await getUserVoices();
      if (!map[req.email]) map[req.email] = [];
      if (!map[req.email].includes(voiceId)) {
        map[req.email].push(voiceId);
      }
      await setUserVoices(map);

      // Mark request paid
      requests[idx].status = 'paid';
      requests[idx].paidAt = Date.now();
      requests[idx].voiceId = voiceId;
      await setRequests(requests);

      return res.status(200).json({ ok: true, voiceId });
    }

    // ── get_pending_count (admin) ──────────────────────────────────────────────
    if (action === 'get_pending_count') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const requests = await getRequests();
      const count = requests.filter(r => r.status === 'pending').length;
      return res.status(200).json({ count });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[voices]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
