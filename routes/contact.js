const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

// GET /api/contact - get contact messages (admin only)
router.get('/', async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100`;
    res.json({ data: rows });
  } catch (e) {
    console.error('contact list error', e);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/contact - public submit
router.post('/', async (req, res) => {
  try {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'name, email and message are required' });
    const id = uuidv4();
    
    await sql`
      INSERT INTO contact_messages (id, name, email, message, read, created_at)
      VALUES (${id}, ${name}, ${email}, ${message}, 0, NOW())
    `;
    res.json({ data: { id } });
  } catch (e) {
    console.error('contact submit error', e);
    res.status(500).json({ error: 'Failed to submit message' });
  }
});

module.exports = router;
