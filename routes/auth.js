const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';
const TOKEN_EXPIRY = '30d';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

router.post('/signup', async (req, res) => {
  try {
    const { email, password, fullName, referralCode, accountType } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // Validate accountType - only allow 'user' or 'seller'
    const role = accountType === 'seller' ? 'seller' : 'user';

    // Check if user already exists
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing && existing.length > 0) return res.status(409).json({ error: 'User already exists' });

    const id = uuidv4();
    const password_hash = await bcrypt.hash(password, 10);

    // generate a short referral code for the new user
    const genCode = () => {
      return uuidv4().split('-')[0];
    };
    const myReferralCode = genCode();

    // If referralCode provided, try to find referrer
    let referrer = null;
    if (referralCode) {
      const result = await sql`SELECT id FROM users WHERE referral_code = ${referralCode}`;
      referrer = result && result.length > 0 ? result[0] : null;
    }

    // Insert new user with the specified role
    await sql`
      INSERT INTO users (id, email, password_hash, full_name, role, referral_code, referrer_id)
      VALUES (${id}, ${email}, ${password_hash}, ${fullName || null}, ${role}, ${myReferralCode}, ${referrer ? referrer.id : null})
    `;

    // create profile mirror
    await sql`
      INSERT INTO user_profiles (id, email, full_name, role, referral_code)
      VALUES (${id}, ${email}, ${fullName || null}, ${role}, ${myReferralCode})
    `;

    // persist canonical referral code in referral_codes table to prevent duplicates
    try {
      const existingCode = await sql`SELECT id FROM referral_codes WHERE code = ${myReferralCode}`;
      if (!existingCode || existingCode.length === 0) {
        await sql`
          INSERT INTO referral_codes (id, code, owner_id, uses_count, created_at)
          VALUES (${uuidv4()}, ${myReferralCode}, ${id}, 0, NOW())
        `;
      } else {
        // ensure owner_id is set for this code
        await sql`UPDATE referral_codes SET owner_id = ${id} WHERE code = ${myReferralCode}`;
      }
    } catch (e) {
      console.warn('Failed to persist referral code to referral_codes table', e && e.message);
    }

    // create initial subscription/attempts record for the new user
    // default: 5 attempts for normal signup; +1 extra if signed via referral
    const initialAttempts = (referrer ? 6 : 5);
    const subId = uuidv4();
    const now = new Date().toISOString();
    const far = new Date(); far.setFullYear(far.getFullYear() + 1);

    await sql`
      INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
      VALUES (${subId}, ${id}, 'active', null, ${now}, ${far.toISOString()}, 0, ${initialAttempts}, ${now})
    `;

    // If referred, record referral and grant referrer bonus (2 attempts) subject to cap: max 10 referrals per 15 days
    if (referralCode) {
      // Prefer referral_codes table to find the owner
      const codeRow = await sql`SELECT * FROM referral_codes WHERE code = ${referralCode}`;
      let referrerId = referrer ? referrer.id : null;
      if (codeRow && codeRow.length > 0) referrerId = codeRow[0].owner_id;

      if (referrerId) {
        const refId = uuidv4();
        await sql`
          INSERT INTO referrals (id, referrer_id, referred_id, created_at)
          VALUES (${refId}, ${referrerId}, ${id}, NOW())
        `;

        // update referral_codes uses_count/last_used_at if applicable
        if (codeRow && codeRow.length > 0) {
          const codeId = codeRow[0].id;
          await sql`UPDATE referral_codes SET uses_count = uses_count + 1, last_used_at = NOW() WHERE id = ${codeId}`;
          // reload to get updated uses_count
          const updatedCode = await sql`SELECT * FROM referral_codes WHERE id = ${codeId}`;
          // if the code just reached 10 uses, mark the timestamp
          if (updatedCode && updatedCode.length > 0 && (updatedCode[0].uses_count || 0) >= 10 && !updatedCode[0].last_10_reached_at) {
            await sql`UPDATE referral_codes SET last_10_reached_at = NOW() WHERE id = ${codeId}`;
          }
        }

        // count referrals in last 15 days for this referrer
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 15);
        const cutoffISO = cutoff.toISOString();
        const recentCountRow = await sql`SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ${referrerId} AND created_at >= ${cutoffISO}`;
        const recentCount = (recentCountRow && recentCountRow.length > 0 && recentCountRow[0].c) ? recentCountRow[0].c : 0;

        // Check code cooldown: if the referral code previously hit 10 uses less than 15 days ago, do not grant until 15 days have passed
        let codeCooldownActive = false;
        if (codeRow && codeRow.length > 0 && codeRow[0].last_10_reached_at) {
          const last10 = new Date(codeRow[0].last_10_reached_at);
          const diffMs = Date.now() - last10.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          if (diffDays < 15) codeCooldownActive = true;
        }

        // allow grants only if referrer has fewer than 10 referrals in the last 15 days AND no active code cooldown
        if (recentCount < 10 && !codeCooldownActive) {
          // grant +2 attempts to referrer
          // find or create subscription for referrer
          const refSubResult = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${referrerId} LIMIT 1`;
          let refSub = refSubResult && refSubResult.length > 0 ? refSubResult[0] : null;

          if (!refSub) {
            const newSubId = uuidv4();
            const now2 = new Date().toISOString();
            const far2 = new Date(); far2.setFullYear(far2.getFullYear() + 1);
            await sql`
              INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
              VALUES (${newSubId}, ${referrerId}, 'active', null, ${now2}, ${far2.toISOString()}, 0, 2, ${now2})
            `;
          } else {
            try {
              await sql`UPDATE user_subscriptions SET quiz_attempts_limit = quiz_attempts_limit + 2, updated_at = NOW() WHERE id = ${refSub.id}`;
            } catch (e) {
              console.warn('Failed to update referrer subscription attempts', e && e.message);
            }
          }
        }
      }
    }

    const token = signToken({ id, email, role: 'user' });
    res.json({ data: { user: { id, email, full_name: fullName, role: 'user', referral_code: myReferralCode }, token } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const userResult = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (!userResult || userResult.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = userResult[0];

    // If user is deleted, block login and return an explanatory message
    if (user.deleted) {
      return res.status(403).json({ error: 'Account deleted', message: 'لقد تم حذف حسابك. راسل support لمعرفة المزيد.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: user.id, email: user.email, role: user.role });

    // If user is disabled, block login and return explanatory message
    if (user.disabled) {
      const msg = user.status_message || 'لقد تم تعطيل حسابك بسبب مخالفتك لسياسات الاستخدام. يرجى التواصل مع support لمزيد من المعلومات.';
      return res.status(403).json({ error: 'Account disabled', message: msg });
    }

    res.json({ data: { user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, referral_code: user.referral_code }, token } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// simple session check
router.get('/session', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.json({ data: { session: null } });

    const token = auth.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);

    const userResult = await sql`SELECT id, email, full_name, role, disabled, deleted, status_message FROM users WHERE id = ${payload.id}`;
    if (!userResult || userResult.length === 0) return res.json({ data: { session: null } });

    const user = userResult[0];

    // If deleted, return null session to force re-login and surface message via client (client may call a debug endpoint)
    if (user.deleted) return res.status(200).json({ data: { session: null, deleted: true, message: 'لقد تم حذف حسابك. راسل support لمعرفة المزيد.' } });

    const session = { user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, disabled: !!user.disabled, status_message: user.status_message || null } };
    return res.json({ data: { session } });
  } catch (err) {
    return res.json({ data: { session: null } });
  }
});

module.exports = router;

// ADMIN RESET ENDPOINT (temporary): upsert the default admin account using
// the `GLOWMATCH_ADMIN_EMAIL` and `GLOWMATCH_ADMIN_PASSWORD` environment vars.
// Protect this endpoint with a secret `GLOWMATCH_ADMIN_RESET_SECRET` header.
// Usage (once): set `GLOWMATCH_ADMIN_RESET_SECRET` on the server, then POST
// to `/api/auth/reset-admin` with header `x-admin-reset: <secret>` to recreate
// or update the admin user. Remove this endpoint after use.

router.post('/reset-admin', async (req, res) => {
  try {
    const secret = req.headers['x-admin-reset'] || req.headers['x-admin-secret'];
    const expected = process.env.GLOWMATCH_ADMIN_RESET_SECRET;
    if (!expected || !secret || secret !== expected) return res.status(403).json({ error: 'Forbidden' });

    const adminEmail = process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com';
    const adminPassword = process.env.GLOWMATCH_ADMIN_PASSWORD || 'Adm1n!Glow2025#';
    const adminFullName = process.env.GLOWMATCH_ADMIN_FULLNAME || 'GlowMatch Admin';

    // hash password
    const password_hash = await bcrypt.hash(adminPassword, 10);

    // upsert into users
    const existingResult = await sql`SELECT id FROM users WHERE email = ${adminEmail}`;
    let id = existingResult && existingResult.length > 0 ? existingResult[0].id : uuidv4();

    if (existingResult && existingResult.length > 0) {
      await sql`UPDATE users SET password_hash = ${password_hash}, full_name = ${adminFullName}, role = 'admin' WHERE id = ${id}`;
    } else {
      await sql`INSERT INTO users (id, email, password_hash, full_name, role) VALUES (${id}, ${adminEmail}, ${password_hash}, ${adminFullName}, 'admin')`;
    }

    // upsert profile
    await sql`
      INSERT INTO user_profiles (id, email, full_name, role) 
      VALUES (${id}, ${adminEmail}, ${adminFullName}, 'admin')
      ON CONFLICT (id) DO UPDATE SET email = ${adminEmail}, full_name = ${adminFullName}, role = 'admin'
    `;

    // ensure subscription exists
    const subResult = await sql`SELECT id FROM user_subscriptions WHERE user_id = ${id}`;
    if (!subResult || subResult.length === 0) {
      const subId = uuidv4();
      const now = new Date().toISOString();
      const far = new Date(); far.setFullYear(far.getFullYear() + 100);
      await sql`
        INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
        VALUES (${subId}, ${id}, 'active', null, ${now}, ${far.toISOString()}, 0, 999999999, ${now})
      `;
    }

    console.log('[auth] Admin account reset via /api/auth/reset-admin for', adminEmail);
    res.json({ data: { ok: true, email: adminEmail } });
  } catch (e) {
    console.error('[auth] reset-admin error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to reset admin' });
  }
});
