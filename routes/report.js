const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

// POST /api/report/upload
// body: { userId, attemptId, filename, data (base64), analysis? }
router.post('/upload', async (req, res) => {
  try {
    const { userId, attemptId, filename, data, analysis } = req.body;
    if (!userId || !filename || !data) return res.status(400).json({ error: 'userId, filename and data are required' });

    const uploadsDir = path.join(__dirname, '..', 'uploads', 'reports', String(userId));
    fs.mkdirSync(uploadsDir, { recursive: true });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const outPath = path.join(uploadsDir, safeName);
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(outPath, buffer);

    const publicUrl = `/reports/${encodeURIComponent(userId)}/${encodeURIComponent(safeName)}`;

    // If attemptId provided, attach to DB
    if (attemptId) {
      try {
        const now = new Date().toISOString();
        const analysisText = (analysis && typeof analysis === 'object') ? JSON.stringify(analysis) : (analysis || null);
        db.prepare('UPDATE quiz_attempts SET report_url = ?, report_storage_path = ?, analysis = ?, attempt_date = attempt_date WHERE id = ?')
          .run(publicUrl, outPath, analysisText, attemptId);
      } catch (e) {
        console.error('Failed to attach report to attempt:', e);
      }
    }

    res.json({ data: { publicUrl, path: outPath } });
  } catch (err) {
    console.error('report upload error', err);
    res.status(500).json({ error: 'Upload failed', details: err?.message || String(err) });
  }
});

module.exports = router;
