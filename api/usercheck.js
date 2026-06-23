import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const USERS_KEY = 'vnv_users';
const HEARTBEAT_PREFIX = 'vnv_hb:';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, password } = req.body || {};

  if (!action) return res.status(400).json({ error: 'Missing action' });

  try {
    // ── heartbeat ──────────────────────────────────────────────────────────────
    if (action === 'heartbeat') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      await redis.set(HEARTBEAT_PREFIX + email, Date.now(), 'EX', 120);
      return res.status(200).json({ ok: true });
    }

    // ── sessionOnly ────────────────────────────────────────────────────────────
    if (action === 'sessionOnly') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];
      const user = users.find(u => u.email === email);
      if (!user || !user.active) return res.status(401).json({ error: 'Account not found or inactive' });
      return res.status(200).json({ ok: true, email: user.email });
    }

    // ── login ──────────────────────────────────────────────────────────────────
    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

      if (!user) return res.status(401).json({ error: 'No account found with that email.' });
      if (!user.active) return res.status(403).json({ error: 'Your account is not yet activated. Please wait for admin approval.' });
      if (user.password !== password) return res.status(401).json({ error: 'Incorrect password.' });

      // Update last login
      user.lastLogin = Date.now();
      await redis.set(USERS_KEY, JSON.stringify(users));

      return res.status(200).json({ ok: true, email: user.email });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[usercheck]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
