const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

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
