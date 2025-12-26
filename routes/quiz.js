const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
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

// autosave - NOW PROTECTED: uses userId from JWT token
router.post('/autosave', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    const userId = payload.id; // Use userId from JWT, not from body
    const { quiz_data } = req.body;

    await sql`
      INSERT INTO quiz_autosave (user_id, quiz_data, updated_at)
      VALUES (${userId}, ${JSON.stringify(quiz_data || {})}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET quiz_data = ${JSON.stringify(quiz_data || {})}, updated_at = NOW()
    `;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to autosave' });
  }
});

router.get('/autosave/:userId', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    // Verify user can only access their own autosave
    if (payload.id !== req.params.userId) {
      return res.status(403).json({ error: 'You can only access your own autosave data' });
    }

    const rows = await sql`SELECT quiz_data, updated_at FROM quiz_autosave WHERE user_id = ${req.params.userId}`;
    if (!rows || rows.length === 0) return res.json({ data: null });
    const row = rows[0];
    res.json({ data: { quiz_data: JSON.parse(row.quiz_data), updated_at: row.updated_at } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch autosave' });
  }
});

// delete autosave
router.delete('/autosave/:userId', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    // Verify user can only delete their own autosave
    if (payload.id !== req.params.userId) {
      return res.status(403).json({ error: 'You can only delete your own autosave data' });
    }

    await sql`DELETE FROM quiz_autosave WHERE user_id = ${req.params.userId}`;
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete autosave' });
  }
});

// save attempt - NOW PROTECTED
router.post('/attempts', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    const userId = payload.id; // Use userId from JWT, not from body
    const { quiz_data, results, has_image_analysis } = req.body;
    if (!quiz_data) return res.status(400).json({ error: 'quiz_data required' });
    const id = uuidv4();

    await sql`
      INSERT INTO quiz_attempts (id, user_id, subscription_id, quiz_data, results, has_image_analysis, attempt_date)
      VALUES (${id}, ${userId}, null, ${JSON.stringify(quiz_data)}, ${JSON.stringify(results || {})}, ${has_image_analysis ? 1 : 0}, NOW())
    `;

    // clear autosave
    await sql`DELETE FROM quiz_autosave WHERE user_id = ${userId}`;

    const attempt = await sql`SELECT * FROM quiz_attempts WHERE id = ${id}`;
    res.json({ data: attempt[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save attempt' });
  }
});

router.get('/history/:userId', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    // Verify user can only access their own history
    if (payload.id !== req.params.userId) {
      return res.status(403).json({ error: 'You can only access your own quiz history' });
    }

    const rows = await sql`SELECT id, attempt_date, quiz_data, results, has_image_analysis, analysis FROM quiz_attempts WHERE user_id = ${req.params.userId} ORDER BY attempt_date DESC`;
    const attempts = rows.map(r => ({
      ...r,
      quiz_data: JSON.parse(r.quiz_data),
      results: JSON.parse(r.results || '{}'),
      analysis: r.analysis ? JSON.parse(r.analysis) : null
    }));
    res.json({ data: attempts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

router.get('/attempts/:id', async (req, res) => {
  try {
    // Require authentication
    const payload = authFromHeader(req);
    if (!payload || !payload.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rows = await sql`SELECT * FROM quiz_attempts WHERE id = ${req.params.id}`;
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Not found' });

    const row = rows[0];

    // Verify user can only view their own attempts
    if (row.user_id !== payload.id) {
      return res.status(403).json({ error: 'You can only view your own quiz attempts' });
    }

    row.quiz_data = JSON.parse(row.quiz_data);
    row.results = JSON.parse(row.results || '{}');
    row.analysis = row.analysis ? JSON.parse(row.analysis) : null;
    res.json({ data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch attempt' });
  }
});

// POST /api/quiz/start
// Consumes one quiz attempt for the authenticated user
router.post('/start', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });
    const userId = payload.id;

    // find active subscription
    const subs = await sql`SELECT * FROM user_subscriptions WHERE user_id = ${userId} AND status = 'active' ORDER BY updated_at DESC LIMIT 1`;
    if (!subs || subs.length === 0) return res.status(404).json({ error: 'No active subscription found' });

    const sub = subs[0];
    const used = sub.quiz_attempts_used || 0;
    const limit = sub.quiz_attempts_limit || 0;
    if (used >= limit) return res.status(403).json({ error: 'No attempts left' });

    await sql`UPDATE user_subscriptions SET quiz_attempts_used = quiz_attempts_used + 1, last_attempt_date = NOW(), updated_at = NOW() WHERE id = ${sub.id}`;

    const updated = await sql`SELECT * FROM user_subscriptions WHERE id = ${sub.id}`;
    res.json({ data: { subscription: updated[0], remaining: (updated[0].quiz_attempts_limit - updated[0].quiz_attempts_used) } });
  } catch (err) {
    console.error('Failed to start quiz attempt', err);
    res.status(500).json({ error: 'Failed to start attempt', details: err?.message || String(err) });
  }
});

// DELETE /api/quiz/attempts/:id - Delete single quiz attempt
router.delete('/attempts/:id', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;

    // Verify ownership
    const attempt = await sql`SELECT id, user_id FROM quiz_attempts WHERE id = ${id}`;
    if (!attempt || attempt.length === 0) {
      return res.status(404).json({ error: 'Quiz attempt not found' });
    }

    if (attempt[0].user_id !== payload.id) {
      return res.status(403).json({ error: 'You can only delete your own quiz attempts' });
    }

    await sql`DELETE FROM quiz_attempts WHERE id = ${id}`;
    res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error('Failed to delete quiz attempt:', err);
    res.status(500).json({ error: 'Failed to delete quiz attempt' });
  }
});

// DELETE /api/quiz/history/:userId - Delete all quiz attempts for user
router.delete('/history/:userId', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    const { userId } = req.params;

    // Verify ownership
    if (userId !== payload.id) {
      return res.status(403).json({ error: 'You can only delete your own quiz history' });
    }

    const result = await sql`DELETE FROM quiz_attempts WHERE user_id = ${userId}`;
    res.json({ success: true, message: 'All quiz attempts deleted' });
  } catch (err) {
    console.error('Failed to delete quiz history:', err);
    res.status(500).json({ error: 'Failed to delete quiz history' });
  }
});

// PUT /api/quiz/attempts/:id/analysis - Save complete analysis data to quiz attempt
router.put('/attempts/:id/analysis', async (req, res) => {
  try {
    const payload = authFromHeader(req);
    if (!payload || !payload.id) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const { analysis } = req.body;

    if (!analysis) {
      return res.status(400).json({ error: 'analysis required in body' });
    }

    // Verify ownership
    const attempt = await sql`SELECT id, user_id FROM quiz_attempts WHERE id = ${id}`;
    if (!attempt || attempt.length === 0) {
      return res.status(404).json({ error: 'Quiz attempt not found' });
    }

    if (attempt[0].user_id !== payload.id) {
      return res.status(403).json({ error: 'You can only update your own quiz attempts' });
    }

    // Update the analysis field with complete AI-generated data
    await sql`UPDATE quiz_attempts SET analysis = ${JSON.stringify(analysis)} WHERE id = ${id}`;

    const updated = await sql`SELECT * FROM quiz_attempts WHERE id = ${id}`;
    if (updated && updated.length > 0) {
      updated[0].quiz_data = JSON.parse(updated[0].quiz_data || '{}');
      updated[0].results = JSON.parse(updated[0].results || '{}');
      updated[0].analysis = JSON.parse(updated[0].analysis || '{}');
    }

    res.json({ success: true, data: updated[0] });
  } catch (err) {
    console.error('Failed to update quiz attempt analysis:', err);
    res.status(500).json({ error: 'Failed to update quiz attempt analysis' });
  }
});

module.exports = router;
