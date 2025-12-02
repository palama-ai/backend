const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { sql } = require('../db');

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

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    // First try to get profile from user_profiles
    const profileResult = await sql`SELECT * FROM user_profiles WHERE id = ${userId}`;
    let profile = profileResult && profileResult.length > 0 ? profileResult[0] : null;
    
    if (!profile) {
      // If profile doesn't exist, try to get from users table and create it
      const userResult = await sql`SELECT id, email, full_name, role, referral_code FROM users WHERE id = ${userId}`;
      if (!userResult || userResult.length === 0) return res.status(404).json({ error: 'Not found' });
      
      const user = userResult[0];
      // Create profile entry
      await sql`
        INSERT INTO user_profiles (id, email, full_name, role, referral_code, updated_at)
        VALUES (${user.id}, ${user.email}, ${user.full_name}, ${user.role}, ${user.referral_code}, NOW())
        ON CONFLICT (id) DO UPDATE SET email = ${user.email}, full_name = ${user.full_name}, role = ${user.role}, referral_code = ${user.referral_code}, updated_at = NOW()
      `;
      profile = user;
    }

    // compute referral stats
    const totalRow = await sql`SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ${userId}`;
    const totalReferrals = (totalRow && totalRow.length > 0 && totalRow[0].c) ? parseInt(totalRow[0].c) : 0;

    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 15);
    const cutoffISO = cutoff.toISOString();
    const recentRow = await sql`SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ${userId} AND created_at >= ${cutoffISO}`;
    const recentCount = (recentRow && recentRow.length > 0 && recentRow[0].c) ? parseInt(recentRow[0].c) : 0;

    const remainingSlots = Math.max(0, 10 - recentCount);

    res.json({ data: { ...profile, referralStats: { totalReferrals, recentCount, remainingSlots } } });
  } catch (err) {
    console.error('[profile.get] error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

router.put('/:userId', async (req, res) => {
  const auth = authFromHeader(req);
  if (!auth || auth.id !== req.params.userId) return res.status(403).json({ error: 'Unauthorized' });

  const updates = req.body || {};
  try {
    // Get existing referral_code from users table first
    const userResult = await sql`SELECT referral_code FROM users WHERE id = ${auth.id}`;
    const referralCode = userResult && userResult.length > 0 ? userResult[0].referral_code : null;

    await sql`
      INSERT INTO user_profiles (id, email, full_name, role, referral_code, updated_at)
      VALUES (${auth.id}, ${updates.email || auth.email}, ${updates.full_name || updates.fullName || null}, ${updates.role || 'user'}, ${referralCode}, NOW())
      ON CONFLICT (id) DO UPDATE SET email = ${updates.email || auth.email}, full_name = ${updates.full_name || updates.fullName || null}, role = ${updates.role || 'user'}, referral_code = ${referralCode}, updated_at = NOW()
    `;

    const profile = await sql`SELECT * FROM user_profiles WHERE id = ${auth.id}`;
    res.json({ data: profile[0] });
  } catch (err) {
    console.error('[profile.put] error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
