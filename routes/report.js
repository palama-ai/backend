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

// Auth helper
function authFromHeader(req) {
  try {
    const auth = req.headers.authorization;
    if (!auth) return null;
    const token = auth.replace('Bearer ', '');
    return jwt.verify(token, JWT_SECRET);
  } catch (e) { return null; }
}

// POST /api/report/upload - NOW PROTECTED
// body: { attemptId, filename, data (base64), analysis? }
// NOTE: File storage is no longer supported in serverless (Vercel is read-only)
router.post('/upload', async (req, res) => {
  try {
    // Require authentication
    const payload = authFromHeader(req);
    if (!payload || !payload.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { attemptId, filename, data, analysis } = req.body;
    if (!filename || !data) return res.status(400).json({ error: 'filename and data are required' });

    // In serverless, we don't write files to disk
    const publicUrl = null;
    const storagePath = null;

    // If attemptId provided, verify ownership and attach to DB
    if (attemptId) {
      try {
        // Verify the attempt belongs to this user
        const attempt = await sql`SELECT id, user_id FROM quiz_attempts WHERE id = ${attemptId}`;
        if (!attempt || attempt.length === 0) {
          return res.status(404).json({ error: 'Attempt not found' });
        }
        if (attempt[0].user_id !== payload.id) {
          return res.status(403).json({ error: 'You can only update your own quiz attempts' });
        }

        const analysisText = (analysis && typeof analysis === 'object') ? JSON.stringify(analysis) : (analysis || null);
        await sql`
          UPDATE quiz_attempts
          SET report_url = ${publicUrl}, report_storage_path = ${storagePath}, analysis = ${analysisText}
          WHERE id = ${attemptId}
        `;
      } catch (e) {
        console.error('Failed to attach report to attempt:', e);
      }
    }

    res.json({
      data: {
        publicUrl,
        path: storagePath,
        message: 'Note: File storage disabled on serverless. Use S3 or Cloudinary for production.'
      }
    });
  } catch (err) {
    console.error('report upload error', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
