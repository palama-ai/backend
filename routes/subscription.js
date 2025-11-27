const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

router.get('/:userId', (req, res) => {
  try {
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').get(req.params.userId, 'active');
    res.json({ data: sub || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch subscription' });
  }
});

router.post('/subscribe', (req, res) => {
  try {
    const { userId, plan } = req.body;
    if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
    const id = uuidv4();
    const now = new Date().toISOString();
    const oneYear = new Date(); oneYear.setFullYear(oneYear.getFullYear() + 1);
    db.prepare('INSERT INTO user_subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, plan.id || null, 'active', now, oneYear.toISOString(), 0, Number(plan.quiz_attempts || 999999), now);

    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(id);
    res.json({ data: sub });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.post('/purchase-attempts', (req, res) => {
  try {
    const { userId, quantity } = req.body;
    if (!userId || !quantity) return res.status(400).json({ error: 'userId and quantity required' });
    // For simplicity: add attempts to existing active subscription
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1').get(userId, 'active');
    if (!sub) return res.status(404).json({ error: 'No active subscription' });
    db.prepare('UPDATE user_subscriptions SET quiz_attempts_limit = quiz_attempts_limit + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(quantity, sub.id);
    const updated = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(sub.id);
    res.json({ data: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to purchase attempts' });
  }
});

module.exports = router;
