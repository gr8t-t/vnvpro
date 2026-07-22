import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const USERS_KEY = 'vnv_users';
const PENDING_KEY = 'vnv_signup_pending';
const FEE_KEY = 'vnv_signup_fee';
const FEE_NAIRA_KEY = 'vnv_signup_fee_naira';
const DEFAULT_FEE = 5;
const DEFAULT_FEE_NAIRA = 8000;
const SIGNUP_COINS = 500;

async function readFees() {
  const [usdRaw, ngnRaw] = await Promise.all([
    redis.get(FEE_KEY),
    redis.get(FEE_NAIRA_KEY),
  ]);
  return {
    fee: usdRaw ? parseFloat(usdRaw) : DEFAULT_FEE,
    feeNaira: ngnRaw ? parseFloat(ngnRaw) : DEFAULT_FEE_NAIRA,
  };
}

function coinKey(email) {
  return `vnv_coins:${email}`;
}

function genAccessCode() {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VNV-${part()}-${part()}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET /api/signup?action=get_fee
  if (req.method === 'GET') {
    const action = req.query?.action;
    if (action === 'get_fee') {
      return res.status(200).json(await readFees());
    }
    return res.status(400).json({ error: 'Unknown GET action' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { action, password } = body;

  if (!action) return res.status(400).json({ error: 'Missing action' });

  const isAdmin = password === ADMIN_PASSWORD;

  try {

    // ── get_fee ────────────────────────────────────────────────────────────────
    if (action === 'get_fee') {
      return res.status(200).json(await readFees());
    }

    // ── set_fee (admin) ────────────────────────────────────────────────────────
    if (action === 'set_fee') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { fee, feeNaira } = body;
      if (fee !== undefined && !isNaN(parseFloat(fee)))      await redis.set(FEE_KEY, parseFloat(fee).toString());
      if (feeNaira !== undefined && !isNaN(parseFloat(feeNaira))) await redis.set(FEE_NAIRA_KEY, parseFloat(feeNaira).toString());
      return res.status(200).json({ ok: true, ...(await readFees()) });
    }

    // ── check_email ────────────────────────────────────────────────────────────
    if (action === 'check_email') {
      const { email } = body;
      if (!email) return res.status(400).json({ error: 'Missing email' });

      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(200).json({ exists: true });
      }

      // Check pending
      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
      if (pending.find(p => p.email.toLowerCase() === email.toLowerCase())) {
        return res.status(200).json({ exists: true });
      }

      return res.status(200).json({ exists: false });
    }

    // ── create_pending ─────────────────────────────────────────────────────────
    if (action === 'create_pending') {
      const { email, password: userPw, paymentMethod, senderName, transferRef } = body;
      if (!email || !userPw) return res.status(400).json({ error: 'Missing email or password' });

      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];

      // Update or add
      const existingIdx = pending.findIndex(p => p.email.toLowerCase() === email.toLowerCase());
      const record = {
        email,
        password: userPw,
        paymentMethod: paymentMethod || 'crypto',
        senderName: senderName || '',
        transferRef: transferRef || '',
        status: 'pending',
        createdAt: Date.now()
      };

      if (existingIdx !== -1) {
        pending[existingIdx] = { ...pending[existingIdx], ...record };
      } else {
        pending.push(record);
      }

      await redis.set(PENDING_KEY, JSON.stringify(pending));
      return res.status(200).json({ ok: true });
    }

    // ── verify_crypto ──────────────────────────────────────────────────────────
    if (action === 'verify_crypto') {
      const { email, txHash, network } = body;
      if (!email || !txHash) return res.status(400).json({ error: 'Missing email or txHash' });

      // Check hash not already used
      const usedKey = `vnv_tx_used:${txHash}`;
      const used = await redis.get(usedKey);
      if (used) return res.status(400).json({ error: 'Transaction hash already used' });

      // Find pending record
      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
      const idx = pending.findIndex(p => p.email.toLowerCase() === email.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'No pending signup for this email' });

      // Store hash and submit for admin approval
      pending[idx].txHash = txHash;
      pending[idx].network = network || 'crypto';
      pending[idx].paymentMethod = 'crypto';
      await redis.set(PENDING_KEY, JSON.stringify(pending));

      return res.status(200).json({ ok: true, message: 'Payment submitted for verification' });
    }

    // ── get_pending (admin) ────────────────────────────────────────────────────
    if (action === 'get_pending') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
      const filtered = pending
        .filter(p => p.status === 'pending')
        .map(p => ({ ...p, password: undefined }));
      return res.status(200).json({ pending: filtered });
    }

    // ── approve (admin) ────────────────────────────────────────────────────────
    if (action === 'approve') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { targetEmail } = body;
      if (!targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });

      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
      const idx = pending.findIndex(p => p.email.toLowerCase() === targetEmail.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'Pending signup not found' });

      const record = pending[idx];

      // Add to users
      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      if (users.find(u => u.email.toLowerCase() === targetEmail.toLowerCase())) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Mark tx hash used
      if (record.txHash) {
        await redis.set(`vnv_tx_used:${record.txHash}`, '1', 'EX', 60 * 60 * 24 * 365);
      }

      const accessCode = genAccessCode();
      users.push({
        email: record.email,
        password: record.password,
        accessCode,
        codeAck: false,        // user must view & acknowledge their code on next login
        active: true,
        createdAt: Date.now()
      });

      await redis.set(USERS_KEY, JSON.stringify(users));
      await redis.set(coinKey(record.email), SIGNUP_COINS.toString());

      // Mark pending as approved
      pending[idx].status = 'approved';
      pending[idx].approvedAt = Date.now();
      await redis.set(PENDING_KEY, JSON.stringify(pending));

      return res.status(200).json({ ok: true, accessCode });
    }

    // ── reject (admin) ─────────────────────────────────────────────────────────
    if (action === 'reject') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { targetEmail } = body;
      if (!targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });

      const pendingRaw = await redis.get(PENDING_KEY);
      const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
      const filtered = pending.filter(p => p.email.toLowerCase() !== targetEmail.toLowerCase());
      await redis.set(PENDING_KEY, JSON.stringify(filtered));

      return res.status(200).json({ ok: true });
    }

    // ── get_access_code (logged-in user) ────────────────────────────────────────
    // Returns the access code ONLY if it has not yet been acknowledged.
    // Legacy users (codeAck undefined) are treated as already acknowledged.
    if (action === 'get_access_code') {
      const { email } = body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (user && user.codeAck === false && user.accessCode) {
        return res.status(200).json({ code: user.accessCode });
      }
      return res.status(200).json({ code: null });
    }

    // ── ack_code (logged-in user) ────────────────────────────────────────────────
    // Marks the access code as acknowledged so the lock screen never shows again.
    if (action === 'ack_code') {
      const { email } = body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase());
      if (idx === -1) return res.status(404).json({ error: 'User not found' });
      users[idx].codeAck = true;
      await redis.set(USERS_KEY, JSON.stringify(users));
      return res.status(200).json({ ok: true });
    }

    // ── view_access_code (logged-in user re-views their recovery code) ───────────
    // Safety net: lets a user retrieve their access code any time by re-confirming
    // their password, so they can save their recovery key before they ever get
    // locked out. Requires the user's own password (sent as userPassword, NOT the
    // admin `password` field), so only the account owner can see it.
    if (action === 'view_access_code') {
      const { email, userPassword } = body;
      if (!email || !userPassword) return res.status(400).json({ error: 'Email and password required' });
      const usersRaw = await redis.get(USERS_KEY);
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
      if (!user || user.password !== userPassword) {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }
      return res.status(200).json({ code: user.accessCode || null });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[signup]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
