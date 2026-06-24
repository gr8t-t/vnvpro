// ══════════════════════════════════════════════════════════════
//  VNV Pro — VOICE 2.0 SLOT + WAITLIST MANAGER
//  Endpoint: /api/voice2
//  Single premium slot, waitlist with 5-min claim window,
//  and a Voice 1.0 concurrency cap that only applies while
//  Voice 2.0 is in use. All state in Redis (vnv_ prefix).
// ══════════════════════════════════════════════════════════════

import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

const HOLDER_KEY = 'vnv_v2_holder';     // JSON {email} with TTL — presence = busy
const QUEUE_KEY  = 'vnv_v2_queue';      // JSON array of emails (waitlist order)
const TURN_KEY   = 'vnv_v2_turn';       // JSON {email, assignedAt} — whose turn to claim
const V1_ACTIVE  = 'vnv_v1_active';     // ZSET: member=email, score=last heartbeat ms

const HOLDER_TTL_SEC   = 30;            // slot frees if no heartbeat for this long
const TURN_WINDOW_MS   = 5 * 60 * 1000; // 5 minutes to claim your turn
const V1_CAP_WHEN_V2   = 5;             // max Voice 1.0 users while Voice 2.0 is active
const V1_ACTIVE_TTL_MS = 30 * 1000;     // a 1.0 user counts as active for this long per heartbeat

async function getHolder() {
  const raw = await redis.get(HOLDER_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function getQueue() {
  const raw = await redis.get(QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function setQueue(q) { await redis.set(QUEUE_KEY, JSON.stringify(q)); }
async function getTurn() {
  const raw = await redis.get(TURN_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function setTurn(t) { await redis.set(TURN_KEY, JSON.stringify(t)); }
async function clearTurn() { await redis.del(TURN_KEY); }

// Lazily advance the waitlist: handle expired turns and promote the next person.
async function resolve() {
  const holder = await getHolder();
  if (holder) return; // someone is streaming; nothing to promote

  let queue = await getQueue();
  let turn = await getTurn();

  if (turn) {
    if (Date.now() - turn.assignedAt > TURN_WINDOW_MS) {
      // they didn't claim in time — drop them and move on
      queue = queue.filter(e => e !== turn.email);
      await setQueue(queue);
      await clearTurn();
      turn = null;
    } else {
      return; // valid turn in progress
    }
  }

  if (!turn && queue.length > 0) {
    await setTurn({ email: queue[0], assignedAt: Date.now() });
  }
}

async function statusFor(email) {
  await resolve();
  const holder = await getHolder();
  const queue = await getQueue();
  const turn = await getTurn();

  if (holder && holder.email === email) return { state: 'active', queueLen: queue.length };
  if (!holder && turn && turn.email === email) {
    const secondsLeft = Math.max(0, Math.round((TURN_WINDOW_MS - (Date.now() - turn.assignedAt)) / 1000));
    return { state: 'your_turn', secondsLeft, queueLen: queue.length };
  }
  const idx = queue.indexOf(email);
  if (idx !== -1) return { state: 'queued', position: idx + 1, queueLen: queue.length };
  if (!holder && !turn && queue.length === 0) return { state: 'available', queueLen: 0 };
  return { state: 'busy', queueLen: queue.length };
}

async function addToQueue(email) {
  const q = await getQueue();
  if (!q.includes(email)) { q.push(email); await setQueue(q); }
}
async function removeFromQueue(email) {
  const q = await getQueue();
  const f = q.filter(e => e !== email);
  if (f.length !== q.length) await setQueue(f);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email } = req.body || {};
  if (!action) return res.status(400).json({ error: 'Missing action' });
  if (!email)  return res.status(400).json({ error: 'Missing email' });

  try {
    // ── Voice 2.0 slot ────────────────────────────────────────────────────────
    if (action === 'v2_status') {
      return res.status(200).json(await statusFor(email));
    }

    if (action === 'v2_acquire') {
      const holder = await getHolder();
      if (holder) {
        if (holder.email === email) {
          await redis.set(HOLDER_KEY, JSON.stringify({ email }), 'EX', HOLDER_TTL_SEC);
          return res.status(200).json({ ok: true, state: 'active' });
        }
        await addToQueue(email);
        return res.status(200).json({ ok: false, ...(await statusFor(email)) });
      }
      // no holder — can this email take it?
      await resolve();
      const turn = await getTurn();
      const queue = await getQueue();
      const mayTake = (!turn && (queue.length === 0 || queue[0] === email)) ||
                      (turn && turn.email === email);
      if (mayTake) {
        await redis.set(HOLDER_KEY, JSON.stringify({ email }), 'EX', HOLDER_TTL_SEC);
        await clearTurn();
        await removeFromQueue(email);
        return res.status(200).json({ ok: true, state: 'active' });
      }
      await addToQueue(email);
      return res.status(200).json({ ok: false, ...(await statusFor(email)) });
    }

    if (action === 'v2_heartbeat') {
      const holder = await getHolder();
      if (holder && holder.email === email) {
        await redis.set(HOLDER_KEY, JSON.stringify({ email }), 'EX', HOLDER_TTL_SEC);
        return res.status(200).json({ ok: true });
      }
      return res.status(200).json({ ok: false, lost: true });
    }

    if (action === 'v2_release') {
      const holder = await getHolder();
      if (holder && holder.email === email) await redis.del(HOLDER_KEY);
      await removeFromQueue(email);
      await resolve();
      return res.status(200).json({ ok: true });
    }

    if (action === 'v2_join_queue') {
      await addToQueue(email);
      return res.status(200).json(await statusFor(email));
    }

    if (action === 'v2_leave_queue') {
      const turn = await getTurn();
      if (turn && turn.email === email) await clearTurn();
      await removeFromQueue(email);
      await resolve();
      return res.status(200).json({ ok: true });
    }

    // ── Voice 1.0 concurrency cap ───────────────────────────────────────────────
    if (action === 'v1_can_start') {
      await redis.zremrangebyscore(V1_ACTIVE, 0, Date.now() - V1_ACTIVE_TTL_MS);
      const holder = await getHolder();
      if (!holder) return res.status(200).json({ allowed: true });   // V2 idle → unlimited
      const already = await redis.zscore(V1_ACTIVE, email);
      if (already !== null) return res.status(200).json({ allowed: true }); // already counted
      const count = await redis.zcard(V1_ACTIVE);
      if (count >= V1_CAP_WHEN_V2) {
        return res.status(200).json({ allowed: false, reason: 'busy' });
      }
      return res.status(200).json({ allowed: true });
    }

    if (action === 'v1_heartbeat') {
      await redis.zadd(V1_ACTIVE, Date.now(), email);
      return res.status(200).json({ ok: true });
    }

    if (action === 'v1_stop') {
      await redis.zrem(V1_ACTIVE, email);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[voice2]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
