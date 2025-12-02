const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

// Lightweight events API used by frontend to report page views and session heartbeats.

// Start or upsert a session: returns session_id
router.post('/start', async (req, res) => {
  try {
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
    const { sessionId, userId, path } = req.body || {};
    const id = uuidv4();
    const now = new Date().toISOString();
    await sql`INSERT INTO page_views (id, session_id, user_id, path, created_at) VALUES (${id}, ${sessionId || null}, ${userId || null}, ${path || null}, ${now})`;
    res.json({ data: { id } });
  } catch (e) {
    console.error('[events] view error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

module.exports = router;
