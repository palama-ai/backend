const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

// Lightweight events API used by frontend to report page views and session heartbeats.

// Start or upsert a session: returns session_id
router.post('/start', (req, res) => {
  try {
    const { sessionId, userId, path } = req.body || {};
    const sid = sessionId || uuidv4();
    const now = new Date().toISOString();
    // insert or replace session record
    db.prepare(`INSERT OR REPLACE INTO site_sessions (session_id, user_id, path, started_at, last_ping_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sid, userId || null, path || null, now, now, now);
    res.json({ data: { sessionId: sid } });
  } catch (e) {
    console.error('[events] start error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Ping/heartbeat to mark session as active
router.post('/ping', (req, res) => {
  try {
    const { sessionId, userId, path } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const now = new Date().toISOString();
    const info = db.prepare('SELECT session_id FROM site_sessions WHERE session_id = ?').get(sessionId);
    if (info) {
      db.prepare('UPDATE site_sessions SET last_ping_at = ?, path = ?, updated_at = ? WHERE session_id = ?')
        .run(now, path || null, now, sessionId);
    } else {
      db.prepare('INSERT INTO site_sessions (session_id, user_id, path, started_at, last_ping_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, userId || null, path || null, now, now, now);
    }
    res.json({ data: { ok: true } });
  } catch (e) {
    console.error('[events] ping error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to ping session' });
  }
});

// End a session and optionally record duration (seconds)
router.post('/end', (req, res) => {
  try {
    const { sessionId, duration } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    const now = new Date().toISOString();
    db.prepare('UPDATE site_sessions SET duration_seconds = ?, last_ping_at = ?, updated_at = ? WHERE session_id = ?')
      .run((duration && Number(duration)) || null, now, now, sessionId);
    res.json({ data: { ok: true } });
  } catch (e) {
    console.error('[events] end error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Record a page view (visit)
router.post('/view', (req, res) => {
  try {
    const { sessionId, userId, path } = req.body || {};
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO page_views (id, session_id, user_id, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, sessionId || null, userId || null, path || null, now);
    res.json({ data: { id } });
  } catch (e) {
    console.error('[events] view error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to record view' });
  }
});

module.exports = router;
