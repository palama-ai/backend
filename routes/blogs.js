const express = require('express');
const router = express.Router();
const { sql } = require('../db');

// PUBLIC: Get published blogs (no auth required)
router.get('/', async (req, res) => {
  try {
    console.log('[backend/routes/blogs] GET / - fetching published blogs');
    const blogs = await sql`SELECT * FROM blogs WHERE published = 1 ORDER BY created_at DESC`;
    console.log('[backend/routes/blogs] GET / - found', blogs.length, 'published blogs');
    res.json({ data: blogs });
  } catch (e) { 
    console.error('[backend/routes/blogs] GET / error:', e); 
    res.status(500).json({ error: 'Failed to list published blogs' }); 
  }
});

module.exports = router;
