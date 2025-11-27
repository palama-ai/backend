const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';

console.log('[backend/routes/admin] admin routes loaded');

// helper: check whether `users` table contains a named column
function usersHasColumn(name) {
  try {
    // Always read current schema to avoid stale cache when DB was migrated after this module loaded
    const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
    return cols.includes(name);
  } catch (e) {
    return false;
  }
}

// Unprotected debug endpoints (dev only) to help diagnose issues from the frontend
router.get('/debug/users', (req, res) => {
  try {
    let users;
    try {
      users = db.prepare(`SELECT u.id, u.email, u.full_name, u.role, u.disabled
        FROM users u ORDER BY u.created_at DESC`).all();
    } catch (e) {
      // older DB might not have `disabled` column; fall back to a compatible projection
      console.warn('[backend/routes/admin] debug/users fallback projection due to error', e && e.message);
      users = db.prepare(`SELECT id, email, full_name, role FROM users ORDER BY created_at DESC`).all()
        .map(u => ({ ...u, disabled: 0 }));
    }
    const enriched = users.map(u => {
      const sub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(u.id);
      return { ...u, subscription: sub || null };
    });
    res.json({ data: enriched });
  } catch (e) {
    console.error('[backend/routes/admin] debug/users error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to list users (debug)' });
  }
});

router.get('/debug/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as total FROM users').get().total || 0;
    const disabled = db.prepare('SELECT COUNT(*) as disabled FROM users WHERE disabled = 1').get().disabled || 0;
    const active = total - disabled;
    const subscribedUsersRow = db.prepare("SELECT COUNT(DISTINCT user_id) AS subscribedCount FROM user_subscriptions WHERE status = 'active'").get();
    const subscribed = (subscribedUsersRow && subscribedUsersRow.subscribedCount) ? subscribedUsersRow.subscribedCount : 0;
    const plans = db.prepare("SELECT plan_id, COUNT(*) as count FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id").all();
    const planBreakdown = {};
    plans.forEach(p => { planBreakdown[p.plan_id || 'none'] = p.count; });
    res.json({ data: { total, active, disabled, subscribed, planBreakdown } });
  } catch (e) {
    console.error('[backend/routes/admin] debug/stats error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute stats (debug)' });
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

// List users (with profile and subscription)
router.get('/users', requireAdmin, (req, res) => {
  console.log('[backend/routes/admin] GET /users called by', req.admin ? req.admin.sub : 'unknown');
  console.log('[backend/routes/admin] request headers:', Object.keys(req.headers).reduce((acc, k) => ({ ...acc, [k]: req.headers[k] }), {}));
  try {
    // quick DB probe to ensure DB is usable
    try {
      const probe = db.prepare('SELECT 1 as ok').get();
      console.log('[backend/routes/admin] db probe result:', probe);
    } catch (probeErr) {
      console.error('[backend/routes/admin] DB probe failed', probeErr && probeErr.stack ? probeErr.stack : probeErr);
    }

    let users;
    try {
      users = db.prepare(`SELECT u.id, u.email, u.full_name, u.role, u.disabled, up.updated_at as profile_updated
        FROM users u LEFT JOIN user_profiles up ON up.id = u.id ORDER BY u.created_at DESC`).all();
    } catch (e) {
      console.warn('[backend/routes/admin] /users fallback projection, missing column?', e && e.message);
      users = db.prepare(`SELECT u.id, u.email, u.full_name, u.role, up.updated_at as profile_updated
        FROM users u LEFT JOIN user_profiles up ON up.id = u.id ORDER BY u.created_at DESC`).all()
        .map(u => ({ ...u, disabled: 0 }));
    }
    // attach active subscription info
    const enriched = users.map(u => {
      try {
        const sub = db.prepare('SELECT * FROM user_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(u.id);
        return { ...u, subscription: sub || null };
      } catch (subErr) {
        console.error('[backend/routes/admin] failed fetching subscription for user', u.id, subErr && subErr.stack ? subErr.stack : subErr);
        return { ...u, subscription: null };
      }
    });
    res.json({ data: enriched });
  } catch (e) {
    console.error('admin/users error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// DEBUG: list recent site_sessions and page_views
router.get('/debug/sessions', requireAdmin, (req, res) => {
  try {
    const sessions = db.prepare('SELECT session_id, user_id, path, started_at, last_ping_at, duration_seconds, updated_at FROM site_sessions ORDER BY updated_at DESC LIMIT 200').all();
    const views = db.prepare('SELECT id, session_id, user_id, path, created_at FROM page_views ORDER BY created_at DESC LIMIT 200').all();
    res.json({ data: { sessions, views } });
  } catch (e) {
    console.error('[backend/routes/admin] debug/sessions error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to fetch debug sessions' });
  }
});

// GET /api/admin/stats - return aggregated admin stats (counts)
router.get('/stats', requireAdmin, (req, res) => {
  try {
    console.log('[backend/routes/admin] GET /stats called by', req.admin ? req.admin.sub : 'unknown');
    const totalRow = db.prepare('SELECT COUNT(*) as total FROM users').get();
    const total = (totalRow && totalRow.total) ? totalRow.total : 0;
    let disabled = 0;
    try {
      const disabledRow = db.prepare('SELECT COUNT(*) as disabled FROM users WHERE disabled = 1').get();
      disabled = (disabledRow && disabledRow.disabled) ? disabledRow.disabled : 0;
    } catch (e) {
      console.warn('[backend/routes/admin] stats: users.disabled missing, defaulting disabled=0');
      disabled = 0;
    }
    const active = total - disabled;

    const subscribedUsersRow = db.prepare("SELECT COUNT(DISTINCT user_id) AS subscribedCount FROM user_subscriptions WHERE status = 'active'").get();
    const subscribed = (subscribedUsersRow && subscribedUsersRow.subscribedCount) ? subscribedUsersRow.subscribedCount : 0;

    // Breakdown by plan
    const plans = db.prepare("SELECT plan_id, COUNT(*) as count FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id").all();
    const planBreakdown = {};
    plans.forEach(p => {
      planBreakdown[p.plan_id || 'none'] = p.count;
    });

    res.json({ data: { total, active, disabled, subscribed, planBreakdown } });
  } catch (e) {
    console.error('admin/stats error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Analytics endpoint: daily active users (by quiz attempts), new subscriptions (as conversions), and new users
router.get('/analytics', requireAdmin, (req, res) => {
  try {
    const range = parseInt(req.query.range, 10) || 7; // days
    const days = Math.max(1, Math.min(365, range));
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - (days - 1));
    const startISO = start.toISOString();

    // aggregate daily distinct active users from quiz_attempts
    const activeRows = db.prepare(
      `SELECT date(attempt_date) as day, COUNT(DISTINCT user_id) as activeUsers
       FROM quiz_attempts WHERE attempt_date >= ? GROUP BY day ORDER BY day ASC`
    ).all(startISO);

    // aggregate daily new (active) subscriptions -> treat as conversions
    const convRows = db.prepare(
      `SELECT date(current_period_start) as day, COUNT(*) as conversions
       FROM user_subscriptions WHERE status = 'active' AND current_period_start >= ? GROUP BY day ORDER BY day ASC`
    ).all(startISO);

    // new users per day
    const newUsersRows = db.prepare(
      `SELECT date(created_at) as day, COUNT(*) as newUsers FROM users WHERE created_at >= ? GROUP BY day ORDER BY day ASC`
    ).all(startISO);

    // attempts per day (total quiz attempts)
    let attemptsRows = [];
    try {
      attemptsRows = db.prepare(
        `SELECT date(attempt_date) as day, COUNT(*) as attempts FROM quiz_attempts WHERE attempt_date >= ? GROUP BY day ORDER BY day ASC`
      ).all(startISO);
    } catch (e) {
      // fallback to created_at if attempt_date doesn't exist
      attemptsRows = db.prepare(
        `SELECT date(created_at) as day, COUNT(*) as attempts FROM quiz_attempts WHERE created_at >= ? GROUP BY day ORDER BY day ASC`
      ).all(startISO);
    }

    // build maps for quick lookup
    const activeMap = {};
    activeRows.forEach(r => { activeMap[r.day] = r.activeUsers || 0; });
    const convMap = {};
    convRows.forEach(r => { convMap[r.day] = r.conversions || 0; });
    const newUsersMap = {};
    newUsersRows.forEach(r => { newUsersMap[r.day] = r.newUsers || 0; });
    const attemptsMap = {};
    attemptsRows.forEach(r => { attemptsMap[r.day] = r.attempts || 0; });

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
      const durRows = db.prepare(
        `SELECT date(started_at) as day, AVG(duration_seconds) as avg_duration FROM site_sessions WHERE duration_seconds IS NOT NULL AND started_at >= ? GROUP BY day ORDER BY day ASC`
      ).all(startISO);
      durRows.forEach(r => { durationMap[r.day] = Math.round(r.avg_duration || 0); });
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
      const cutoffLive = new Date(); cutoffLive.setSeconds(cutoffLive.getSeconds() - 60);
      const cutoffISO = cutoffLive.toISOString();
      const row = db.prepare('SELECT COUNT(DISTINCT session_id) as c FROM site_sessions WHERE last_ping_at >= ?').get(cutoffISO);
      liveUsers = (row && row.c) ? row.c : 0;
    } catch (e) {
      console.warn('[backend/routes/admin] live users computation failed', e && e.message);
      liveUsers = 0;
    }

    // Visit counts for several ranges (days)
    const visitRanges = [1,7,15,30,90];
    const visitCounts = {};
    try {
      const nowISO = new Date().toISOString();
      visitRanges.forEach(n => {
        const since = new Date(); since.setDate(since.getDate() - (n - 1));
        const sinceISO = since.toISOString();
        const r = db.prepare('SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?').get(sinceISO);
        visitCounts[n] = (r && r.c) ? r.c : 0;
      });
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
    function sumDistinctActiveBetween(fromISO, toISO) {
      try {
        const row = db.prepare(
          `SELECT COUNT(DISTINCT user_id) as c FROM quiz_attempts WHERE attempt_date >= ? AND attempt_date < ?`
        ).get(fromISO, toISO);
        return (row && row.c) ? row.c : 0;
      } catch (e) {
        // fallback to created_at
        const row = db.prepare(
          `SELECT COUNT(DISTINCT user_id) as c FROM quiz_attempts WHERE created_at >= ? AND created_at < ?`
        ).get(fromISO, toISO);
        return (row && row.c) ? row.c : 0;
      }
    }

    function sumAttemptsBetween(fromISO, toISO) {
      try {
        const row = db.prepare(`SELECT COUNT(*) as c FROM quiz_attempts WHERE attempt_date >= ? AND attempt_date < ?`).get(fromISO, toISO);
        return (row && row.c) ? row.c : 0;
      } catch (e) {
        const row = db.prepare(`SELECT COUNT(*) as c FROM quiz_attempts WHERE created_at >= ? AND created_at < ?`).get(fromISO, toISO);
        return (row && row.c) ? row.c : 0;
      }
    }

    function sumConversionsBetween(fromISO, toISO) {
      const row = db.prepare(`SELECT COUNT(*) as c FROM user_subscriptions WHERE status = 'active' AND current_period_start >= ? AND current_period_start < ?`).get(fromISO, toISO);
      return (row && row.c) ? row.c : 0;
    }

    const prevActive = sumDistinctActiveBetween(prevStartISO, startISO);
    const prevAttempts = sumAttemptsBetween(prevStartISO, startISO);
    const prevConv = sumConversionsBetween(prevStartISO, startISO);
    const prevNewUsersRow = db.prepare(`SELECT COUNT(*) as c FROM users WHERE created_at >= ? AND created_at < ?`).get(prevStartISO, startISO);
    const prevNewUsers = (prevNewUsersRow && prevNewUsersRow.c) ? prevNewUsersRow.c : 0;

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

    res.json({ data: {
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
    } });
  } catch (e) {
    console.error('[backend/routes/admin] analytics error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// Update user (enable/disable or role)
router.patch('/users/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const { disabled, role, status_message, deleted } = req.body;
    if (typeof disabled !== 'undefined' && usersHasColumn('disabled')) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    }
    if (typeof role !== 'undefined') {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (typeof status_message !== 'undefined' && usersHasColumn('status_message')) {
      db.prepare('UPDATE users SET status_message = ? WHERE id = ?').run(status_message, id);
      try {
        // Create a notification for the user when admin sets a status_message
        const nid = uuidv4();
        db.prepare('INSERT INTO notifications (id, title, body, sender_id, target_all, created_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)')
          .run(nid, 'Account Notice', status_message, req.admin?.id || null);
        db.prepare('INSERT INTO user_notifications (id, notification_id, user_id, read, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)')
          .run(uuidv4(), nid, id);
      } catch (e) {
        console.warn('Failed to create notification for status_message:', e && e.message);
      }
    }
    if (typeof deleted !== 'undefined' && usersHasColumn('deleted')) {
      // mark deleted flag (soft delete)
      db.prepare('UPDATE users SET deleted = ? WHERE id = ?').run(deleted ? 1 : 0, id);
    }
    const user = db.prepare('SELECT id, email, full_name, role, disabled FROM users WHERE id = ?').get(id);
    res.json({ data: user });
  } catch (e) {
    console.error('admin/users update error', e);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Soft-delete a user (mark deleted = 1). Admin-only.
router.delete('/users/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    console.log('[admin] DELETE /users/:id called by', req.admin?.id, 'target:', id);
    if (usersHasColumn('deleted')) {
      const r = db.prepare('UPDATE users SET deleted = 1 WHERE id = ?').run(id);
      console.log('[admin] soft-delete result:', r);
      res.json({ data: { id, deleted: 1 } });
    } else {
      // fallback: remove user row entirely
      const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
      console.log('[admin] hard-delete result:', r);
      res.json({ data: { id, deleted: 1 } });
    }
  } catch (e) {
    console.error('admin/users delete error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to delete user', details: e && (e.message || e) });
  }
});

// Set subscription/plan for a user (create or update active subscription)
router.post('/users/:id/subscription', requireAdmin, (req, res) => {
  try {
    const userId = req.params.id;
    const { planId, status } = req.body;
    const id = uuidv4();
    const now = new Date().toISOString();
    const oneYear = new Date(); oneYear.setFullYear(oneYear.getFullYear() + 1);
    // create a new subscription record
    db.prepare('INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, status || 'active', planId || null, now, oneYear.toISOString(), 0, 999999, now);
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(id);
    res.json({ data: sub });
  } catch (e) {
    console.error('admin set subscription error', e);
    res.status(500).json({ error: 'Failed to set subscription' });
  }
});

// Blogs CRUD
router.get('/blogs', requireAdmin, (req, res) => {
  try {
    const blogs = db.prepare('SELECT * FROM blogs ORDER BY created_at DESC').all();
    res.json({ data: blogs });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to list blogs' }); }
});

router.post('/blogs', requireAdmin, (req, res) => {
  try {
    const { title, slug, excerpt, content, published, image_url } = req.body;
    console.log('[backend/admin] POST /blogs - incoming data:', { title, slug, published });
    const id = uuidv4();
    db.prepare('INSERT INTO blogs (id, slug, title, excerpt, content, image_url, published) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, slug, title, excerpt, content, image_url || null, published ? 1 : 0);
    const blog = db.prepare('SELECT * FROM blogs WHERE id = ?').get(id);
    console.log('[backend/admin] POST /blogs - saved blog:', blog);
    res.json({ data: blog });
  } catch (e) { console.error('[backend/admin] POST /blogs error:', e); res.status(500).json({ error: 'Failed to create blog' }); }
});

router.put('/blogs/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const { title, slug, excerpt, content, published, image_url } = req.body;
    db.prepare('UPDATE blogs SET title = ?, slug = ?, excerpt = ?, content = ?, image_url = ?, published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(title, slug, excerpt, content, image_url || null, published ? 1 : 0, id);
    const blog = db.prepare('SELECT * FROM blogs WHERE id = ?').get(id);
    res.json({ data: blog });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to update blog' }); }
});

router.delete('/blogs/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    db.prepare('DELETE FROM blogs WHERE id = ?').run(id);
    res.json({ data: { id } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to delete blog' }); }
});

// Contact messages
router.get('/messages', requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
    res.json({ data: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to list messages' }); }
});

router.get('/messages/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(id);
    if (msg && !msg.read) {
      db.prepare('UPDATE contact_messages SET read = 1 WHERE id = ?').run(id);
    }
    res.json({ data: msg });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to get message' }); }
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

module.exports = router;