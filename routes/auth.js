const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');
const { sendPasswordResetCode, sendVerificationCode } = require('../utils/email');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
  process.exit(1);
}
const TOKEN_EXPIRY = '7d'; // SECURITY: Reduced from 30d to 7d

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

// SECURITY: Password complexity validation
function validatePassword(password) {
  const errors = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  return errors;
}

router.post('/signup', async (req, res) => {
  try {
    const { email, password, fullName, referralCode, accountType } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // SECURITY: Validate password complexity
    const passwordErrors = validatePassword(password);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        error: 'Password does not meet requirements',
        details: passwordErrors
      });
    }

    // Validate accountType - only allow 'user' or 'seller'
    const role = accountType === 'seller' ? 'seller' : 'user';

    // Check if signup is blocked for this account type
    try {
      const blockKey = role === 'seller' ? 'block_seller_signup' : 'block_user_signup';
      const blockRow = await sql`SELECT value FROM site_settings WHERE key = ${blockKey}`;
      if (blockRow && blockRow.length > 0 && blockRow[0].value === 'true') {
        const message = role === 'seller'
          ? 'Seller registration is temporarily disabled. Please try again later.'
          : 'User registration is temporarily disabled. Please try again later.';
        return res.status(403).json({ error: 'Signup blocked', message });
      }
    } catch (e) {
      // If site_settings table doesn't exist yet, allow signup
      console.warn('[auth] Could not check signup block status:', e?.message);
    }

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

    // Generate email verification code for all users
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Insert new user with email_verified = 0 (all users must verify)
    await sql`
      INSERT INTO users (id, email, password_hash, full_name, role, referral_code, referrer_id, email_verified, verification_code, verification_code_expires)
      VALUES (${id}, ${email}, ${password_hash}, ${fullName || null}, ${role}, ${myReferralCode}, ${referrer ? referrer.id : null}, 0, ${verificationCode}, ${verificationExpires})
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

    // Send verification email for all users (including sellers)
    const emailResult = await sendVerificationCode(email, verificationCode, fullName);
    if (emailResult.success) {
      console.log(`[auth] Verification code sent to ${email}`);
    } else {
      console.log(`[auth] Verification code for ${email}: ${verificationCode} (email not sent: ${emailResult.reason})`);
    }

    // Return success but require verification (no token until verified)
    res.json({
      data: {
        email,
        message: 'Account created! Please check your email for the verification code.'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    // 🛡️ SECURITY: Check brute force protection
    if (req.security) {
      const bruteCheck = req.security.checkBruteForce(email);
      if (!bruteCheck.allowed) {
        return res.status(423).json({
          error: 'Account locked',
          message: bruteCheck.reason
        });
      }
      // Warn about remaining attempts
      if (bruteCheck.attemptsLeft <= 2) {
        res.set('X-Attempts-Remaining', bruteCheck.attemptsLeft);
      }
    }

    const userResult = await sql`SELECT * FROM users WHERE email = ${email}`;
    if (!userResult || userResult.length === 0) {
      // Record failed login attempt
      if (req.security) req.security.recordFailedLogin(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult[0];

    // If user is deleted, block login and return an explanatory message
    if (user.deleted) {
      return res.status(403).json({ error: 'Account deleted', message: 'Your account has been deleted. Contact support for more information.' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      // Record failed login attempt
      if (req.security) req.security.recordFailedLogin(email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login - clear failed attempts
    if (req.security) req.security.clearLoginAttempts(email);

    // Check if email is verified (skip for sellers)
    if (!user.email_verified && user.role !== 'seller') {
      // Generate new verification code if expired or doesn't exist
      let currentCode = user.verification_code;
      const codeExpired = !user.verification_code_expires || new Date(user.verification_code_expires) < new Date();

      if (codeExpired) {
        currentCode = Math.floor(100000 + Math.random() * 900000).toString();
        const newExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await sql`UPDATE users SET verification_code = ${currentCode}, verification_code_expires = ${newExpires} WHERE id = ${user.id}`;

        // Send new verification email
        const emailResult = await sendVerificationCode(email, currentCode, user.full_name);
        if (emailResult.success) {
          console.log(`[auth] New verification code sent to ${email}`);
        } else {
          console.log(`[auth] Verification code for ${email}: ${currentCode} (email not sent: ${emailResult.reason})`);
        }
      }

      return res.status(403).json({
        error: 'Email not verified',
        requiresVerification: true,
        email: user.email,
        message: 'Please verify your email before logging in. Check your inbox for a verification code.'
      });
    }

    const token = signToken({ id: user.id, email: user.email, role: user.role });

    // If user is disabled, block login and return explanatory message
    if (user.disabled) {
      const msg = user.status_message || 'Your account has been disabled due to policy violations. Please contact support for more information.';
      return res.status(403).json({ error: 'Account disabled', message: msg });
    }

    res.json({ data: { user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, referral_code: user.referral_code, email_verified: true }, token } });
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
    if (user.deleted) return res.status(200).json({ data: { session: null, deleted: true, message: 'Your account has been deleted. Contact support for more information.' } });

    const session = { user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, disabled: !!user.disabled, status_message: user.status_message || null } };
    return res.json({ data: { session } });
  } catch (err) {
    return res.json({ data: { session: null } });
  }
});

// ==================== PASSWORD RESET ====================
// POST /api/auth/forgot-password - Request password reset code
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Check if user exists
    const userResult = await sql`SELECT id, email FROM users WHERE email = ${email}`;
    if (!userResult || userResult.length === 0) {
      // Don't reveal if user exists or not for security
      return res.json({
        success: true,
        message: 'If an account with this email exists, a reset code has been generated.'
      });
    }

    const user = userResult[0];

    // Generate 6-digit reset code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Store reset code in database
    await sql`
      UPDATE users 
      SET reset_code = ${resetCode}, reset_code_expires = ${expiresAt}
      WHERE id = ${user.id}
    `;

    // Send reset code via email
    const emailResult = await sendPasswordResetCode(email, resetCode);

    if (emailResult.success) {
      console.log(`[auth] Password reset code sent to ${email}`);
      res.json({
        success: true,
        message: 'If an account with this email exists, a reset code has been sent to your email.',
        expiresIn: '15 minutes'
      });
    } else {
      // If email fails but SMTP not configured, log code for development
      console.log(`[auth] Password reset code for ${email}: ${resetCode} (email not sent: ${emailResult.reason})`);
      res.json({
        success: true,
        message: 'Reset code generated. Check your email (or server logs if SMTP not configured).',
        expiresIn: '15 minutes'
      });
    }

  } catch (err) {
    console.error('[auth] forgot-password error:', err);
    res.status(500).json({ error: 'Failed to process reset request' });
  }
});

// POST /api/auth/reset-password - Reset password with code
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code, and new password are required' });
    }

    // Validate password complexity
    const passwordErrors = validatePassword(newPassword);
    if (passwordErrors.length > 0) {
      return res.status(400).json({
        error: 'Password does not meet requirements',
        details: passwordErrors
      });
    }

    // Find user with matching email and code
    const userResult = await sql`
      SELECT id, email, reset_code, reset_code_expires 
      FROM users 
      WHERE email = ${email}
    `;

    if (!userResult || userResult.length === 0) {
      return res.status(400).json({ error: 'Invalid email or code' });
    }

    const user = userResult[0];

    // Check if code matches
    if (user.reset_code !== code) {
      return res.status(400).json({ error: 'Invalid reset code' });
    }

    // Check if code is expired
    if (user.reset_code_expires && new Date(user.reset_code_expires) < new Date()) {
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }

    // Hash new password
    const password_hash = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset code
    await sql`
      UPDATE users 
      SET password_hash = ${password_hash}, reset_code = NULL, reset_code_expires = NULL
      WHERE id = ${user.id}
    `;

    console.log(`[auth] Password reset successful for ${email}`);

    res.json({
      success: true,
      message: 'Password has been reset successfully. You can now login with your new password.'
    });

  } catch (err) {
    console.error('[auth] reset-password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ==================== EMAIL VERIFICATION ====================
// POST /api/auth/verify-email - Verify email with code
router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and verification code are required' });
    }

    // Find user with matching email
    const userResult = await sql`
      SELECT id, email, role, full_name, referral_code, verification_code, verification_code_expires, email_verified
      FROM users 
      WHERE email = ${email}
    `;

    if (!userResult || userResult.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const user = userResult[0];

    // Already verified
    if (user.email_verified) {
      const token = signToken({ id: user.id, email: user.email, role: user.role });
      return res.json({
        success: true,
        message: 'Email already verified',
        data: {
          user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, referral_code: user.referral_code, email_verified: true },
          token
        }
      });
    }

    // Check if code matches
    if (user.verification_code !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    // Check if code is expired
    if (user.verification_code_expires && new Date(user.verification_code_expires) < new Date()) {
      return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
    }

    // Mark email as verified and clear verification code
    await sql`
      UPDATE users 
      SET email_verified = 1, verification_code = NULL, verification_code_expires = NULL
      WHERE id = ${user.id}
    `;

    console.log(`[auth] Email verified for ${email}`);

    // Issue JWT token
    const token = signToken({ id: user.id, email: user.email, role: user.role });

    res.json({
      success: true,
      message: 'Email verified successfully!',
      data: {
        user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, referral_code: user.referral_code, email_verified: true },
        token
      }
    });

  } catch (err) {
    console.error('[auth] verify-email error:', err);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// POST /api/auth/resend-verification - Resend verification code
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user
    const userResult = await sql`
      SELECT id, email, full_name, email_verified
      FROM users 
      WHERE email = ${email}
    `;

    if (!userResult || userResult.length === 0) {
      // Don't reveal if user exists
      return res.json({ success: true, message: 'If an account exists with this email, a new verification code has been sent.' });
    }

    const user = userResult[0];

    // Already verified
    if (user.email_verified) {
      return res.json({ success: true, message: 'Email is already verified. You can login now.' });
    }

    // Generate new verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Update in database
    await sql`
      UPDATE users 
      SET verification_code = ${verificationCode}, verification_code_expires = ${verificationExpires}
      WHERE id = ${user.id}
    `;

    // Send verification email
    const emailResult = await sendVerificationCode(email, verificationCode, user.full_name);

    if (emailResult.success) {
      console.log(`[auth] Verification code resent to ${email}`);
    } else {
      console.log(`[auth] Verification code for ${email}: ${verificationCode} (email not sent: ${emailResult.reason})`);
    }

    res.json({
      success: true,
      message: 'A new verification code has been sent to your email.',
      expiresIn: '15 minutes'
    });

  } catch (err) {
    console.error('[auth] resend-verification error:', err);
    res.status(500).json({ error: 'Failed to resend verification code' });
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
    const adminPassword = process.env.GLOWMATCH_ADMIN_PASSWORD;
    if (!adminPassword) {
      return res.status(400).json({ error: 'GLOWMATCH_ADMIN_PASSWORD environment variable is required' });
    }
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

// ==================== GOOGLE OAUTH ====================

// POST /api/auth/google-check - Check if Google user exists (without creating account)
router.post('/google-check', async (req, res) => {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }

    // Verify the Google token
    const googleVerifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`;

    let googleUser;
    try {
      const response = await fetch(googleVerifyUrl);
      if (!response.ok) {
        throw new Error('Invalid Google token');
      }
      googleUser = await response.json();
    } catch (e) {
      console.error('[auth/google-check] Token verification failed:', e.message);
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { email, name } = googleUser;

    if (!email) {
      return res.status(400).json({ error: 'Email not provided by Google' });
    }

    // Check if user exists
    const existingUsers = await sql`SELECT id, email, role FROM users WHERE email = ${email}`;

    if (existingUsers && existingUsers.length > 0) {
      return res.json({ exists: true, email, name });
    } else {
      return res.json({ exists: false, email, name });
    }

  } catch (err) {
    console.error('[auth/google-check] Error:', err);
    res.status(500).json({ error: 'Failed to check user' });
  }
});

// POST /api/auth/google - Sign in or sign up with Google
router.post('/google', async (req, res) => {
  try {
    const { credential, accountType } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }

    // Decode the Google JWT token (credential is a JWT from Google)
    // We verify it by fetching token info from Google
    const googleVerifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`;

    let googleUser;
    try {
      const response = await fetch(googleVerifyUrl);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[auth/google] Google API error:', response.status, errorText);
        throw new Error('Invalid Google token');
      }
      googleUser = await response.json();
      console.log('[auth/google] Google user verified:', googleUser.email);
    } catch (e) {
      console.error('[auth/google] Token verification failed:', e.message);
      return res.status(401).json({ error: 'Invalid Google token', details: e.message });
    }

    const { email, name, picture, sub: googleId } = googleUser;

    if (!email) {
      return res.status(400).json({ error: 'Email not provided by Google' });
    }

    // Check if user exists
    const existingUsers = await sql`SELECT * FROM users WHERE email = ${email}`;

    if (existingUsers && existingUsers.length > 0) {
      // User exists - log them in
      const user = existingUsers[0];
      console.log('[auth/google] Existing user logging in:', email, 'role:', user.role);

      // Check if user is deleted or disabled
      if (user.deleted) {
        return res.status(403).json({
          error: 'Account deleted',
          message: 'Your account has been deleted. Contact support for more information.'
        });
      }
      if (user.disabled) {
        return res.status(403).json({
          error: 'Account disabled',
          message: user.status_message || 'Your account has been disabled'
        });
      }

      // Update Google info if needed
      if (!user.google_id) {
        try {
          await sql`UPDATE users SET google_id = ${googleId}, avatar_url = ${picture || user.avatar_url} WHERE id = ${user.id}`;
          console.log('[auth/google] Updated google_id for existing user');
        } catch (e) {
          console.warn('[auth/google] Failed to update google_id:', e.message);
        }
      }

      // Check if email is verified
      if (!user.email_verified) {
        // Generate new verification code if needed
        let currentCode = user.verification_code;
        const codeExpired = !user.verification_code_expires || new Date(user.verification_code_expires) < new Date();

        if (codeExpired) {
          currentCode = Math.floor(100000 + Math.random() * 900000).toString();
          const newExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
          await sql`UPDATE users SET verification_code = ${currentCode}, verification_code_expires = ${newExpires} WHERE id = ${user.id}`;

          const emailResult = await sendVerificationCode(email, currentCode, user.full_name);
          if (emailResult.success) {
            console.log(`[auth/google] Verification code sent to ${email}`);
          } else {
            console.log(`[auth/google] Verification code for ${email}: ${currentCode}`);
          }
        }

        return res.status(403).json({
          error: 'Email not verified',
          requiresVerification: true,
          email: user.email,
          message: 'Please verify your email before logging in.'
        });
      }

      const token = signToken({ id: user.id, email: user.email, role: user.role });
      console.log('[auth/google] Login successful for:', email);

      return res.json({
        data: {
          user: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role: user.role,
            avatar_url: user.avatar_url || picture,
            referral_code: user.referral_code,
            email_verified: true
          },
          token,
          isNewUser: false
        }
      });
    }

    // User doesn't exist - create new account
    console.log('[auth/google] Creating new user:', email, 'accountType:', accountType);

    // Check if signup is blocked
    const role = accountType === 'seller' ? 'seller' : 'user';
    try {
      const blockKey = role === 'seller' ? 'block_seller_signup' : 'block_user_signup';
      const blockRow = await sql`SELECT value FROM site_settings WHERE key = ${blockKey}`;
      if (blockRow && blockRow.length > 0 && blockRow[0].value === 'true') {
        return res.status(403).json({
          error: 'Signup blocked',
          message: role === 'seller' ? 'Seller registration is temporarily disabled.' : 'User registration is temporarily disabled.'
        });
      }
    } catch (e) {
      // Table might not exist
    }

    const id = uuidv4();
    const myReferralCode = uuidv4().slice(0, 8).toUpperCase();
    const fullName = name || email.split('@')[0];

    // Generate verification code for new user
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const verificationExpires = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    // Create user without password (Google-only account) with email_verified = 0
    try {
      await sql`
        INSERT INTO users (id, email, password_hash, full_name, role, referral_code, google_id, avatar_url, email_verified, verification_code, verification_code_expires, created_at, updated_at)
        VALUES (${id}, ${email}, '', ${fullName}, ${role}, ${myReferralCode}, ${googleId}, ${picture || null}, 0, ${verificationCode}, ${verificationExpires}, NOW(), NOW())
      `;
      console.log('[auth/google] User created:', id);
    } catch (e) {
      console.error('[auth/google] Failed to create user:', e.message);
      // Check if it's a duplicate - race condition
      if (e.message?.includes('duplicate') || e.message?.includes('unique')) {
        const existing = await sql`SELECT * FROM users WHERE email = ${email}`;
        if (existing && existing.length > 0) {
          const user = existing[0];
          const token = signToken({ id: user.id, email: user.email, role: user.role });
          return res.json({
            data: {
              user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role },
              token,
              isNewUser: false
            }
          });
        }
      }
      throw e;
    }

    // Create user_profiles mirror (IMPORTANT - was missing!)
    try {
      await sql`
        INSERT INTO user_profiles (id, email, full_name, role, referral_code, avatar_url)
        VALUES (${id}, ${email}, ${fullName}, ${role}, ${myReferralCode}, ${picture || null})
      `;
      console.log('[auth/google] User profile created');
    } catch (e) {
      console.warn('[auth/google] Failed to create user_profiles (may not exist):', e.message);
    }

    // Create referral_codes entry
    try {
      await sql`
        INSERT INTO referral_codes (id, code, owner_id, uses_count, created_at)
        VALUES (${uuidv4()}, ${myReferralCode}, ${id}, 0, NOW())
      `;
    } catch (e) {
      console.warn('[auth/google] Failed to create referral_codes:', e.message);
    }

    // Create subscription for new user
    const subId = uuidv4();
    const now = new Date().toISOString();
    const far = new Date();
    far.setFullYear(far.getFullYear() + 1);

    try {
      await sql`
        INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
        VALUES (${subId}, ${id}, 'active', null, ${now}, ${far.toISOString()}, 0, 5, ${now})
      `;
      console.log('[auth/google] Subscription created');
    } catch (e) {
      console.warn('[auth/google] Failed to create subscription:', e.message);
    }

    // Send verification email
    const emailResult = await sendVerificationCode(email, verificationCode, fullName);
    if (emailResult.success) {
      console.log(`[auth/google] Verification code sent to ${email}`);
    } else {
      console.log(`[auth/google] Verification code for ${email}: ${verificationCode} (email not sent: ${emailResult.reason})`);
    }

    console.log('[auth/google] New user signup - requires verification:', email, 'role:', role);

    // Return success but require verification (no token until verified)
    res.json({
      data: {
        user: {
          id,
          email,
          full_name: fullName,
          role,
          referral_code: myReferralCode,
          avatar_url: picture,
          email_verified: false
        },
        requiresVerification: true,
        isNewUser: true,
        message: 'Account created! Please check your email for the verification code.'
      }
    });

  } catch (err) {
    console.error('[auth/google] Error:', err.stack || err);
    res.status(500).json({ error: 'Google authentication failed', details: err.message });
  }
});

module.exports = router;
