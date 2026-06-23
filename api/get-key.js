import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const USERS_KEY = 'vnv_users';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Missing email' });

  try {
    const raw = await redis.get(USERS_KEY);
    const users = raw ? JSON.parse(raw) : [];
    const user = users.find(u => u.email === email);

    if (!user || !user.active) {
      return res.status(403).json({ error: 'Account not found or inactive' });
    }

    const apiKey = process.env.DECART_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    return res.status(200).json({ key: apiKey });
  } catch (err) {
    console.error('[get-key]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
