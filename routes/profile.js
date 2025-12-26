const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { sql } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
  process.exit(1);
}

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

// GET profile - NOW PROTECTED
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    // Require authentication
    const auth = authFromHeader(req);
    if (!auth || !auth.id) return res.status(401).json({ error: 'Unauthorized' });

    // Verify user can only access their own profile
    if (auth.id !== userId) {
      return res.status(403).json({ error: 'You can only access your own profile' });
    }

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
    // Get existing referral_code and role from users table first
    const userResult = await sql`SELECT referral_code, role FROM users WHERE id = ${auth.id}`;
    const referralCode = userResult && userResult.length > 0 ? userResult[0].referral_code : null;
    const existingRole = userResult && userResult.length > 0 ? userResult[0].role : 'user';

    await sql`
      INSERT INTO user_profiles (id, email, full_name, role, referral_code, brand_name, website, bio, updated_at)
      VALUES (${auth.id}, ${updates.email || auth.email}, ${updates.full_name || updates.fullName || null}, ${existingRole}, ${referralCode}, ${updates.brand_name || null}, ${updates.website || null}, ${updates.bio || null}, NOW())
      ON CONFLICT (id) DO UPDATE SET 
        email = COALESCE(${updates.email}, user_profiles.email), 
        full_name = COALESCE(${updates.full_name || updates.fullName}, user_profiles.full_name), 
        brand_name = COALESCE(${updates.brand_name}, user_profiles.brand_name),
        website = COALESCE(${updates.website}, user_profiles.website),
        bio = COALESCE(${updates.bio}, user_profiles.bio),
        updated_at = NOW()
    `;

    // Also update users table full_name if changed
    if (updates.full_name || updates.fullName) {
      await sql`UPDATE users SET full_name = ${updates.full_name || updates.fullName} WHERE id = ${auth.id}`;
    }

    const profile = await sql`SELECT * FROM user_profiles WHERE id = ${auth.id}`;
    res.json({ data: profile[0] });
  } catch (err) {
    console.error('[profile.put] error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Alternative: PUT /profile (no userId param, uses JWT)
router.put('/', async (req, res) => {
  const auth = authFromHeader(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const updates = req.body || {};
  try {
    const userResult = await sql`SELECT referral_code, role FROM users WHERE id = ${auth.id}`;
    const referralCode = userResult && userResult.length > 0 ? userResult[0].referral_code : null;
    const existingRole = userResult && userResult.length > 0 ? userResult[0].role : 'user';

    await sql`
      INSERT INTO user_profiles (id, email, full_name, role, referral_code, brand_name, website, bio, updated_at)
      VALUES (${auth.id}, ${auth.email}, ${updates.full_name || null}, ${existingRole}, ${referralCode}, ${updates.brand_name || null}, ${updates.website || null}, ${updates.bio || null}, NOW())
      ON CONFLICT (id) DO UPDATE SET 
        full_name = COALESCE(${updates.full_name}, user_profiles.full_name), 
        brand_name = COALESCE(${updates.brand_name}, user_profiles.brand_name),
        website = COALESCE(${updates.website}, user_profiles.website),
        bio = COALESCE(${updates.bio}, user_profiles.bio),
        updated_at = NOW()
    `;

    if (updates.full_name) {
      await sql`UPDATE users SET full_name = ${updates.full_name} WHERE id = ${auth.id}`;
    }

    const profile = await sql`SELECT * FROM user_profiles WHERE id = ${auth.id}`;
    res.json({ data: profile[0] });
  } catch (err) {
    console.error('[profile.put] error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;

