import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const RATES_KEY = 'vnv_drain_rates';
const PACKAGES_KEY = 'vnv_coin_packages';
const PENDING_TOPUPS_KEY = 'vnv_pending_topups';
const USERS_KEY = 'vnv_users';

// edit = Video Editor (async Lucy Edit): Decart bills $0.04/sec of output video
// (2x the realtime $0.02/sec), so 6 coins/sec keeps the same margin as video@3.
const DEFAULT_RATES = { video: 2.0, audio: 0.5, both: 2.5, record: 0.3, audio2: 1.0, both2: 3.5, edit: 6.0 };

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

// ── usage analytics ───────────────────────────────────────────────────────────
// Every drain is logged into per-day hashes keyed by hour+feature, so we can chart
// daily/weekly/monthly totals, time-of-day, and what consumed the coins. Buckets
// are in WAT (UTC+1, Lagos — no DST) so "day"/"hour" match the operator's clock.
const USAGE_TTL = 60 * 60 * 24 * 100;   // keep ~100 days of history, then auto-expire

function watParts(ts) {
  const d = new Date(ts + 60 * 60 * 1000);           // shift to WAT then read UTC fields
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

async function logUsage(email, mode, coins, seconds) {
  if (!(coins > 0)) return;                           // nothing actually spent
  const { day, hour } = watParts(Date.now());
  const field = `${hour}:${mode}`;
  const uk = `vnv_usage:${email}:${day}`;
  const ak = `vnv_usage:_all:${day}`;
  const p = redis.pipeline();
  p.hincrbyfloat(uk, field, coins);
  p.hincrbyfloat(uk, field + ':s', seconds || 0);
  p.expire(uk, USAGE_TTL);
  p.hincrbyfloat(ak, field, coins);
  p.hincrbyfloat(ak, field + ':s', seconds || 0);
  p.expire(ak, USAGE_TTL);
  try { await p.exec(); } catch (_) {}
}

// Read `days` worth of usage for a prefix (`vnv_usage:<email>` or `vnv_usage:_all`),
// aggregated for charting: per-day-by-feature, per-hour (time of day), per-feature.
async function readUsage(prefix, days) {
  const nowWat = new Date(Date.now() + 60 * 60 * 1000);
  const dayList = [];
  const p = redis.pipeline();
  for (let i = days - 1; i >= 0; i--) {
    const ds = new Date(nowWat.getTime() - i * 86400000).toISOString().slice(0, 10);
    dayList.push(ds);
    p.hgetall(`${prefix}:${ds}`);
  }
  const rows = await p.exec();
  const byDay = {};       // date -> { mode -> coins }
  const byHour = {};      // "0".."23" -> coins
  const byFeature = {};   // mode -> coins (window total)
  dayList.forEach((ds, i) => {
    const hash = (rows[i] && rows[i][1]) || {};
    const feat = {};
    for (const [f, v] of Object.entries(hash)) {
      if (f.endsWith(':s')) continue;                 // seconds field — not coins
      const sep = f.indexOf(':');
      const hourStr = f.slice(0, sep);
      const mode = f.slice(sep + 1);
      const c = parseFloat(v) || 0;
      feat[mode] = (feat[mode] || 0) + c;
      byFeature[mode] = (byFeature[mode] || 0) + c;
      byHour[hourStr] = (byHour[hourStr] || 0) + c;
    }
    byDay[ds] = feat;
  });
  return { dayList, byDay, byHour, byFeature };
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
      // Setup Mode availability: default ON for new users; admin can disable per-user
      // (stored as setupMode:false on the user record in vnv_users).
      let setupMode = true;
      try {
        const raw = await redis.get(USERS_KEY);
        const users = raw ? JSON.parse(raw) : [];
        const u = users.find(x => x.email === email);
        if (u && u.setupMode === false) setupMode = false;
      } catch (_) {}
      return res.status(200).json({ balance: bal, setupMode });
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
      await logUsage(email, mode, bal - newBal, seconds);   // record actual coins spent for analytics
      return res.status(200).json({ ok: true, balance: newBal, drained: cost });
    }

    // ── usage (analytics: user's own, or admin platform / per-user) ─────────────
    if (action === 'usage') {
      let prefix, balEmail = null;
      if (isAdmin && body.scope) {
        if (body.scope === 'all') {
          prefix = 'vnv_usage:_all';                 // platform-wide totals
        } else {
          if (!body.targetEmail) return res.status(400).json({ error: 'Missing targetEmail' });
          prefix = `vnv_usage:${body.targetEmail}`;
          balEmail = body.targetEmail;
        }
      } else {
        if (!email) return res.status(400).json({ error: 'Missing email' });
        prefix = `vnv_usage:${email}`;               // the logged-in user's own usage
        balEmail = email;
      }
      const days = Math.min(120, Math.max(1, parseInt(body.days) || 92));
      const data = await readUsage(prefix, days);
      const balance = balEmail ? await getBalance(balEmail) : null;
      return res.status(200).json({ ...data, balance });
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
