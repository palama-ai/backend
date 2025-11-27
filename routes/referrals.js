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
  } catch (e) { return null; }
}

// GET /api/referrals/me - get current user's referral code and link
router.get('/me', (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;
    // prefer canonical referral_codes table
    const rc = db.prepare('SELECT code FROM referral_codes WHERE owner_id = ?').get(userId);
    let code = rc?.code;
    if (!code) {
      const user = db.prepare('SELECT id, referral_code FROM users WHERE id = ?').get(userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      code = user.referral_code;
    }
    const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowmatch-ebon.vercel.app/';
    const link = `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`;
    res.json({ data: { referral_code: code, referral_link: link } });
  } catch (err) {
    console.error('referrals.me error', err);
    res.status(500).json({ error: 'Failed to fetch referral info' });
  }
});

// POST /api/referrals/create - generate a new referral code for authenticated user
router.post('/create', (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;
    // If user already has a referral code in referral_codes, return it
    const existing = db.prepare('SELECT * FROM referral_codes WHERE owner_id = ?').get(userId);
    if (existing) {
      const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowmatch-ebon.vercel.app/';
      const link = `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(existing.code)}`;
      return res.json({ data: { referral_code: existing.code, referral_link: link } });
    }

    // generate a short unique code and ensure uniqueness in referral_codes
    const genCode = () => (uuidv4().split('-')[0]);
    let code = genCode();
    let attempts = 0;
    while (db.prepare('SELECT id FROM referral_codes WHERE code = ?').get(code) && attempts < 20) {
      code = genCode(); attempts += 1;
    }

    // persist into referral_codes and also update users/user_profiles for compatibility
    const id = uuidv4();
    db.prepare('INSERT INTO referral_codes (id, code, owner_id, uses_count, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)').run(id, code, userId);
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
    db.prepare('UPDATE user_profiles SET referral_code = ? WHERE id = ?').run(code, userId);

    const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowmatch-ebon.vercel.app/';
    const link = `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}`;
    res.json({ data: { referral_code: code, referral_link: link } });
  } catch (err) {
    console.error('referrals.create error', err);
    res.status(500).json({ error: 'Failed to create referral code' });
  }
});

// GET /api/referrals/validate/:code - check if code exists and return referrer info
router.get('/validate/:code', (req, res) => {
  try {
    const code = req.params.code;
    if (!code) return res.status(400).json({ error: 'code required' });
    // Look up in referral_codes first
    const rc = db.prepare('SELECT * FROM referral_codes WHERE code = ?').get(code);
    if (!rc) return res.status(404).json({ error: 'Invalid code' });
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(rc.owner_id);
    res.json({ data: { referrer: { id: user?.id, email: user?.email, full_name: user?.full_name }, uses_count: rc.uses_count, created_at: rc.created_at, last_10_reached_at: rc.last_10_reached_at } });
  } catch (err) {
    console.error('referrals.validate error', err);
    res.status(500).json({ error: 'Failed to validate code' });
  }
});

module.exports = router;
