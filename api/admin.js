import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const USERS_KEY = 'vnv_users';
const BANK_KEY = 'vnv_bank_details';
const WALLETS_KEY = 'vnv_crypto_wallets';
const SETTINGS_KEY = 'vnv_settings';
const RVC_URL_KEY = 'vnv_rvc_url';
const WOKADA_URL_KEY = 'vnv_wokada_url';   // Voice 2.0 (w-okada) server tunnel URL

function coinKey(email) {
  return `vnv_coins:${email}`;
}

async function getBalance(email) {
  const val = await redis.get(coinKey(email));
  return val !== null ? parseFloat(val) : 0;
}

async function setBalance(email, balance) {
  await redis.set(coinKey(email), balance.toString());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { action, password } = body;

  if (!action) return res.status(400).json({ error: 'Missing action' });

  const isAdmin = password === ADMIN_PASSWORD;

  try {

    // ── get_rvc_url (public) ───────────────────────────────────────────────────
    if (action === 'get_rvc_url') {
      const url = await redis.get(RVC_URL_KEY);
      return res.status(200).json({ url: url || '' });
    }

    // ── set_rvc_url (admin) ────────────────────────────────────────────────────
    if (action === 'set_rvc_url') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { url } = body;
      if (!url) {
        await redis.del(RVC_URL_KEY);
      } else {
        await redis.set(RVC_URL_KEY, url.trim());
      }
      return res.status(200).json({ ok: true });
    }

    // ── get_wokada_url (public) — Voice 2.0 engine URL ─────────────────────────
    if (action === 'get_wokada_url') {
      const url = await redis.get(WOKADA_URL_KEY);
      return res.status(200).json({ url: url || '' });
    }

    // ── set_wokada_url (admin) ─────────────────────────────────────────────────
    if (action === 'set_wokada_url') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { url } = body;
      if (!url) {
        await redis.del(WOKADA_URL_KEY);
      } else {
        await redis.set(WOKADA_URL_KEY, url.trim());
      }
      return res.status(200).json({ ok: true });
    }

    // ── get_bank_public (public) ───────────────────────────────────────────────
    if (action === 'get_bank_public') {
      const raw = await redis.get(BANK_KEY);
      const bank = raw ? JSON.parse(raw) : {};
      // Return safe fields only (no routing numbers that shouldn't be public)
      const safe = {
        bankName: bank.bankName || '',
        accountName: bank.accountName || '',
        accountNumber: bank.accountNumber || '',
        sortCode: bank.sortCode || '',
        note: bank.note || ''
      };
      return res.status(200).json({ bank: safe });
    }

    // ── get_wallets (public) ───────────────────────────────────────────────────
    if (action === 'get_wallets') {
      const raw = await redis.get(WALLETS_KEY);
      const wallets = raw ? JSON.parse(raw) : {};
      return res.status(200).json({ wallets });
    }

    // All actions below require admin password
    if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });

    // ── get_users ──────────────────────────────────────────────────────────────
    if (action === 'get_users') {
      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];
      // Attach coin balances
      const usersWithCoins = await Promise.all(
        users.map(async u => ({
          ...u,
          password: undefined, // strip password from response
          coins: await getBalance(u.email)
        }))
      );
      return res.status(200).json({ users: usersWithCoins });
    }

    // ── add_user ───────────────────────────────────────────────────────────────
    if (action === 'add_user') {
      const { email, userPassword, coins } = body;
      if (!email || !userPassword) return res.status(400).json({ error: 'Email and password required' });

      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];

      if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const accessCode = 'VNV-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      users.push({
        email,
        password: userPassword,
        accessCode,
        active: true,
        createdAt: Date.now()
      });

      await redis.set(USERS_KEY, JSON.stringify(users));
      await setBalance(email, parseInt(coins) || 500);

      return res.status(200).json({ ok: true, accessCode });
    }

    // ── update_user ────────────────────────────────────────────────────────────
    if (action === 'update_user') {
      const { targetEmail, updates } = body;
      if (!targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });

      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];
      const idx = users.findIndex(u => u.email === targetEmail);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });

      users[idx] = { ...users[idx], ...(updates || {}) };
      await redis.set(USERS_KEY, JSON.stringify(users));
      return res.status(200).json({ ok: true });
    }

    // ── delete_user ────────────────────────────────────────────────────────────
    if (action === 'delete_user') {
      const { targetEmail } = body;
      if (!targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });

      const raw = await redis.get(USERS_KEY);
      const users = raw ? JSON.parse(raw) : [];
      const filtered = users.filter(u => u.email !== targetEmail);

      await redis.set(USERS_KEY, JSON.stringify(filtered));
      await redis.del(coinKey(targetEmail));
      return res.status(200).json({ ok: true });
    }

    // ── grant_coins ────────────────────────────────────────────────────────────
    if (action === 'grant_coins') {
      const { targetEmail, amount } = body;
      if (!targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });
      const amt = parseFloat(amount);
      if (isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });

      const bal = await getBalance(targetEmail);
      const newBal = Math.max(0, bal + amt);
      await setBalance(targetEmail, newBal);
      return res.status(200).json({ ok: true, balance: newBal });
    }

    // ── get_settings ───────────────────────────────────────────────────────────
    if (action === 'get_settings') {
      const raw = await redis.get(SETTINGS_KEY);
      const settings = raw ? JSON.parse(raw) : {};
      return res.status(200).json({ settings });
    }

    // ── set_settings ───────────────────────────────────────────────────────────
    if (action === 'set_settings') {
      const { settings } = body;
      const raw = await redis.get(SETTINGS_KEY);
      const existing = raw ? JSON.parse(raw) : {};
      const updated = { ...existing, ...(settings || {}) };
      await redis.set(SETTINGS_KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true, settings: updated });
    }

    // ── get_wallets (admin) ────────────────────────────────────────────────────
    if (action === 'get_wallets_admin') {
      const raw = await redis.get(WALLETS_KEY);
      return res.status(200).json({ wallets: raw ? JSON.parse(raw) : {} });
    }

    // ── set_wallets ────────────────────────────────────────────────────────────
    if (action === 'set_wallets') {
      const { wallets } = body;
      if (!wallets || typeof wallets !== 'object') return res.status(400).json({ error: 'Invalid wallets' });
      await redis.set(WALLETS_KEY, JSON.stringify(wallets));
      return res.status(200).json({ ok: true });
    }

    // ── get_bank ───────────────────────────────────────────────────────────────
    if (action === 'get_bank') {
      const raw = await redis.get(BANK_KEY);
      return res.status(200).json({ bank: raw ? JSON.parse(raw) : {} });
    }

    // ── set_bank ───────────────────────────────────────────────────────────────
    if (action === 'set_bank') {
      const { bank } = body;
      if (!bank || typeof bank !== 'object') return res.status(400).json({ error: 'Invalid bank object' });
      await redis.set(BANK_KEY, JSON.stringify(bank));
      return res.status(200).json({ ok: true });
    }

    // ── clear_bank ─────────────────────────────────────────────────────────────
    if (action === 'clear_bank') {
      await redis.del(BANK_KEY);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[admin]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
