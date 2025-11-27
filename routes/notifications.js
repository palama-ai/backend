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

function requireAdmin(req, res, next) {
  try {
    const payload = authFromHeader(req);
    console.log('[notifications] requireAdmin check - payload:', !!payload, 'role:', payload?.role);
    if (!payload || payload.role !== 'admin') {
      console.warn('[notifications] Admin access denied - role:', payload?.role);
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.admin = payload;
    next();
  } catch (e) {
    console.error('[notifications] requireAdmin error', e.message);
    return res.status(401).json({ error: 'Invalid token', details: e.message });
  }
}

// Admin: list notifications
router.get('/admin', requireAdmin, (req, res) => {
  try {
    console.log('[notifications] admin list request by', req.admin?.id);
    const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200').all();
    console.log('[notifications] returning', rows.length, 'notifications');
    res.json({ data: rows });
  } catch (e) {
    console.error('[notifications] admin list error', e);
    res.status(500).json({ error: 'Failed to list notifications', details: e.message });
  }
});

// Admin: create/send notification
// body: { title, body, target: 'all' | 'users', user_ids: [] }
router.post('/admin', requireAdmin, (req, res) => {
  try {
    const { title, body: msgBody, target, user_ids } = req.body;
    if (!title || !msgBody) return res.status(400).json({ error: 'title and body required' });
    const id = uuidv4();
    const sender = req.admin.id;
    const targetAll = target === 'all' ? 1 : 0;
    db.prepare('INSERT INTO notifications (id, title, body, sender_id, target_all, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(id, title, msgBody, sender, targetAll);

    // create per-user mappings
    if (targetAll) {
      const users = db.prepare("SELECT id FROM users WHERE role != 'admin'").all();
      const ins = db.prepare('INSERT INTO user_notifications (id, notification_id, user_id, read, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)');
      const insertMany = db.transaction((rows) => {
        for (const u of rows) ins.run(uuidv4(), id, u.id);
      });
      insertMany(users);
      console.log(`[notifications] created notification ${id} and linked to ${users.length} users`);
    } else if (Array.isArray(user_ids) && user_ids.length > 0) {
      const ins = db.prepare('INSERT INTO user_notifications (id, notification_id, user_id, read, created_at) VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)');
      const insertMany = db.transaction((rows) => {
        for (const uid of rows) ins.run(uuidv4(), id, uid);
      });
      insertMany(user_ids);
      console.log(`[notifications] created notification ${id} and linked to ${user_ids.length} explicit users`);
    }

    res.json({ data: { id } });
  } catch (e) {
    console.error('notifications admin create error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Failed to create notification' });
  }
});

// User: get my notifications
router.get('/me', (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;
    console.log('[notifications] fetch for user', userId);
    const rows = db.prepare(
      `SELECT un.id as link_id, n.id as notification_id, n.title, n.body, n.sender_id, un.read, un.created_at
       FROM user_notifications un
       JOIN notifications n ON n.id = un.notification_id
       WHERE un.user_id = ? ORDER BY un.created_at DESC LIMIT 200`
    ).all(userId);
    console.log('[notifications] returning', rows.length, 'rows for', userId);
    res.json({ data: rows });
  } catch (e) {
    console.error('notifications me error', e);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// User: mark notification read
router.post('/me/:linkId/read', (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const linkId = req.params.linkId;
    console.log('[notifications] mark read request by user', payload.id, 'link', linkId);
    db.prepare('UPDATE user_notifications SET read = 1 WHERE id = ?').run(linkId);
    res.json({ data: { id: linkId } });
  } catch (e) {
    console.error('notifications mark read error', e);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

module.exports = router;
