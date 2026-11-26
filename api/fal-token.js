import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const USERS_KEY = 'vnv_users';

// Only mint tokens for the Lucy realtime endpoints we actually use.
const ALLOWED_APPS = new Set([
  'decart/lucy-2-5/realtime',
  'decart/lucy-2-6/realtime',
  'decart/lucy-realtime-2/realtime',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, app } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });
  const appId = ALLOWED_APPS.has(app) ? app : 'decart/lucy-2-5/realtime';

  try {
    // Gate on an active account, same as /api/get-key.
    const raw = await redis.get(USERS_KEY);
    const users = raw ? JSON.parse(raw) : [];
    const user = users.find(u => u.email === email);
    if (!user || !user.active) {
      return res.status(403).json({ error: 'Account not found or inactive' });
    }

    const falKey = process.env.FAL_KEY;
    if (!falKey) return res.status(500).json({ error: 'FAL_KEY not configured' });

    // Mint a short-lived browser token scoped to this one app.
    const r = await fetch('https://rest.fal.ai/tokens/realtime', {
      method: 'POST',
      headers: { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[fal-token] mint failed', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'Could not mint fal token', status: r.status });
    }
    // fal returns the JWT as a bare JSON string: "eyJ...". Unwrap to the raw token.
    const body = (await r.text()).trim();
    let token = body;
    try { const p = JSON.parse(body); if (typeof p === 'string') token = p; } catch (_) {}

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(token);
  } catch (err) {
    console.error('[fal-token]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
