import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PACKAGES_KEY = 'vnv_coin_packages';
const PENDING_TOPUPS_KEY = 'vnv_pending_topups';

// Keep in sync with api/coins.js
const DEFAULT_PACKAGES = [
  { id: 'pkg_starter',  coins: 720,  priceNaira: 16000,  priceUsd: 10,  label: 'Starter' },
  { id: 'pkg_standard', coins: 1680, priceNaira: 32000,  priceUsd: 20,  label: 'Standard' },
  { id: 'pkg_pro',      coins: 4560, priceNaira: 88000,  priceUsd: 55,  label: 'Pro', featured: true },
  { id: 'pkg_elite',    coins: 8400, priceNaira: 160000, priceUsd: 100, label: 'Elite' },
];

const coinKey = (email) => `vnv_coins:${email}`;

async function getPackages() {
  const raw = await redis.get(PACKAGES_KEY);
  return raw ? JSON.parse(raw) : DEFAULT_PACKAGES;
}

// ── Start a Paystack transaction. Amount is set here (server-side) from the
//    package price, so the client can't tamper with what gets charged.
async function initTransaction(email, packageId) {
  if (!SECRET) return { ok: false, error: 'Card payment is not set up yet.' };
  if (!email) return { ok: false, error: 'Missing email' };
  const pkgs = await getPackages();
  const pkg = pkgs.find(p => p.id === packageId);
  if (!pkg) return { ok: false, error: 'Invalid package' };

  const reference = 'vnv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let j;
  try {
    const r = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: Math.round(pkg.priceNaira * 100),   // Paystack bills in kobo
        currency: 'NGN',
        reference,
        // channels the popup offers — bank transfer is what the user asked for
        channels: ['card', 'bank', 'bank_transfer', 'ussd', 'qr'],
        metadata: { email, packageId, coins: pkg.coins, label: pkg.label },
      }),
    });
    j = await r.json();
  } catch (e) {
    return { ok: false, error: 'Could not reach Paystack. Try again.' };
  }
  if (!j || !j.status || !j.data) return { ok: false, error: (j && j.message) || 'Could not start payment' };
  return { ok: true, accessCode: j.data.access_code, reference: j.data.reference };
}

// ── Verify a reference with Paystack (the authoritative source of truth) and
//    credit coins exactly once. Safe to call from the browser AND the webhook:
//    crediting only happens for a genuinely successful charge, and the SET-NX
//    guard means a reference can never be credited twice.
async function verifyAndCredit(reference) {
  if (!SECRET) return { ok: false, error: 'Card payment is not set up yet.' };
  if (!reference) return { ok: false, error: 'Missing reference' };

  let j;
  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    j = await r.json();
  } catch (e) {
    return { ok: false, error: 'Could not verify payment. Try again.' };
  }
  if (!j || !j.status || !j.data) return { ok: false, error: 'Verification failed' };

  const d = j.data;
  if (d.status !== 'success') return { ok: false, error: 'Payment not completed', paymentStatus: d.status };

  const meta = d.metadata || {};
  const email = meta.email || (d.customer && d.customer.email);
  const packageId = meta.packageId;
  if (!email || !packageId) return { ok: false, error: 'Payment is missing account details' };

  const pkgs = await getPackages();
  const pkg = pkgs.find(p => p.id === packageId);
  if (!pkg) return { ok: false, error: 'Unknown package' };

  // The charge must be for at least the package price (belt-and-suspenders;
  // the amount was already fixed server-side at init).
  if (Number(d.amount) < Math.round(pkg.priceNaira * 100)) {
    return { ok: false, error: 'Amount paid is less than the package price' };
  }

  // Idempotency: first caller to claim this reference credits it; others no-op.
  const claim = await redis.set(`vnv_ps_used:${reference}`, '1', 'EX', 60 * 60 * 24 * 365, 'NX');
  if (claim === null) {
    const bal = parseFloat(await redis.get(coinKey(email))) || 0;
    return { ok: true, alreadyCredited: true, coins: pkg.coins, balance: bal };
  }

  const cur = parseFloat(await redis.get(coinKey(email))) || 0;
  const newBal = cur + pkg.coins;
  await redis.set(coinKey(email), newBal.toString());

  // Audit trail so the payment shows in the admin's history (as auto-approved).
  try {
    const raw = await redis.get(PENDING_TOPUPS_KEY);
    const topups = raw ? JSON.parse(raw) : [];
    topups.push({
      id: 'ps_' + reference,
      email, packageId, packageLabel: pkg.label,
      coins: pkg.coins, priceUsd: pkg.priceUsd, priceNaira: pkg.priceNaira,
      reference, network: 'paystack', status: 'approved', auto: true,
      createdAt: Date.now(), approvedAt: Date.now(),
    });
    await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups.slice(-1000)));
  } catch (_) {}

  return { ok: true, credited: true, coins: pkg.coins, balance: newBal };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-paystack-signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  try {
    // ── Webhook from Paystack (has an `event` field, no `action`) ──────────────
    // We take only the reference from the (untrusted) payload, then independently
    // re-verify it with Paystack's API before crediting — so a spoofed webhook
    // can never credit coins. Always answer 200 so Paystack stops retrying.
    if (body.event && !body.action) {
      if (body.event === 'charge.success') {
        const reference = body.data && body.data.reference;
        if (reference) { try { await verifyAndCredit(reference); } catch (_) {} }
      }
      return res.status(200).json({ received: true });
    }

    const { action } = body;

    if (action === 'config') {
      return res.status(200).json({ enabled: !!SECRET });
    }

    if (action === 'init') {
      const r = await initTransaction(body.email, body.packageId);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    if (action === 'verify') {
      const r = await verifyAndCredit(body.reference);
      return res.status(r.ok ? 200 : 400).json(r);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[paystack]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
