const express = require('express');
const router = express.Router();
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

router.get('/:userId', (req, res) => {
  const { userId } = req.params;
  try {
    // First try to get profile from user_profiles
    let profile = db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(userId);
    if (!profile) {
      // If profile doesn't exist, try to get from users table and create it
      const user = db.prepare('SELECT id, email, full_name, role, referral_code FROM users WHERE id = ?').get(userId);
      if (!user) return res.status(404).json({ error: 'Not found' });
      // Create profile entry
      db.prepare('INSERT OR REPLACE INTO user_profiles (id, email, full_name, role, referral_code, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
        .run(user.id, user.email, user.full_name, user.role, user.referral_code);
      profile = user;
    }

    // compute referral stats
    const totalRow = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ?').get(userId);
    const totalReferrals = (totalRow && totalRow.c) ? totalRow.c : 0;

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 15);
    const cutoffISO = cutoff.toISOString();
    const recentRow = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND created_at >= ?').get(userId, cutoffISO);
    const recentCount = (recentRow && recentRow.c) ? recentRow.c : 0;

    const remainingSlots = Math.max(0, 10 - recentCount);

    res.json({ data: { ...profile, referralStats: { totalReferrals, recentCount, remainingSlots } } });
  } catch (err) {
    console.error('[profile.get] error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

router.put('/:userId', (req, res) => {
  const auth = authFromHeader(req);
  if (!auth || auth.id !== req.params.userId) return res.status(403).json({ error: 'Unauthorized' });

  const updates = req.body || {};
  try {
    // Get existing referral_code from users table first
    const user = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(auth.id);
    const referralCode = user?.referral_code || null;

    db.prepare('INSERT OR REPLACE INTO user_profiles (id, email, full_name, role, referral_code, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(auth.id, updates.email || auth.email, updates.full_name || updates.fullName || null, updates.role || 'user', referralCode);

    const profile = db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(auth.id);
    res.json({ data: profile });
  } catch (err) {
    console.error('[profile.put] error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
