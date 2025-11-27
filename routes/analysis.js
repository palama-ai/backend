const express = require('express');
const router = express.Router();
const { analyze } = require('../lib/aiProviders');
const { generateRoutine } = require('../lib/aiProviders');
const { db } = require('../db');

// POST /api/analysis
// body: { quizData, images, model, attemptId }
router.post('/', async (req, res) => {
  try {
    const { quizData, images, model, attemptId } = req.body;
    // Debug: log received images info to help trace why imageAnalysis may be missing
    try {
      const imgCount = Array.isArray(images) ? images.length : 0;
      let firstPreview = null;
      if (imgCount > 0) {
        const first = images[0];
        firstPreview = {
          filename: first.filename || null,
          hasData: !!first.data,
          dataLength: first.data ? String(first.data).length : 0,
          sample: first.data ? String(first.data).slice(0, 120) : null
        };
      }
      console.debug('Received analysis request - images count:', imgCount, 'firstImagePreview:', firstPreview);
    } catch (e) {
      console.debug('Received analysis request - failed to log images:', e?.message || e);
    }
    if (!quizData) return res.status(400).json({ error: 'quizData required' });

    const result = await analyze({ provider: model || 'openai', quizData, images });

    // Persist analysis to attempt if attemptId provided
    if (attemptId) {
      try {
        // Ensure we store a JSON string in the DB (avoid [object Object])
        const analysisText = result?.text ? (typeof result.text === 'object' ? JSON.stringify(result.text) : String(result.text)) : null;
        const now = new Date().toISOString();
        const stmt = db.prepare('UPDATE quiz_attempts SET analysis = ?, attempt_date = attempt_date WHERE id = ?');
        stmt.run(analysisText, attemptId);
      } catch (e) {
        console.error('Failed to attach analysis to attempt:', e);
      }
    }

    // Log structured result for debugging (won't expose secrets)
    try {
      console.debug('Analysis result (provider):', result.provider, 'imageAnalysisPresent:', !!result.imageAnalysis || !!result.imageFeatures);
    } catch (e) {}

    // Normalize response: ensure analysis is an object where possible
    let analysisOut = result.text;
    if (typeof analysisOut === 'string') {
      // try to parse if stringified JSON
      try { analysisOut = JSON.parse(analysisOut); } catch (e) { /* keep string */ }
    }

    // Also expose imageFeatures explicitly when present so frontend doesn't need to parse explanation
    const imageFeatures = (analysisOut && analysisOut.imageFeatures) || result.imageFeatures || result.imageAnalysis || null;
    try {
      // Debug: print computed imageFeatures (may be null)
      console.debug('Responding with imageFeatures:', imageFeatures);
    } catch (e) {}
    // Include a small debug object in development to help troubleshooting (non-sensitive)
    const debug = {
      receivedImages: Array.isArray(images) ? images.map((im, i) => ({ idx: i, filename: im.filename || null, hasData: !!im.data, dataLength: im.data ? String(im.data).length : 0 })) : []
    };
    res.json({ data: { analysis: analysisOut, provider: result.provider, raw: result.raw || null, imageFeatures, debug } });
  } catch (err) {
    console.error('analysis error', err);
    res.status(500).json({ error: 'Analysis failed', details: err?.message || String(err) });
  }
});

module.exports = router;

// POST /api/analysis/expand
// body: { analysis, provider }
router.post('/expand', async (req, res) => {
  try {
    const { analysis, provider } = req.body;
    if (!analysis) return res.status(400).json({ error: 'analysis required in body' });
    const result = await generateRoutine({ provider: provider || 'openai', analysis });
    let out = result.text;
    if (typeof out === 'string') {
      try { out = JSON.parse(out); } catch (e) { out = { rationale: out }; }
    }
    res.json({ data: { generated: out, provider: result.provider, raw: result.raw || null } });
  } catch (err) {
    console.error('expand analysis error', err);
    res.status(500).json({ error: 'Expand failed', details: err?.message || String(err) });
  }
});
