const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.GLOWMATCH_DB_PATH || path.join(__dirname, '..', 'data.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('Database file not found at', DB_PATH);
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  const email = process.argv[2] || (process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com');
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) {
    console.log('NOT FOUND');
    process.exit(0);
  }
  console.log(JSON.stringify(row, null, 2));
} finally {
  db.close();
}
