const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { sql } = require('../db');

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
router.get('/me', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;
    // prefer canonical referral_codes table
    const rc = await sql`SELECT code FROM referral_codes WHERE owner_id = ${userId}`;
    let code = rc && rc.length > 0 ? rc[0].code : null;
    
    if (!code) {
      const user = await sql`SELECT id, referral_code FROM users WHERE id = ${userId}`;
      if (!user || user.length === 0) return res.status(404).json({ error: 'User not found' });
      code = user[0].referral_code;
    }
    
    const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowimatch.vercel.app';
    const link = frontend ? `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}` : `/?ref=${encodeURIComponent(code)}`;
    res.json({ data: { referral_code: code, referral_link: link } });
  } catch (err) {
    console.error('referrals.me error', err);
    res.status(500).json({ error: 'Failed to fetch referral info' });
  }
});

// POST /api/referrals/create - generate a new referral code for authenticated user
router.post('/create', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;
    
    // If user already has a referral code in referral_codes, return it
    const existing = await sql`SELECT * FROM referral_codes WHERE owner_id = ${userId}`;
    if (existing && existing.length > 0) {
      const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowimatch.vercel.app';
      const link = frontend ? `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(existing[0].code)}` : `/?ref=${encodeURIComponent(existing[0].code)}`;
      return res.json({ data: { referral_code: existing[0].code, referral_link: link } });
    }

    // generate a short unique code and ensure uniqueness in referral_codes
    const genCode = () => (uuidv4().split('-')[0]);
    let code = genCode();
    let attempts = 0;
    while ((await sql`SELECT id FROM referral_codes WHERE code = ${code}`).length > 0 && attempts < 20) {
      code = genCode(); attempts += 1;
    }

    // persist into referral_codes and also update users/user_profiles for compatibility
    const id = uuidv4();
    await sql`INSERT INTO referral_codes (id, code, owner_id, uses_count, created_at) VALUES (${id}, ${code}, ${userId}, 0, NOW())`;
    await sql`UPDATE users SET referral_code = ${code} WHERE id = ${userId}`;
    await sql`UPDATE user_profiles SET referral_code = ${code} WHERE id = ${userId}`;

    const frontend = process.env.VITE_FRONTEND_URL || process.env.FRONTEND_URL || 'https://glowimatch.vercel.app';
    const link = frontend ? `${frontend.replace(/\/$/, '')}/?ref=${encodeURIComponent(code)}` : `/?ref=${encodeURIComponent(code)}`;
    res.json({ data: { referral_code: code, referral_link: link } });
  } catch (err) {
    console.error('referrals.create error', err);
    res.status(500).json({ error: 'Failed to create referral code' });
  }
});

// GET /api/referrals/validate/:code - check if code exists and return referrer info
router.get('/validate/:code', async (req, res) => {
  try {
    const code = req.params.code;
    if (!code) return res.status(400).json({ error: 'code required' });
    // Look up in referral_codes first
    const rc = await sql`SELECT * FROM referral_codes WHERE code = ${code}`;
    if (!rc || rc.length === 0) return res.status(404).json({ error: 'Invalid code' });
    
    const rcRow = rc[0];
    const userResult = await sql`SELECT id, email, full_name FROM users WHERE id = ${rcRow.owner_id}`;
    const user = userResult && userResult.length > 0 ? userResult[0] : null;
    
    res.json({ data: { referrer: { id: user?.id, email: user?.email, full_name: user?.full_name }, uses_count: rcRow.uses_count, created_at: rcRow.created_at, last_10_reached_at: rcRow.last_10_reached_at } });
  } catch (err) {
    console.error('referrals.validate error', err);
    res.status(500).json({ error: 'Failed to validate code' });
  }
});

module.exports = router;
