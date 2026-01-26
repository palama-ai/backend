const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
  process.exit(1);
}

console.log('[backend/routes/admin] admin routes loaded');

// Initialize site_settings table if not exists
(async () => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS site_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    // Initialize default signup block settings if not exist
    await sql`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('block_user_signup', 'false', NOW())
      ON CONFLICT (key) DO NOTHING
    `;
    await sql`
      INSERT INTO site_settings (key, value, updated_at)
      VALUES ('block_seller_signup', 'false', NOW())
      ON CONFLICT (key) DO NOTHING
    `;
    console.log('[backend/routes/admin] site_settings table ready');
  } catch (e) {
    console.warn('[backend/routes/admin] site_settings init warning:', e?.message);
  }
})();

// Public endpoint: Get signup block status (no auth required)
router.get('/signup-status', async (req, res) => {
  try {
    const rows = await sql`SELECT key, value FROM site_settings WHERE key IN ('block_user_signup', 'block_seller_signup')`;
    const result = { blockUserSignup: false, blockSellerSignup: false };
    for (const row of rows) {
      if (row.key === 'block_user_signup') result.blockUserSignup = row.value === 'true';
      if (row.key === 'block_seller_signup') result.blockSellerSignup = row.value === 'true';
    }
    res.json({ data: result });
  } catch (e) {
    console.error('[admin] signup-status error:', e?.message);
    res.json({ data: { blockUserSignup: false, blockSellerSignup: false } });
  }
});

// Helper to check admin auth (used before requireAdmin middleware is defined)
function checkAdminAuth(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const token = auth.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    return payload?.role === 'admin' ? payload : null;
  } catch (e) { return null; }
}

// Debug endpoints - NOW PROTECTED (require admin auth)
router.get('/debug/users', async (req, res) => {
  try {
    const admin = checkAdminAuth(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const users = await sql`SELECT u.id, u.email, u.full_name, u.role, u.disabled FROM users u ORDER BY u.created_at DESC`;

    const enriched = [];
    for (const u of users) {
      const subResult = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${u.id} ORDER BY updated_at DESC LIMIT 1`;
      enriched.push({ ...u, subscription: subResult && subResult.length > 0 ? subResult[0] : null });
    }
    res.json({ data: enriched });
  } catch (e) {
    console.error('[backend/routes/admin] debug/users error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.get('/debug/stats', async (req, res) => {
  try {
    const admin = checkAdminAuth(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    const totalRow = await sql`SELECT COUNT(*) as total FROM users`;
    const total = totalRow && totalRow.length > 0 ? parseInt(totalRow[0].total) : 0;

    const disabledRow = await sql`SELECT COUNT(*) as disabled FROM users WHERE disabled = 1`;
    const disabled = disabledRow && disabledRow.length > 0 ? parseInt(disabledRow[0].disabled) : 0;
    const active = total - disabled;

    const subscribedRow = await sql`SELECT COUNT(DISTINCT user_id) AS subscribedcount FROM user_subscriptions WHERE status = 'active'`;
    const subscribed = subscribedRow && subscribedRow.length > 0 ? parseInt(subscribedRow[0].subscribedcount) : 0;

    const plansResult = await sql`SELECT plan_id, COUNT(*) as count FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id`;
    const planBreakdown = {};
    for (const p of plansResult) {
      planBreakdown[p.plan_id || 'none'] = parseInt(p.count);
    }

    res.json({ data: { total, active, disabled, subscribed, planBreakdown } });
  } catch (e) {
    console.error('[backend/routes/admin] debug/stats error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Migration endpoint - NOW PROTECTED (admin only)
router.post('/fix-url-columns', async (req, res) => {
  try {
    const admin = checkAdminAuth(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    console.log('[admin] Running URL columns fix...');
    const results = [];

    // Fix seller_products URLs
    try {
      await sql`ALTER TABLE seller_products ALTER COLUMN image_url TYPE TEXT`;
      await sql`ALTER TABLE seller_products ALTER COLUMN purchase_url TYPE TEXT`;
      results.push('seller_products: fixed');
    } catch (e) {
      results.push('seller_products: ' + (e.message?.substring(0, 50) || 'already TEXT'));
    }

    // Fix blogs image_url
    try {
      await sql`ALTER TABLE blogs ALTER COLUMN image_url TYPE TEXT`;
      results.push('blogs.image_url: fixed');
    } catch (e) {
      results.push('blogs.image_url: ' + (e.message?.substring(0, 50) || 'already TEXT'));
    }

    console.log('[admin] URL columns fix results:', results);
    res.json({ success: true, message: 'URL columns updated to TEXT', results });
  } catch (e) {
    console.error('[admin] URL fix error:', e);
    res.json({ success: false, error: e.message, note: 'Migration failed' });
  }
});

// Migration endpoint - NOW PROTECTED (admin only)
router.post('/create-reviews-tables', async (req, res) => {
  const admin = checkAdminAuth(req);
  if (!admin) return res.status(403).json({ error: 'Admin access required' });

  const results = [];
  try {
    console.log('[admin] Creating product reviews tables...');

    // Create product_ratings table
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS product_ratings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          product_id UUID,
          user_id UUID,
          rating INTEGER,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      results.push('product_ratings: created');
    } catch (e) {
      results.push('product_ratings: ' + e.message);
    }

    // Create product_comments table
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS product_comments (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          product_id UUID,
          user_id UUID,
          parent_id UUID,
          content TEXT,
          likes_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `;
      results.push('product_comments: created');
    } catch (e) {
      results.push('product_comments: ' + e.message);
    }

    // Create comment_likes table
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS comment_likes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          comment_id UUID,
          user_id UUID,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `;
      results.push('comment_likes: created');
    } catch (e) {
      results.push('comment_likes: ' + e.message);
    }

    console.log('[admin] Product reviews tables results:', results);
    res.json({ success: true, results });
  } catch (e) {
    console.error('[admin] create-reviews-tables error:', e);
    res.status(500).json({ error: e.message, results });
  }
});

// Database migration endpoint - creates missing tables - NOW PROTECTED
router.post('/db-migrate', async (req, res) => {
  try {
    const admin = checkAdminAuth(req);
    if (!admin) return res.status(403).json({ error: 'Admin access required' });

    console.log('[admin] Running database migration...');

    // Add seller columns to user_profiles if not exist
    try {
      await sql`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255)`;
      await sql`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS website VARCHAR(500)`;
      await sql`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bio TEXT`;
      console.log('[admin] Added seller columns to user_profiles');
    } catch (e) { console.log('[admin] user_profiles columns:', e.message); }

    // Create seller_products table
    await sql`
      CREATE TABLE IF NOT EXISTS seller_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        brand VARCHAR(255),
        description TEXT,
        price DECIMAL(10,2),
        original_price DECIMAL(10,2),
        image_url TEXT,
        category VARCHAR(100),
        skin_types TEXT,
        concerns TEXT,
        purchase_url TEXT,
        published INTEGER DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[admin] Created seller_products table');

    // Create indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_seller_products_seller_id ON seller_products(seller_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_seller_products_category ON seller_products(category)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_seller_products_published ON seller_products(published)`;

    // Migration: Update column types for longer URLs (if table already exists with VARCHAR)
    try {
      await sql`ALTER TABLE seller_products ALTER COLUMN image_url TYPE TEXT`;
      await sql`ALTER TABLE seller_products ALTER COLUMN purchase_url TYPE TEXT`;
      console.log('[admin] Updated seller_products URL columns to TEXT');
    } catch (e) {
      console.log('[admin] URL columns migration skipped:', e.message?.substring(0, 50));
    }

    // Create product_views table
    await sql`
      CREATE TABLE IF NOT EXISTS product_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        quiz_attempt_id UUID,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[admin] Created product_views table');

    await sql`CREATE INDEX IF NOT EXISTS idx_product_views_product_id ON product_views(product_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_product_views_created_at ON product_views(created_at)`;

    // Add quiz_attempt_id column if not exists (migration)
    try {
      await sql`ALTER TABLE product_views ADD COLUMN IF NOT EXISTS quiz_attempt_id UUID`;
    } catch (e) { /* ignore */ }

    // Create unique index for preventing duplicate views per user per quiz attempt
    try {
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_views_unique ON product_views(product_id, user_id, quiz_attempt_id) WHERE user_id IS NOT NULL AND quiz_attempt_id IS NOT NULL`;
    } catch (e) {
      console.log('[admin] Unique index may already exist:', e.message?.substring(0, 50));
    }

    // Create product_ratings table
    await sql`
      CREATE TABLE IF NOT EXISTS product_ratings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(product_id, user_id)
      )
    `;
    console.log('[admin] Created product_ratings table');
    await sql`CREATE INDEX IF NOT EXISTS idx_product_ratings_product_id ON product_ratings(product_id)`;

    // Create product_comments table (with replies support via parent_id)
    await sql`
      CREATE TABLE IF NOT EXISTS product_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        parent_id UUID,
        content TEXT NOT NULL,
        likes_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[admin] Created product_comments table');
    await sql`CREATE INDEX IF NOT EXISTS idx_product_comments_product_id ON product_comments(product_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_product_comments_parent_id ON product_comments(parent_id)`;

    // Create comment_likes table
    await sql`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        comment_id UUID REFERENCES product_comments(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(comment_id, user_id)
      )
    `;
    console.log('[admin] Created comment_likes table');
    await sql`CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id)`;

    res.json({ success: true, message: 'Database migration completed successfully - all tables created!' });
  } catch (e) {
    console.error('[admin] db-migrate error:', e);
    res.status(500).json({ error: e.message || 'Migration failed' });
  }
});

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    console.log('[backend/routes/admin] requireAdmin - authorization header:', !!auth);
    if (!auth) return res.status(401).json({ error: 'Not authorized' });
    const token = auth.replace('Bearer ', '');
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = payload;
    next();
  } catch (e) {
    console.warn('[backend/routes/admin] requireAdmin error', e && e.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Get signup block settings (admin only)
router.get('/settings/signup-block', requireAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT key, value FROM site_settings WHERE key IN ('block_user_signup', 'block_seller_signup')`;
    const result = { blockUserSignup: false, blockSellerSignup: false };
    for (const row of rows) {
      if (row.key === 'block_user_signup') result.blockUserSignup = row.value === 'true';
      if (row.key === 'block_seller_signup') result.blockSellerSignup = row.value === 'true';
    }
    res.json({ data: result });
  } catch (e) {
    console.error('[admin] get signup-block error:', e?.message);
    res.status(500).json({ error: 'Failed to get signup block settings' });
  }
});

// Update signup block settings (admin only)
router.post('/settings/signup-block', requireAdmin, async (req, res) => {
  try {
    const { blockUserSignup, blockSellerSignup } = req.body;
    console.log('[admin] Updating signup block settings:', { blockUserSignup, blockSellerSignup });

    if (typeof blockUserSignup !== 'undefined') {
      await sql`
        INSERT INTO site_settings (key, value, updated_at)
        VALUES ('block_user_signup', ${blockUserSignup ? 'true' : 'false'}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${blockUserSignup ? 'true' : 'false'}, updated_at = NOW()
      `;
    }

    if (typeof blockSellerSignup !== 'undefined') {
      await sql`
        INSERT INTO site_settings (key, value, updated_at)
        VALUES ('block_seller_signup', ${blockSellerSignup ? 'true' : 'false'}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = ${blockSellerSignup ? 'true' : 'false'}, updated_at = NOW()
      `;
    }

    // Return updated values
    const rows = await sql`SELECT key, value FROM site_settings WHERE key IN ('block_user_signup', 'block_seller_signup')`;
    const result = { blockUserSignup: false, blockSellerSignup: false };
    for (const row of rows) {
      if (row.key === 'block_user_signup') result.blockUserSignup = row.value === 'true';
      if (row.key === 'block_seller_signup') result.blockSellerSignup = row.value === 'true';
    }

    console.log('[admin] Signup block settings updated:', result);
    res.json({ data: result });
  } catch (e) {
    console.error('[admin] update signup-block error:', e);
    res.status(500).json({ error: 'Failed to update signup block settings' });
  }
});

// List all products (admin only)
router.get('/products', requireAdmin, async (req, res) => {
  try {
    console.log('[admin] GET /products called');
    const products = await sql`
      SELECT 
        sp.*,
        u.email as seller_email,
        u.full_name as seller_name
      FROM seller_products sp
      LEFT JOIN users u ON sp.seller_id = u.id
      ORDER BY sp.created_at DESC
    `;
    console.log('[admin] Found', products.length, 'products');
    res.json({ data: products });
  } catch (e) {
    console.error('[admin] products error:', e);
    res.status(500).json({ error: 'Failed to list products' });
  }
});

// List users (with profile and subscription)
router.get('/users', requireAdmin, async (req, res) => {
  console.log('[backend/routes/admin] GET /users called by', req.admin ? req.admin.sub : 'unknown');
  try {
    const users = await sql`
      SELECT u.id, u.email, u.full_name, u.role, u.disabled, up.updated_at as profile_updated
      FROM users u LEFT JOIN user_profiles up ON up.id = u.id ORDER BY u.created_at DESC
    `;

    // attach active subscription info
    const enriched = [];
    for (const u of users) {
      try {
        const subResult = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${u.id} ORDER BY updated_at DESC LIMIT 1`;
        enriched.push({ ...u, subscription: subResult && subResult.length > 0 ? subResult[0] : null });
      } catch (subErr) {
        console.error('[backend/routes/admin] failed fetching subscription for user', u.id);
        enriched.push({ ...u, subscription: null });
      }
    }
    res.json({ data: enriched });
  } catch (e) {
    console.error('admin/users error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// DEBUG: list recent site_sessions and page_views
router.get('/debug/sessions', requireAdmin, async (req, res) => {
  try {
    const sessions = await sql`SELECT session_id, user_id, path, started_at, last_ping_at, duration_seconds, updated_at FROM site_sessions ORDER BY updated_at DESC LIMIT 200`;
    const views = await sql`SELECT id, session_id, user_id, path, created_at FROM page_views ORDER BY created_at DESC LIMIT 200`;
    res.json({ data: { sessions, views } });
  } catch (e) {
    console.error('[backend/routes/admin] debug/sessions error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to fetch debug sessions' });
  }
});

// GET /api/admin/stats - return aggregated admin stats (counts)
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    console.log('[backend/routes/admin] GET /stats called by', req.admin ? req.admin.sub : 'unknown');

    const totalRow = await sql`SELECT COUNT(*) as total FROM users`;
    const total = totalRow && totalRow.length > 0 ? parseInt(totalRow[0].total) : 0;

    const disabledRow = await sql`SELECT COUNT(*) as disabled FROM users WHERE disabled = 1`;
    const disabled = disabledRow && disabledRow.length > 0 ? parseInt(disabledRow[0].disabled) : 0;
    const active = total - disabled;

    const subscribedRow = await sql`SELECT COUNT(DISTINCT user_id) AS subscribedCount FROM user_subscriptions WHERE status = 'active'`;
    const subscribed = subscribedRow && subscribedRow.length > 0 ? parseInt(subscribedRow[0].subscribedcount) : 0;

    // Breakdown by plan
    const plansResult = await sql`SELECT plan_id, COUNT(*) as count FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id`;
    const planBreakdown = {};
    for (const p of plansResult) {
      planBreakdown[p.plan_id || 'none'] = parseInt(p.count);
    }

    res.json({ data: { total, active, disabled, subscribed, planBreakdown } });
  } catch (e) {
    console.error('admin/stats error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Analytics endpoint: daily active users (by quiz attempts), new subscriptions (as conversions), and new users
router.get('/analytics', requireAdmin, async (req, res) => {
  try {
    const range = parseInt(req.query.range, 10) || 7; // days
    const days = Math.max(1, Math.min(365, range));
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (days - 1));
    const startISO = start.toISOString();

    // aggregate daily distinct active users from quiz_attempts - use DATE() for PostgreSQL
    const activeRows = await sql`
      SELECT DATE(attempt_date) as day, COUNT(DISTINCT user_id) as activeusers
      FROM quiz_attempts WHERE attempt_date >= ${startISO} GROUP BY DATE(attempt_date) ORDER BY day ASC
    `;

    // aggregate daily new (active) subscriptions -> treat as conversions
    const convRows = await sql`
      SELECT DATE(current_period_start) as day, COUNT(*) as conversions
      FROM user_subscriptions WHERE status = 'active' AND current_period_start >= ${startISO} 
      GROUP BY DATE(current_period_start) ORDER BY day ASC
    `;

    // new users per day
    const newUsersRows = await sql`
      SELECT DATE(created_at) as day, COUNT(*) as newusers FROM users WHERE created_at >= ${startISO} 
      GROUP BY DATE(created_at) ORDER BY day ASC
    `;

    // attempts per day (total quiz attempts)
    let attemptsRows = [];
    try {
      attemptsRows = await sql`
        SELECT DATE(attempt_date) as day, COUNT(*) as attempts FROM quiz_attempts WHERE attempt_date >= ${startISO} 
        GROUP BY DATE(attempt_date) ORDER BY day ASC
      `;
    } catch (e) {
      // fallback to created_at if attempt_date doesn't exist
      try {
        attemptsRows = await sql`
          SELECT DATE(created_at) as day, COUNT(*) as attempts FROM quiz_attempts WHERE created_at >= ${startISO} 
          GROUP BY DATE(created_at) ORDER BY day ASC
        `;
      } catch (e2) {
        console.warn('[backend/routes/admin] attempts fallback also failed', e2 && e2.message);
        attemptsRows = [];
      }
    }

    // build maps for quick lookup - handle lowercase column names from PostgreSQL
    const activeMap = {};
    activeRows.forEach(r => { activeMap[r.day ? r.day.toISOString().split('T')[0] : ''] = parseInt(r.activeusers) || 0; });
    const convMap = {};
    convRows.forEach(r => { convMap[r.day ? r.day.toISOString().split('T')[0] : ''] = parseInt(r.conversions) || 0; });
    const newUsersMap = {};
    newUsersRows.forEach(r => { newUsersMap[r.day ? r.day.toISOString().split('T')[0] : ''] = parseInt(r.newusers) || 0; });
    const attemptsMap = {};
    attemptsRows.forEach(r => { attemptsMap[r.day ? r.day.toISOString().split('T')[0] : ''] = parseInt(r.attempts) || 0; });

    // fill series per day
    const labels = [];
    const activeSeries = [];
    const convSeries = [];
    const newUsersSeries = [];
    const attemptsSeries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().slice(0, 10); // YYYY-MM-DD
      labels.push(iso);
      activeSeries.push(activeMap[iso] || 0);
      convSeries.push(convMap[iso] || 0);
      newUsersSeries.push(newUsersMap[iso] || 0);
      attemptsSeries.push(attemptsMap[iso] || 0);
    }

    // Session duration series (average session duration per day, from site_sessions.duration_seconds)
    let durationMap = {};
    try {
      const durRows = await sql`
        SELECT DATE(started_at) as day, CAST(AVG(CAST(duration_seconds AS FLOAT)) AS INT) as avg_duration 
        FROM site_sessions WHERE duration_seconds IS NOT NULL AND started_at >= ${startISO} 
        GROUP BY DATE(started_at) ORDER BY day ASC
      `;
      durRows.forEach(r => {
        const dayStr = r.day ? r.day.toISOString().split('T')[0] : '';
        durationMap[dayStr] = r.avg_duration || 0;
      });
    } catch (e) {
      // if table missing or empty, ignore
      console.warn('[backend/routes/admin] duration series unavailable', e && e.message);
    }

    const sessionDurationSeries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      sessionDurationSeries.push(durationMap[iso] || 0);
    }

    // Live users: sessions with last_ping_at in the last 60 seconds
    let liveUsers = 0;
    try {
      const cutoffLive = new Date();
      cutoffLive.setSeconds(cutoffLive.getSeconds() - 60);
      const cutoffISO = cutoffLive.toISOString();
      const row = await sql`SELECT COUNT(DISTINCT session_id) as c FROM site_sessions WHERE last_ping_at >= ${cutoffISO}`;
      liveUsers = (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
    } catch (e) {
      console.warn('[backend/routes/admin] live users computation failed', e && e.message);
      liveUsers = 0;
    }

    // Visit counts for several ranges (days)
    const visitRanges = [1, 7, 15, 30, 90];
    const visitCounts = {};
    try {
      for (const n of visitRanges) {
        const since = new Date();
        since.setDate(since.getDate() - (n - 1));
        const sinceISO = since.toISOString();
        const r = await sql`SELECT COUNT(*) as c FROM page_views WHERE created_at >= ${sinceISO}`;
        visitCounts[n] = (r && r.length > 0 && r[0].c) ? parseInt(r[0].c) : 0;
      }
    } catch (e) {
      console.warn('[backend/routes/admin] visit counts failed', e && e.message);
      visitRanges.forEach(n => { visitCounts[n] = 0; });
    }

    // compute totals for current period
    const totalActive = activeSeries.reduce((s, v) => s + v, 0);
    const totalConv = convSeries.reduce((s, v) => s + v, 0);
    const totalNewUsers = newUsersSeries.reduce((s, v) => s + v, 0);
    const totalAttempts = attemptsSeries.reduce((s, v) => s + v, 0);

    // compute previous period totals (the same length directly before 'start')
    const prevStart = new Date(start);
    prevStart.setDate(start.getDate() - days);
    const prevStartISO = prevStart.toISOString();
    const prevEnd = new Date(start);
    prevEnd.setDate(start.getDate() - 1);
    const prevEndISO = prevEnd.toISOString();

    // helper to get totals for previous range
    async function sumDistinctActiveBetween(fromISO, toISO) {
      try {
        const row = await sql`
          SELECT COUNT(DISTINCT user_id) as c FROM quiz_attempts WHERE attempt_date >= ${fromISO} AND attempt_date < ${toISO}
        `;
        return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
      } catch (e) {
        // fallback to created_at
        try {
          const row = await sql`
            SELECT COUNT(DISTINCT user_id) as c FROM quiz_attempts WHERE created_at >= ${fromISO} AND created_at < ${toISO}
          `;
          return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
        } catch (e2) {
          return 0;
        }
      }
    }

    async function sumAttemptsBetween(fromISO, toISO) {
      try {
        const row = await sql`SELECT COUNT(*) as c FROM quiz_attempts WHERE attempt_date >= ${fromISO} AND attempt_date < ${toISO}`;
        return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
      } catch (e) {
        try {
          const row = await sql`SELECT COUNT(*) as c FROM quiz_attempts WHERE created_at >= ${fromISO} AND created_at < ${toISO}`;
          return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
        } catch (e2) {
          return 0;
        }
      }
    }

    async function sumConversionsBetween(fromISO, toISO) {
      try {
        const row = await sql`
          SELECT COUNT(*) as c FROM user_subscriptions WHERE status = 'active' AND current_period_start >= ${fromISO} AND current_period_start < ${toISO}
        `;
        return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
      } catch (e) {
        return 0;
      }
    }

    async function sumNewUsersBetween(fromISO, toISO) {
      try {
        const row = await sql`SELECT COUNT(*) as c FROM users WHERE created_at >= ${fromISO} AND created_at < ${toISO}`;
        return (row && row.length > 0 && row[0].c) ? parseInt(row[0].c) : 0;
      } catch (e) {
        return 0;
      }
    }

    const prevActive = await sumDistinctActiveBetween(prevStartISO, startISO);
    const prevAttempts = await sumAttemptsBetween(prevStartISO, startISO);
    const prevConv = await sumConversionsBetween(prevStartISO, startISO);
    const prevNewUsers = await sumNewUsersBetween(prevStartISO, startISO);

    // growth calculations (percent change) - handle divide by zero
    function pctChange(prev, cur) {
      if (prev === 0 && cur === 0) return 0;
      if (prev === 0) return 100;
      return Math.round(((cur - prev) / prev) * 100);
    }

    const growth = {
      activePct: pctChange(prevActive, totalActive),
      attemptsPct: pctChange(prevAttempts, totalAttempts),
      convPct: pctChange(prevConv, totalConv),
      newUsersPct: pctChange(prevNewUsers, totalNewUsers),
    };

    res.json({
      data: {
        labels,
        activeSeries,
        convSeries,
        newUsersSeries,
        attemptsSeries,
        sessionDurationSeries,
        liveUsers,
        visitCounts,
        totals: { totalActive, totalConv, totalNewUsers, totalAttempts },
        previousTotals: { prevActive, prevConv, prevNewUsers, prevAttempts },
        growth
      }
    });
  } catch (e) {
    console.error('[backend/routes/admin] analytics error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// Update user (enable/disable or role)
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { disabled, role, status_message, deleted } = req.body;

    if (typeof disabled !== 'undefined') {
      await sql`UPDATE users SET disabled = ${disabled ? 1 : 0} WHERE id = ${id}`;
    }
    if (typeof role !== 'undefined') {
      await sql`UPDATE users SET role = ${role} WHERE id = ${id}`;
    }
    if (typeof status_message !== 'undefined') {
      await sql`UPDATE users SET status_message = ${status_message} WHERE id = ${id}`;
      try {
        // Create a notification for the user when admin sets a status_message
        const nid = uuidv4();
        await sql`
          INSERT INTO notifications (id, title, body, sender_id, target_all, created_at) 
          VALUES (${nid}, 'Account Notice', ${status_message}, ${req.admin?.id || null}, 0, NOW())
        `;
        await sql`
          INSERT INTO user_notifications (id, notification_id, user_id, read, created_at) 
          VALUES (${uuidv4()}, ${nid}, ${id}, 0, NOW())
        `;
      } catch (e) {
        console.warn('Failed to create notification for status_message:', e && e.message);
      }
    }
    if (typeof deleted !== 'undefined') {
      // mark deleted flag (soft delete)
      await sql`UPDATE users SET deleted = ${deleted ? 1 : 0} WHERE id = ${id}`;
    }

    const userResult = await sql`SELECT id, email, full_name, role, disabled FROM users WHERE id = ${id}`;
    const user = userResult && userResult.length > 0 ? userResult[0] : null;
    res.json({ data: user });
  } catch (e) {
    console.error('admin/users update error', e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Soft-delete a user (mark deleted = 1). Admin-only.
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    console.log('[admin] DELETE /users/:id called by', req.admin?.id, 'target:', id);

    // Try to soft-delete first (mark deleted = 1)
    try {
      await sql`UPDATE users SET deleted = 1 WHERE id = ${id}`;
      console.log('[admin] soft-delete successful');
      res.json({ data: { id, deleted: 1 } });
    } catch (e) {
      // fallback: remove user row entirely
      await sql`DELETE FROM users WHERE id = ${id}`;
      console.log('[admin] hard-delete successful');
      res.json({ data: { id, deleted: 1 } });
    }
  } catch (e) {
    console.error('admin/users delete error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to delete user', details: e && (e.message || e) });
  }
});

// Set subscription/plan for a user (create or update active subscription)
router.post('/users/:id/subscription', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { planId, status } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    const oneYear = new Date();
    oneYear.setFullYear(oneYear.getFullYear() + 1);

    // create a new subscription record
    await sql`
      INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) 
      VALUES (${id}, ${userId}, ${status || 'active'}, ${planId || null}, ${now}, ${oneYear.toISOString()}, 0, 999999, ${now})
    `;

    const subResult = await sql`SELECT * FROM user_subscriptions WHERE id = ${id}`;
    const sub = subResult && subResult.length > 0 ? subResult[0] : null;
    res.json({ data: sub });
  } catch (e) {
    console.error('admin set subscription error', e);
    res.status(500).json({ error: 'Failed to set subscription' });
  }
});

// Blogs CRUD
router.get('/blogs', requireAdmin, async (req, res) => {
  try {
    const blogs = await sql`SELECT * FROM blogs ORDER BY created_at DESC`;
    res.json({ data: blogs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list blogs' });
  }
});

router.post('/blogs', requireAdmin, async (req, res) => {
  try {
    const { title, slug, excerpt, content, published, image_url } = req.body;
    console.log('[backend/admin] POST /blogs - incoming data:', { title, slug, published });
    const id = uuidv4();
    await sql`
      INSERT INTO blogs (id, slug, title, excerpt, content, image_url, published) 
      VALUES (${id}, ${slug}, ${title}, ${excerpt}, ${content}, ${image_url || null}, ${published ? 1 : 0})
    `;
    const blogResult = await sql`SELECT * FROM blogs WHERE id = ${id}`;
    const blog = blogResult && blogResult.length > 0 ? blogResult[0] : null;
    console.log('[backend/admin] POST /blogs - saved blog:', blog);
    res.json({ data: blog });
  } catch (e) {
    console.error('[backend/admin] POST /blogs error:', e);

    // Check for duplicate slug error
    if (e.code === '23505' && e.constraint === 'blogs_slug_key') {
      return res.status(400).json({
        error: 'A blog with this slug already exists. Please use a different slug or edit the existing blog.',
        field: 'slug'
      });
    }

    res.status(500).json({ error: 'Failed to create blog' });
  }
});

router.put('/blogs/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { title, slug, excerpt, content, published, image_url } = req.body;
    await sql`
      UPDATE blogs SET title = ${title}, slug = ${slug}, excerpt = ${excerpt}, content = ${content}, 
      image_url = ${image_url || null}, published = ${published ? 1 : 0}, updated_at = NOW() 
      WHERE id = ${id}
    `;
    const blogResult = await sql`SELECT * FROM blogs WHERE id = ${id}`;
    const blog = blogResult && blogResult.length > 0 ? blogResult[0] : null;
    res.json({ data: blog });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update blog' });
  }
});

router.delete('/blogs/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await sql`DELETE FROM blogs WHERE id = ${id}`;
    res.json({ data: { id } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete blog' });
  }
});

// Contact messages
router.get('/messages', requireAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM contact_messages ORDER BY created_at DESC`;
    res.json({ data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.get('/messages/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const msgResult = await sql`SELECT * FROM contact_messages WHERE id = ${id}`;
    const msg = msgResult && msgResult.length > 0 ? msgResult[0] : null;

    if (msg && !msg.read) {
      await sql`UPDATE contact_messages SET read = 1 WHERE id = ${id}`;
    }
    res.json({ data: msg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get message' });
  }
});

// Upload blog image
router.post('/blogs/upload', requireAdmin, (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Image stored as base64 data URL
    // In production, you might want to save to cloud storage (AWS S3, Cloudinary, etc.)
    res.json({ data: { image_url: image } });
  } catch (e) {
    console.error('[backend/admin] upload error:', e);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// ============================================================
// Additional endpoints for Mobile Admin App
// ============================================================

// Get single user by ID
router.get('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const userResult = await sql`
      SELECT u.id, u.email, u.full_name, u.role, u.disabled, u.status_message, u.created_at, u.deleted
      FROM users u WHERE u.id = ${id}
    `;
    const user = userResult && userResult.length > 0 ? userResult[0] : null;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get subscription info
    const subResult = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${id} ORDER BY updated_at DESC LIMIT 1`;
    const subscription = subResult && subResult.length > 0 ? subResult[0] : null;

    res.json({
      data: {
        ...user,
        subscriptionPlan: subscription?.plan_id || 'free',
        subscription
      }
    });
  } catch (e) {
    console.error('admin/users/:id error', e);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Get single blog by ID
router.get('/blogs/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const blogResult = await sql`SELECT * FROM blogs WHERE id = ${id}`;
    const blog = blogResult && blogResult.length > 0 ? blogResult[0] : null;

    if (!blog) {
      return res.status(404).json({ error: 'Blog not found' });
    }

    res.json({ data: blog });
  } catch (e) {
    console.error('admin/blogs/:id error', e);
    res.status(500).json({ error: 'Failed to get blog' });
  }
});

// ============================================================
// Notifications Management
// ============================================================

// Initialize notifications table
(async () => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS admin_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        sent_to VARCHAR(50) DEFAULT 'all',
        sender_id UUID,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[backend/routes/admin] admin_notifications table ready');
  } catch (e) {
    console.warn('[backend/routes/admin] admin_notifications init warning:', e?.message);
  }
})();

// Get all admin notifications
router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const notifications = await sql`
      SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 50
    `;
    res.json({ data: notifications });
  } catch (e) {
    console.error('admin/notifications error', e);
    // Return empty array if table doesn't exist yet
    res.json({ data: [] });
  }
});

// Send notification to all users
router.post('/notifications/send', requireAdmin, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    const id = uuidv4();
    await sql`
      INSERT INTO admin_notifications (id, title, body, sent_to, sender_id, created_at)
      VALUES (${id}, ${title}, ${body}, 'all', ${req.admin?.id || null}, NOW())
    `;

    // Also create notifications for all users
    const users = await sql`SELECT id FROM users WHERE deleted IS NULL OR deleted = 0`;
    for (const user of users) {
      const nid = uuidv4();
      await sql`
        INSERT INTO notifications (id, title, body, sender_id, target_all, created_at)
        VALUES (${nid}, ${title}, ${body}, ${req.admin?.id || null}, 1, NOW())
        ON CONFLICT DO NOTHING
      `;
      await sql`
        INSERT INTO user_notifications (id, notification_id, user_id, read, created_at)
        VALUES (${uuidv4()}, ${nid}, ${user.id}, 0, NOW())
        ON CONFLICT DO NOTHING
      `;
    }

    const result = await sql`SELECT * FROM admin_notifications WHERE id = ${id}`;
    res.json({ data: result && result.length > 0 ? result[0] : { id, title, body, sent_to: 'all' } });
  } catch (e) {
    console.error('admin/notifications/send error', e);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// ============================================================
// Safety Management (Appeals, Problem Sellers, Blacklist)
// ============================================================

// Initialize safety tables
(async () => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS seller_appeals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_name VARCHAR(255),
        reason TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS problem_sellers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID NOT NULL,
        seller_name VARCHAR(255),
        reason TEXT NOT NULL,
        locked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS blacklist (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type VARCHAR(50) NOT NULL,
        value TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[backend/routes/admin] safety tables ready');
  } catch (e) {
    console.warn('[backend/routes/admin] safety tables init warning:', e?.message);
  }
})();

// Get appeals
router.get('/safety/appeals', requireAdmin, async (req, res) => {
  try {
    const appeals = await sql`SELECT * FROM seller_appeals ORDER BY created_at DESC`;
    res.json({ data: appeals });
  } catch (e) {
    console.error('admin/safety/appeals error', e);
    res.json({ data: [] });
  }
});

// Update appeal status
router.patch('/safety/appeals/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { status } = req.body;
    await sql`UPDATE seller_appeals SET status = ${status}, updated_at = NOW() WHERE id = ${id}`;
    const result = await sql`SELECT * FROM seller_appeals WHERE id = ${id}`;
    res.json({ data: result && result.length > 0 ? result[0] : null });
  } catch (e) {
    console.error('admin/safety/appeals update error', e);
    res.status(500).json({ error: 'Failed to update appeal' });
  }
});

// Get problem sellers
router.get('/safety/problem-sellers', requireAdmin, async (req, res) => {
  try {
    const sellers = await sql`SELECT * FROM problem_sellers ORDER BY created_at DESC`;
    res.json({ data: sellers });
  } catch (e) {
    console.error('admin/safety/problem-sellers error', e);
    res.json({ data: [] });
  }
});

// Unlock problem seller
router.patch('/safety/problem-sellers/:id/unlock', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await sql`UPDATE problem_sellers SET locked = false WHERE id = ${id}`;
    res.json({ data: { id, locked: false } });
  } catch (e) {
    console.error('admin/safety/problem-sellers unlock error', e);
    res.status(500).json({ error: 'Failed to unlock seller' });
  }
});

// Get blacklist
router.get('/safety/blacklist', requireAdmin, async (req, res) => {
  try {
    const blacklist = await sql`SELECT * FROM blacklist ORDER BY created_at DESC`;
    res.json({ data: blacklist });
  } catch (e) {
    console.error('admin/safety/blacklist error', e);
    res.json({ data: [] });
  }
});

// Add to blacklist
router.post('/safety/blacklist', requireAdmin, async (req, res) => {
  try {
    const { type, value, reason } = req.body;
    if (!type || !value) {
      return res.status(400).json({ error: 'Type and value are required' });
    }
    const id = uuidv4();
    await sql`
      INSERT INTO blacklist (id, type, value, reason, created_at)
      VALUES (${id}, ${type}, ${value}, ${reason || null}, NOW())
    `;
    const result = await sql`SELECT * FROM blacklist WHERE id = ${id}`;
    res.json({ data: result && result.length > 0 ? result[0] : null });
  } catch (e) {
    console.error('admin/safety/blacklist add error', e);
    res.status(500).json({ error: 'Failed to add to blacklist' });
  }
});

// Remove from blacklist
router.delete('/safety/blacklist/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    await sql`DELETE FROM blacklist WHERE id = ${id}`;
    res.json({ data: { id } });
  } catch (e) {
    console.error('admin/safety/blacklist delete error', e);
    res.status(500).json({ error: 'Failed to remove from blacklist' });
  }
});

// Database seed endpoint
router.post('/database/seed', requireAdmin, async (req, res) => {
  try {
    // This is a placeholder - in production, implement actual seeding logic
    console.log('[admin] Database seed requested by', req.admin?.id);
    res.json({ data: { message: 'Database seed completed successfully' } });
  } catch (e) {
    console.error('admin/database/seed error', e);
    res.status(500).json({ error: 'Failed to seed database' });
  }
});

module.exports = router;