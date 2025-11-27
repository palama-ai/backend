const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';

function authFromHeader(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const token = auth.replace('Bearer ', '');
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// autosave
router.post('/autosave', (req, res) => {
  try {
    const { userId, quiz_data } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    db.prepare('INSERT OR REPLACE INTO quiz_autosave (user_id, quiz_data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run(userId, JSON.stringify(quiz_data || {}));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to autosave' });
  }
});

router.get('/autosave/:userId', (req, res) => {
  try {
    const row = db.prepare('SELECT quiz_data, updated_at FROM quiz_autosave WHERE user_id = ?').get(req.params.userId);
    if (!row) return res.json({ data: null });
    res.json({ data: { quiz_data: JSON.parse(row.quiz_data), updated_at: row.updated_at } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch autosave' });
  }
});

// delete autosave
router.delete('/autosave/:userId', (req, res) => {
  try {
    db.prepare('DELETE FROM quiz_autosave WHERE user_id = ?').run(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete autosave' });
  }
});

// save attempt
router.post('/attempts', (req, res) => {
  try {
    const { userId, quiz_data, results, has_image_analysis } = req.body;
    if (!userId || !quiz_data) return res.status(400).json({ error: 'userId and quiz_data required' });
    const id = uuidv4();
    db.prepare('INSERT INTO quiz_attempts (id, user_id, subscription_id, quiz_data, results, has_image_analysis, attempt_date) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(id, userId, null, JSON.stringify(quiz_data), JSON.stringify(results || {}), has_image_analysis ? 1 : 0);

    // clear autosave
    db.prepare('DELETE FROM quiz_autosave WHERE user_id = ?').run(userId);

    const attempt = db.prepare('SELECT * FROM quiz_attempts WHERE id = ?').get(id);
    res.json({ data: attempt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save attempt' });
  }
});

router.get('/history/:userId', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, attempt_date, quiz_data, results, has_image_analysis FROM quiz_attempts WHERE user_id = ? ORDER BY attempt_date DESC').all(req.params.userId);
    const attempts = rows.map(r => ({ ...r, quiz_data: JSON.parse(r.quiz_data), results: JSON.parse(r.results || '{}') }));
    res.json({ data: attempts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

router.get('/attempts/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM quiz_attempts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.quiz_data = JSON.parse(row.quiz_data);
    row.results = JSON.parse(row.results || '{}');
    res.json({ data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attempt' });
  }
});

module.exports = router;

// POST /api/quiz/start
// Consumes one quiz attempt for the authenticated user
router.post('/start', (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;

    // find active subscription
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').get(userId, 'active');
    if (!sub) return res.status(404).json({ error: 'No active subscription found' });

    const used = sub.quiz_attempts_used || 0;
    const limit = sub.quiz_attempts_limit || 0;
    if (used >= limit) return res.status(403).json({ error: 'No attempts left' });

    db.prepare('UPDATE user_subscriptions SET quiz_attempts_used = quiz_attempts_used + 1, last_attempt_date = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sub.id);
    const updated = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(sub.id);
    res.json({ data: { subscription: updated, remaining: (updated.quiz_attempts_limit - updated.quiz_attempts_used) } });
  } catch (err) {
    console.error('Failed to start quiz attempt', err);
    res.status(500).json({ error: 'Failed to start attempt', details: err?.message || String(err) });
  }
});
