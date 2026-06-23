import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const RATES_KEY = 'vnv_drain_rates';
const PACKAGES_KEY = 'vnv_coin_packages';
const PENDING_TOPUPS_KEY = 'vnv_pending_topups';

const DEFAULT_RATES = { video: 2.0, audio: 0.5, both: 2.5 };

const DEFAULT_PACKAGES = [
  { id: 'pkg_starter',  coins: 720,  priceNaira: 16000,  priceUsd: 10,  label: 'Starter' },
  { id: 'pkg_standard', coins: 1680, priceNaira: 32000,  priceUsd: 20,  label: 'Standard' },
  { id: 'pkg_pro',      coins: 4560, priceNaira: 88000,  priceUsd: 55,  label: 'Pro', featured: true },
  { id: 'pkg_elite',    coins: 8400, priceNaira: 160000, priceUsd: 100, label: 'Elite' },
];

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

async function getRates() {
  const raw = await redis.get(RATES_KEY);
  return raw ? { ...DEFAULT_RATES, ...JSON.parse(raw) } : { ...DEFAULT_RATES };
}

async function getPackages() {
  const raw = await redis.get(PACKAGES_KEY);
  return raw ? JSON.parse(raw) : DEFAULT_PACKAGES;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { action, email, password } = body;

  if (!action) return res.status(400).json({ error: 'Missing action' });

  const isAdmin = password === ADMIN_PASSWORD;

  try {

    // ── balance ────────────────────────────────────────────────────────────────
    if (action === 'balance') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const bal = await getBalance(email);
      return res.status(200).json({ balance: bal });
    }

    // ── drain ──────────────────────────────────────────────────────────────────
    if (action === 'drain') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const seconds = parseFloat(body.seconds) || 1;
      const mode = body.mode || 'video';

      const rates = await getRates();
      const rate = rates[mode] ?? rates.video;
      const cost = rate * seconds;

      const bal = await getBalance(email);
      if (bal <= 0) {
        return res.status(402).json({ error: 'Insufficient coins', balance: 0 });
      }

      const newBal = Math.max(0, bal - cost);
      await setBalance(email, newBal);
      return res.status(200).json({ ok: true, balance: newBal, drained: cost });
    }

    // ── topup (submit payment) ─────────────────────────────────────────────────
    if (action === 'topup') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const { packageId, txHash, network } = body;
      if (!packageId) return res.status(400).json({ error: 'Missing packageId' });
      if (!txHash) return res.status(400).json({ error: 'Missing transaction hash' });

      const pkgs = await getPackages();
      const pkg = pkgs.find(p => p.id === packageId);
      if (!pkg) return res.status(400).json({ error: 'Invalid package' });

      // Check hash not already used
      const usedKey = `vnv_tx_used:${txHash}`;
      const used = await redis.get(usedKey);
      if (used) return res.status(400).json({ error: 'Transaction hash already used' });

      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];

      // Check not already submitted
      const exists = topups.find(t => t.txHash === txHash);
      if (exists) return res.status(400).json({ error: 'Transaction already submitted' });

      const topupId = 'top_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      topups.push({
        id: topupId,
        email,
        packageId,
        packageLabel: pkg.label,
        coins: pkg.coins,
        priceUsd: pkg.priceUsd,
        txHash,
        network: network || 'unknown',
        status: 'pending',
        createdAt: Date.now()
      });

      await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));
      return res.status(200).json({ ok: true, message: 'Payment submitted for verification' });
    }

    // ── bank_request ───────────────────────────────────────────────────────────
    if (action === 'bank_request') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const { packageId, senderName, transferRef } = body;
      if (!packageId) return res.status(400).json({ error: 'Missing packageId' });

      const pkgs = await getPackages();
      const pkg = pkgs.find(p => p.id === packageId);
      if (!pkg) return res.status(400).json({ error: 'Invalid package' });

      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];

      const topupId = 'top_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      topups.push({
        id: topupId,
        email,
        packageId,
        packageLabel: pkg.label,
        coins: pkg.coins,
        priceUsd: pkg.priceUsd,
        senderName: senderName || '',
        transferRef: transferRef || '',
        network: 'bank',
        status: 'pending',
        createdAt: Date.now()
      });

      await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));
      return res.status(200).json({ ok: true });
    }

    // ── get_pending_topups (admin) ─────────────────────────────────────────────
    if (action === 'get_pending_topups') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];
      const pendingOnly = topups.filter(t => t.status === 'pending');
      return res.status(200).json({ topups: pendingOnly });
    }

    // ── approve_topup (admin) ──────────────────────────────────────────────────
    if (action === 'approve_topup') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { topupId } = body;
      if (!topupId) return res.status(400).json({ error: 'Missing topupId' });

      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];
      const idx = topups.findIndex(t => t.id === topupId);
      if (idx === -1) return res.status(404).json({ error: 'Topup not found' });

      const topup = topups[idx];
      if (topup.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

      // Mark tx hash used
      if (topup.txHash) {
        await redis.set(`vnv_tx_used:${topup.txHash}`, '1', 'EX', 60 * 60 * 24 * 365);
      }

      // Credit coins
      const bal = await getBalance(topup.email);
      const newBal = bal + topup.coins;
      await setBalance(topup.email, newBal);

      topups[idx].status = 'approved';
      topups[idx].approvedAt = Date.now();
      await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));

      return res.status(200).json({ ok: true, balance: newBal });
    }

    // ── reject_topup (admin) ───────────────────────────────────────────────────
    if (action === 'reject_topup') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { topupId } = body;
      if (!topupId) return res.status(400).json({ error: 'Missing topupId' });

      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];
      const idx = topups.findIndex(t => t.id === topupId);
      if (idx === -1) return res.status(404).json({ error: 'Topup not found' });

      topups[idx].status = 'rejected';
      topups[idx].rejectedAt = Date.now();
      await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));
      return res.status(200).json({ ok: true });
    }

    // ── get_rates ──────────────────────────────────────────────────────────────
    if (action === 'get_rates') {
      const rates = await getRates();
      return res.status(200).json({ rates });
    }

    // ── set_rates (admin) ──────────────────────────────────────────────────────
    if (action === 'set_rates') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const existing = await getRates();
      const updated = { ...existing, ...(body.rates || {}) };
      await redis.set(RATES_KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true, rates: updated });
    }

    // ── get_packages ───────────────────────────────────────────────────────────
    if (action === 'get_packages') {
      const pkgs = await getPackages();
      return res.status(200).json({ packages: pkgs });
    }

    // ── set_packages (admin) ───────────────────────────────────────────────────
    if (action === 'set_packages') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const packages = body.packages;
      if (!Array.isArray(packages)) return res.status(400).json({ error: 'packages must be array' });
      await redis.set(PACKAGES_KEY, JSON.stringify(packages));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('[coins]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
