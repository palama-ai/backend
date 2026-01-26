const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

// Lightweight events API used by frontend to report page views and session heartbeats.

// SECURITY: Simple rate limiting to prevent spam
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_EVENTS_PER_MINUTE = 30; // Max events per IP per minute

function checkEventsRateLimit(ip) {
  const now = Date.now();
  const key = `events:${ip}`;
  const record = rateLimitMap.get(key);

  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { startTime: now, count: 1 });
    return true;
  }

  if (record.count >= MAX_EVENTS_PER_MINUTE) {
    return false;
  }

  record.count++;
  return true;
}

// Start or upsert a session: returns session_id
router.post('/start', async (req, res) => {
  try {
    // Rate limit check
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkEventsRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { sessionId, userId, path } = req.body || {};
    const sid = sessionId || uuidv4();
    const now = new Date().toISOString();
    // insert or replace session record
    await sql`
      INSERT INTO site_sessions (session_id, user_id, path, started_at, last_ping_at, updated_at) 
      VALUES (${sid}, ${userId || null}, ${path || null}, ${now}, ${now}, ${now})
      ON CONFLICT (session_id) DO UPDATE SET last_ping_at = ${now}, path = ${path || null}, updated_at = ${now}
    `;
    res.json({ data: { sessionId: sid } });
  } catch (e) {
    console.error('[events] start error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Ping/heartbeat to mark session as active
router.post('/ping', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkEventsRateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

    const { sessionId, userId, path } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const now = new Date().toISOString();
    const infoResult = await sql`SELECT session_id FROM site_sessions WHERE session_id = ${sessionId}`;
    const info = infoResult && infoResult.length > 0 ? infoResult[0] : null;
    if (info) {
      await sql`UPDATE site_sessions SET last_ping_at = ${now}, path = ${path || null}, updated_at = ${now} WHERE session_id = ${sessionId}`;
    } else {
      await sql`INSERT INTO site_sessions (session_id, user_id, path, started_at, last_ping_at, updated_at) VALUES (${sessionId}, ${userId || null}, ${path || null}, ${now}, ${now}, ${now})`;
    }
    res.json({ data: { ok: true } });
  } catch (e) {
    console.error('[events] ping error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to ping session' });
  }
});

// End a session and optionally record duration (seconds)
router.post('/end', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkEventsRateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

    const { sessionId, duration } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const now = new Date().toISOString();
    await sql`UPDATE site_sessions SET duration_seconds = ${(duration && Number(duration)) || null}, last_ping_at = ${now}, updated_at = ${now} WHERE session_id = ${sessionId}`;
    res.json({ data: { ok: true } });
  } catch (e) {
    console.error('[events] end error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Record a page view (visit)
router.post('/view', async (req, res) => {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkEventsRateLimit(ip)) return res.status(429).json({ error: 'Too many requests' });

    const { sessionId, userId, path } = req.body || {};
    // Ensure sessionId is provided, or generate one if missing (though frontend should provide it)
    const sid = sessionId || uuidv4();
    const id = uuidv4();
    const now = new Date().toISOString();

    // Fix: Ensure session exists to avoid foreign key violation (page_views_session_id_fkey)
    // We try to insert a session shell if it doesn't exist
    await sql`
      INSERT INTO site_sessions (session_id, user_id, path, started_at, last_ping_at, updated_at) 
      VALUES (${sid}, ${userId || null}, ${path || null}, ${now}, ${now}, ${now})
      ON CONFLICT (session_id) DO NOTHING
    `;

    await sql`INSERT INTO page_views (id, session_id, user_id, path, created_at) VALUES (${id}, ${sid}, ${userId || null}, ${path || null}, ${now})`;
    res.json({ data: { id, sessionId: sid } });
  } catch (e) {
    console.error('[events] view error', e && e.stack ? e.stack : e);
    // Silent fail for analytics is better than crashing or noisy errors, but we log it.
    res.status(200).json({ error: 'Failed to record view', status: 'error' });
  }
});

module.exports = router;
