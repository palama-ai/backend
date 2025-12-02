const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

router.get('/:userId', async (req, res) => {
  try {
    if (!req.params.userId) {
      return res.status(400).json({ error: 'userId required in path' });
    }
    
    const subs = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${req.params.userId} AND status = 'active' ORDER BY updated_at DESC LIMIT 1`;
    res.json({ data: subs && subs.length > 0 ? subs[0] : null });
  } catch (err) {
    console.error('[subscription.get] Error:', err.message || err);
    res.status(500).json({ error: 'Failed to fetch subscription', details: err.message });
  }
});

router.post('/subscribe', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    if (!userId || !plan) return res.status(400).json({ error: 'userId and plan required' });
    const id = uuidv4();
    const now = new Date().toISOString();
    const oneYear = new Date(); oneYear.setFullYear(oneYear.getFullYear() + 1);
    
    await sql`
      INSERT INTO user_subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
      VALUES (${id}, ${userId}, ${plan.id || null}, 'active', ${now}, ${oneYear.toISOString()}, 0, ${Number(plan.quiz_attempts || 999999)}, ${now})
    `;

    const sub = await sql`SELECT * FROM user_subscriptions WHERE id = ${id}`;
    res.json({ data: sub[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

router.post('/purchase-attempts', async (req, res) => {
  try {
    const { userId, quantity } = req.body;
    if (!userId || !quantity) return res.status(400).json({ error: 'userId and quantity required' });
    // For simplicity: add attempts to existing active subscription
    const subs = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${userId} AND status = 'active' ORDER BY updated_at DESC LIMIT 1`;
    if (!subs || subs.length === 0) return res.status(404).json({ error: 'No active subscription' });
    
    const sub = subs[0];
    await sql`UPDATE user_subscriptions SET quiz_attempts_limit = quiz_attempts_limit + ${quantity}, updated_at = NOW() WHERE id = ${sub.id}`;
    
    const updated = await sql`SELECT * FROM user_subscriptions WHERE id = ${sub.id}`;
    res.json({ data: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to purchase attempts' });
  }
});

module.exports = router;
