import Redis from 'ioredis';
import crypto from 'crypto';

const redis = new Redis(process.env.REDIS_URL);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '09130370801Maviegr8@';
const RATES_KEY = 'vnv_drain_rates';
const PACKAGES_KEY = 'vnv_coin_packages';
const PENDING_TOPUPS_KEY = 'vnv_pending_topups';
const USERS_KEY = 'vnv_users';
const BANK_KEY = 'vnv_bank_details';                 // set by admin.js — the account users pay into
const RECEIPT_SETTINGS_KEY = 'vnv_receipt_settings';

// Receipt auto-verification. ocrKey defaults to OCR.space's free demo key so the
// feature works out of the box; the operator can drop in their own free key
// (ocr.space, 25k scans/mo) from the admin panel. dateWindowDays: a receipt older
// than this is treated as stale. autoMaxNaira: packages at/under this price can be
// credited automatically; anything above always waits for manual approval.
// verifyName: the FULL registered account name (all names) used only to match
// receipts — never shown to users. Leave it blank to just use the public account
// name. Trick: show users only two of your names; put all three here, and a faked
// receipt that only carries the two public names fails the name check.
const DEFAULT_RECEIPT_SETTINGS = { ocrKey: 'helloworld', dateWindowDays: 3, autoMaxNaira: 32000, verifyName: '' };

// edit = Video Editor (async Lucy Edit): Decart bills $0.04/sec of output video
// (2x the realtime $0.02/sec), so 6 coins/sec keeps the same margin as video@3.
const DEFAULT_RATES = { video: 2.0, audio: 0.5, both: 2.5, record: 0.3, audio2: 1.0, both2: 3.5, edit: 6.0 };

const DEFAULT_PACKAGES = [
  { id: 'pkg_starter',  coins: 900,  priceNaira: 16000,  priceUsd: 10,  label: 'Starter' },
  { id: 'pkg_standard', coins: 1800, priceNaira: 32000,  priceUsd: 20,  label: 'Standard' },
  { id: 'pkg_pro',      coins: 5000, priceNaira: 88000,  priceUsd: 55,  label: 'Pro', featured: true },
  { id: 'pkg_elite',    coins: 9000, priceNaira: 160000, priceUsd: 100, label: 'Elite' },
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

async function getReceiptSettings() {
  const raw = await redis.get(RECEIPT_SETTINGS_KEY);
  return raw ? { ...DEFAULT_RECEIPT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_RECEIPT_SETTINGS };
}

// The account the receipt must have been paid INTO = the same bank account the
// admin already shows users on the Bank tab (vnv_bank_details). No separate setup.
async function getBankTarget() {
  try {
    const raw = await redis.get(BANK_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

// ── receipt OCR + verification helpers ─────────────────────────────────────────
// Send the uploaded receipt (a data: URL) to OCR.space and get back its text.
async function ocrReceipt(dataUrl, ocrKey) {
  const params = new URLSearchParams();
  params.append('apikey', ocrKey || 'helloworld');
  params.append('base64Image', dataUrl);
  params.append('OCREngine', '2');     // engine 2 reads receipts / mixed layouts best
  params.append('scale', 'true');
  params.append('detectOrientation', 'true');
  const r = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (j.IsErroredOnProcessing) {
    const msg = Array.isArray(j.ErrorMessage) ? j.ErrorMessage.join('; ') : (j.ErrorMessage || 'OCR failed');
    throw new Error(msg);
  }
  const text = (j.ParsedResults || []).map(p => p.ParsedText || '').join('\n');
  return text || '';
}

// Regex that matches a Naira amount with optional thousands separator / decimals,
// e.g. 16000 → "16,000", "16000", "16 000", "₦16,000.00" (but NOT 116000 or 160000).
function buildAmountRegex(naira) {
  const d = String(Math.round(naira));
  if (d.length <= 3) return new RegExp('(?<!\\d)' + d + '(?:\\.\\d{2})?(?!\\d)');
  const head = d.slice(0, d.length - 3);
  const tail = d.slice(d.length - 3);
  return new RegExp('(?<!\\d)' + head + '[\\s,.]?' + tail + '(?:\\.\\d{2})?(?!\\d)');
}

function normName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Best-effort: pull a date out of the OCR text and decide if it's older than the window.
// Returns { found, old }. If no date is confidently parsed, old=false (we don't block).
function checkReceiptDate(text, windowDays) {
  const now = Date.now();
  const maxAgeMs = (windowDays || 3) * 86400000;
  const candidates = [];
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  let m;
  // ISO  2026-10-17  /  2026/10/17
  const reIso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = reIso.exec(text))) candidates.push(new Date(+m[1], +m[2]-1, +m[3]));
  // DMY  17-10-2026  /  17/10/2026   (also matches MDY; both land within a day or two)
  const reDmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/g;
  while ((m = reDmy.exec(text))) candidates.push(new Date(+m[3], +m[2]-1, +m[1]));
  // 17 Oct 2026  /  17-Oct-2026
  const reDmon = /\b(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-,\s]+(20\d{2})\b/g;
  while ((m = reDmon.exec(text))) { const mi = months[m[2].toLowerCase()]; if (mi != null) candidates.push(new Date(+m[3], mi, +m[1])); }
  // Oct 17, 2026
  const reMonD = /\b([A-Za-z]{3})[a-z]*[-\s](\d{1,2})[-,\s]+(20\d{2})\b/g;
  while ((m = reMonD.exec(text))) { const mi = months[m[1].toLowerCase()]; if (mi != null) candidates.push(new Date(+m[3], mi, +m[2])); }

  const valid = candidates.filter(d => d instanceof Date && !isNaN(d) && d.getTime() <= now + 2*86400000);
  if (valid.length === 0) return { found: false, old: false };
  // Use the most recent plausible date on the receipt.
  const newest = Math.max(...valid.map(d => d.getTime()));
  return { found: true, old: (now - newest) > maxAgeMs };
}

// Pull a transaction reference / session id for dedup (best-effort).
function extractRef(text) {
  const re = /(?:transaction\s*(?:ref(?:erence)?|id|no)|reference(?:\s*(?:no|number))?|session\s*id|ref\s*no|rrn|receipt\s*(?:no|id))\s*[:#-]?\s*([A-Za-z0-9]{6,})/i;
  const m = re.exec(text);
  return m ? m[1].toUpperCase() : '';
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
      let forceStop = false;
      try { forceStop = !!(await redis.get('vnv_force_stop:' + email)); } catch (_) {}
      // Studio = user runs the voice engine on their OWN GPU (self-serve toggle).
      let studio = false;
      try { studio = !!(await redis.get('vnv_studio:' + email)); } catch (_) {}
      return res.status(200).json({ balance: bal, setupMode, forceStop, studio });
    }

    // ── drain ──────────────────────────────────────────────────────────────────
    if (action === 'drain') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const seconds = parseFloat(body.seconds) || 1;
      const mode = body.mode || 'video';

      const rates = await getRates();
      // Studio users run voice on their own GPU → charge only the Decart (video/edit)
      // part; voice-only modes are free. Read server-side so it can't be faked.
      let studio = false;
      try { studio = !!(await redis.get('vnv_studio:' + email)); } catch (_) {}
      let cost;
      if (studio) {
        if (mode === 'edit') cost = (rates.edit ?? 6.0) * seconds;
        else if (mode === 'video' || mode === 'both' || mode === 'both2') cost = (rates.video ?? 2.0) * seconds;
        else cost = 0;   // audio / audio2 / record → free for Studio
      } else {
        const rate = rates[mode] ?? rates.video;
        cost = rate * seconds;
      }

      const bal = await getBalance(email);
      if (cost > 0 && bal <= 0) {
        return res.status(402).json({ error: 'Insufficient coins', balance: 0 });
      }

      const newBal = Math.max(0, bal - cost);
      await setBalance(email, newBal);
      await logUsage(email, mode, bal - newBal, seconds);   // record actual coins spent for analytics
      return res.status(200).json({ ok: true, balance: newBal, drained: cost });
    }

    // ── set_studio (self-serve: user turns their own-GPU voice mode on/off) ──────
    if (action === 'set_studio') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const on = !!body.on;
      if (on) await redis.set('vnv_studio:' + email, '1');
      else await redis.del('vnv_studio:' + email);
      return res.status(200).json({ ok: true, studio: on });
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

    // ── receipt_verify (user uploads a payment receipt; auto-credit or queue) ───
    // The user only ever "uploads an image". Behind the scenes we OCR it and run
    // four silent checks — right amount, paid into OUR account, a success marker,
    // and a recent date — plus dedup. For packages at/under autoMaxNaira that all
    // pass, coins are credited instantly and the image is discarded. Anything
    // above the cap, or anything that doesn't cleanly pass, is queued for the
    // operator to approve (the image is kept with a short TTL for that review).
    if (action === 'receipt_verify') {
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const { packageId, imageBase64 } = body;
      if (!packageId) return res.status(400).json({ error: 'Missing packageId' });
      if (!imageBase64 || typeof imageBase64 !== 'string' || !imageBase64.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Please upload a valid image' });
      }

      const pkgs = await getPackages();
      const pkg = pkgs.find(p => p.id === packageId);
      if (!pkg) return res.status(400).json({ error: 'Invalid package' });

      const settings = await getReceiptSettings();
      const bank = await getBankTarget();

      // Dedup key from the image bytes — the exact same screenshot can't be reused.
      const b64 = imageBase64.slice(imageBase64.indexOf(',') + 1);
      const imgHash = crypto.createHash('sha256').update(b64).digest('hex').slice(0, 24);
      const usedImg = await redis.get('vnv_receipt_used:' + imgHash);
      if (usedImg) return res.status(400).json({ error: 'This receipt has already been used.' });

      // OCR (best-effort — any failure just routes to manual review, never errors out).
      let text = '', ocrError = '';
      try {
        text = await ocrReceipt(imageBase64, settings.ocrKey);
      } catch (e) { ocrError = String(e.message || e).slice(0, 160); }

      // Normalise: join digit groups split by single spaces/dashes so "0123 456 789"
      // and "16 000" read as one number.
      const textJoined = text.replace(/(?<=\d)[ \-](?=\d)/g, '');

      const amountOk = buildAmountRegex(pkg.priceNaira).test(textJoined);

      const acctNum = String(bank.accountNumber || '').replace(/\D/g, '');
      const acctNumOk = acctNum.length >= 6 && new RegExp('(?<!\\d)' + acctNum + '(?!\\d)').test(textJoined);
      // Match the FULL name (hidden verifyName if set, else the public account name).
      // Every configured identifier must appear — so a fake carrying only the public
      // names (missing the hidden one) fails, and a transfer to the wrong number fails.
      const nameTarget = (settings.verifyName && settings.verifyName.trim()) ? settings.verifyName : bank.accountName;
      const nameTokens = normName(nameTarget).split(' ').filter(t => t.length >= 3);
      const normText = normName(text);
      const acctNameOk = nameTokens.length > 0 && nameTokens.every(t => normText.includes(t));
      const numConfigured = acctNum.length >= 6;
      const nameConfigured = nameTokens.length > 0;
      const acctConfigured = numConfigured || nameConfigured;
      const recipientOk = acctConfigured && (!nameConfigured || acctNameOk) && (!numConfigured || acctNumOk);

      const statusOk = /\b(success|successful|completed|approved|paid|sent|credit(?:ed)?)\b/i.test(text);
      const dateChk = checkReceiptDate(text, settings.dateWindowDays);
      const ref = extractRef(text);

      if (ref) {
        const usedRef = await redis.get('vnv_receipt_used:ref:' + ref);
        if (usedRef) return res.status(400).json({ error: 'This receipt has already been used.' });
      }

      const checks = {
        amountOk, recipientOk, statusOk,
        dateOld: dateChk.old, dateFound: dateChk.found,
        acctNumOk, acctNameOk, ref, ocrError,
      };
      const allPass = amountOk && recipientOk && statusOk && !dateChk.old && acctConfigured && !ocrError;
      const underAutoTier = pkg.priceNaira <= (settings.autoMaxNaira ?? 32000);

      // ── auto-credit path ──
      if (underAutoTier && allPass) {
        const bal = await getBalance(email);
        const newBal = bal + pkg.coins;
        await setBalance(email, newBal);
        await redis.set('vnv_receipt_used:' + imgHash, '1', 'EX', 60 * 60 * 24 * 365);
        if (ref) await redis.set('vnv_receipt_used:ref:' + ref, '1', 'EX', 60 * 60 * 24 * 365);
        // log an audit record of the auto-approval (image NOT kept)
        try {
          const pending = await redis.get(PENDING_TOPUPS_KEY);
          const topups = pending ? JSON.parse(pending) : [];
          topups.push({
            id: 'top_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            email, packageId, packageLabel: pkg.label, coins: pkg.coins,
            priceUsd: pkg.priceUsd, priceNaira: pkg.priceNaira, network: 'receipt',
            method: 'receipt', status: 'approved', auto: true, checks,
            createdAt: Date.now(), approvedAt: Date.now(),
          });
          await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));
        } catch (_) {}
        return res.status(200).json({ ok: true, approved: true, coins: pkg.coins, balance: newBal });
      }

      // ── manual-review path ── (store image with a short TTL for the operator)
      const pending = await redis.get(PENDING_TOPUPS_KEY);
      const topups = pending ? JSON.parse(pending) : [];
      // Don't create a duplicate pending record for the same image still awaiting review.
      const dup = topups.find(t => t.imgHash === imgHash && t.status === 'pending');
      if (!dup) {
        const topupId = 'top_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const reason = pkg.priceNaira > (settings.autoMaxNaira ?? 32000)
          ? 'Large package — manual approval required'
          : 'Auto-check needs review: ' + [
              !amountOk && 'amount', !recipientOk && 'recipient', !statusOk && 'status',
              dateChk.old && 'old date', ocrError && 'unreadable',
            ].filter(Boolean).join(', ');
        topups.push({
          id: topupId, email, packageId, packageLabel: pkg.label, coins: pkg.coins,
          priceUsd: pkg.priceUsd, priceNaira: pkg.priceNaira, network: 'receipt',
          method: 'receipt', status: 'pending', auto: false, checks, reason,
          imgHash, hasReceipt: true, ref: ref || '', createdAt: Date.now(),
        });
        await redis.set(PENDING_TOPUPS_KEY, JSON.stringify(topups));
        // keep the image for review for 7 days, then it auto-deletes (frees space)
        await redis.set('vnv_receipt_img:' + topupId, imageBase64, 'EX', 60 * 60 * 24 * 7);
      }
      return res.status(200).json({ ok: true, approved: false, pending: true });
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
      // Receipt top-up: lock this receipt so it can't be reused, and drop the image.
      if (topup.method === 'receipt') {
        if (topup.imgHash) await redis.set('vnv_receipt_used:' + topup.imgHash, '1', 'EX', 60 * 60 * 24 * 365);
        if (topup.ref) await redis.set('vnv_receipt_used:ref:' + topup.ref, '1', 'EX', 60 * 60 * 24 * 365);
        await redis.del('vnv_receipt_img:' + topup.id);
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
      if (topups[idx].method === 'receipt') await redis.del('vnv_receipt_img:' + topups[idx].id);
      return res.status(200).json({ ok: true });
    }

    // ── get_receipt_image (admin: view a pending receipt during review) ─────────
    if (action === 'get_receipt_image') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const { topupId } = body;
      if (!topupId) return res.status(400).json({ error: 'Missing topupId' });
      const img = await redis.get('vnv_receipt_img:' + topupId);
      if (!img) return res.status(404).json({ error: 'Receipt image not available (expired or already processed)' });
      return res.status(200).json({ image: img });
    }

    // ── get_receipt_settings (admin) ───────────────────────────────────────────
    if (action === 'get_receipt_settings') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const settings = await getReceiptSettings();
      const bank = await getBankTarget();
      return res.status(200).json({
        settings,
        target: {
          accountName: bank.accountName || '',
          accountNumber: bank.accountNumber || '',
          bankName: bank.bankName || '',
          matchName: (settings.verifyName && settings.verifyName.trim()) ? settings.verifyName : (bank.accountName || ''),
        },
      });
    }

    // ── set_receipt_settings (admin) ───────────────────────────────────────────
    if (action === 'set_receipt_settings') {
      if (!isAdmin) return res.status(403).json({ error: 'Unauthorized' });
      const existing = await getReceiptSettings();
      const incoming = body.settings || {};
      const updated = {
        ocrKey: (incoming.ocrKey != null ? String(incoming.ocrKey).trim() : existing.ocrKey) || 'helloworld',
        dateWindowDays: Math.max(1, parseInt(incoming.dateWindowDays) || existing.dateWindowDays),
        autoMaxNaira: Math.max(0, parseInt(incoming.autoMaxNaira) || existing.autoMaxNaira),
        verifyName: (incoming.verifyName != null ? String(incoming.verifyName).trim() : (existing.verifyName || '')),
      };
      await redis.set(RECEIPT_SETTINGS_KEY, JSON.stringify(updated));
      return res.status(200).json({ ok: true, settings: updated });
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
