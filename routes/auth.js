const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';
const TOKEN_EXPIRY = '30d';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

router.post('/signup', async (req, res) => {
  try {
    const { email, password, fullName, referralCode } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'User already exists' });

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
      referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referralCode);
    }

    db.prepare('INSERT INTO users (id, email, password_hash, full_name, role, referral_code, referrer_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, password_hash, fullName || null, 'user', myReferralCode, referrer ? referrer.id : null);

    // create profile mirror
    db.prepare('INSERT OR REPLACE INTO user_profiles (id, email, full_name, role, referral_code) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, fullName || null, 'user', myReferralCode);

    // persist canonical referral code in referral_codes table to prevent duplicates
    try {
      const existingCode = db.prepare('SELECT id FROM referral_codes WHERE code = ?').get(myReferralCode);
      if (!existingCode) {
        db.prepare('INSERT INTO referral_codes (id, code, owner_id, uses_count, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)')
          .run(uuidv4(), myReferralCode, id);
      } else {
        // ensure owner_id is set for this code
        db.prepare('UPDATE referral_codes SET owner_id = ? WHERE code = ?').run(id, myReferralCode);
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
    db.prepare('INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(subId, id, 'active', null, now, far.toISOString(), 0, initialAttempts, now);

    // If referred, record referral and grant referrer bonus (2 attempts) subject to cap: max 10 referrals per 15 days
    if (referralCode) {
      // Prefer referral_codes table to find the owner
      const codeRow = db.prepare('SELECT * FROM referral_codes WHERE code = ?').get(referralCode);
      let referrerId = referrer ? referrer.id : null;
      if (codeRow) referrerId = codeRow.owner_id;

      if (referrerId) {
        const refId = uuidv4();
        db.prepare('INSERT INTO referrals (id, referrer_id, referred_id, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)')
          .run(refId, referrerId, id);

        // update referral_codes uses_count/last_used_at if applicable
        if (codeRow) {
          db.prepare('UPDATE referral_codes SET uses_count = uses_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(codeRow.id);
          // reload to get updated uses_count
          const updatedCode = db.prepare('SELECT * FROM referral_codes WHERE id = ?').get(codeRow.id);
          // if the code just reached 10 uses, mark the timestamp
          if ((updatedCode.uses_count || 0) >= 10 && !updatedCode.last_10_reached_at) {
            db.prepare('UPDATE referral_codes SET last_10_reached_at = CURRENT_TIMESTAMP WHERE id = ?').run(codeRow.id);
          }
        }

        // count referrals in last 15 days for this referrer
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 15);
        const cutoffISO = cutoff.toISOString();
        const recentCountRow = db.prepare('SELECT COUNT(*) as c FROM referrals WHERE referrer_id = ? AND created_at >= ?').get(referrerId, cutoffISO);
        const recentCount = (recentCountRow && recentCountRow.c) ? recentCountRow.c : 0;

        // Check code cooldown: if the referral code previously hit 10 uses less than 15 days ago, do not grant until 15 days have passed
        let codeCooldownActive = false;
        if (codeRow && codeRow.last_10_reached_at) {
          const last10 = new Date(codeRow.last_10_reached_at);
          const diffMs = Date.now() - last10.getTime();
          const diffDays = diffMs / (1000 * 60 * 60 * 24);
          if (diffDays < 15) codeCooldownActive = true;
        }

        // allow grants only if referrer has fewer than 10 referrals in the last 15 days AND no active code cooldown
        if (recentCount < 10 && !codeCooldownActive) {
          // grant +2 attempts to referrer
          // find or create subscription for referrer
          let refSub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? LIMIT 1').get(referrerId);
          if (!refSub) {
            const newSubId = uuidv4();
            const now2 = new Date().toISOString();
            const far2 = new Date(); far2.setFullYear(far2.getFullYear() + 1);
            db.prepare('INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(newSubId, referrerId, 'active', null, now2, far2.toISOString(), 0, 2, now2);
          } else {
            try {
              db.prepare('UPDATE user_subscriptions SET quiz_attempts_limit = quiz_attempts_limit + 2, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(refSub.id);
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

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

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
router.get('/session', (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) return res.json({ data: { session: null } });

    const token = auth.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, full_name, role, disabled, deleted, status_message FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.json({ data: { session: null } });

    // If deleted, return null session to force re-login and surface message via client (client may call a debug endpoint)
    if (user.deleted) return res.status(200).json({ data: { session: null, deleted: true, message: 'لقد تم حذف حسابك. راسل support لمعرفة المزيد.' } });

    const session = { user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, disabled: !!user.disabled, status_message: user.status_message || null } };
    return res.json({ data: { session } });
  } catch (err) {
    return res.json({ data: { session: null } });
  }
});

module.exports = router;
