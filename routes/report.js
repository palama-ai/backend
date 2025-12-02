const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

// POST /api/report/upload
// body: { userId, attemptId, filename, data (base64), analysis? }
// NOTE: File storage is no longer supported in serverless (Vercel is read-only)
// Instead, store reference in database and recommend using external storage (S3, Cloudinary, etc)
router.post('/upload', async (req, res) => {
  try {
    const { userId, attemptId, filename, data, analysis } = req.body;
    if (!userId || !filename || !data) return res.status(400).json({ error: 'userId, filename and data are required' });

    // In serverless, we don't write files to disk. Store metadata in DB and recommend S3/external storage
    const publicUrl = null; // Would be filled in if using external storage
    const storagePath = null;

    // If attemptId provided, attach to DB
    if (attemptId) {
      try {
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
    res.status(500).json({ error: 'Upload failed', details: err?.message || String(err) });
  }
});

module.exports = router;
