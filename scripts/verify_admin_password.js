const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.GLOWMATCH_DB_PATH || path.join(__dirname, '..', 'data.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('Database file not found at', DB_PATH);
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: true });
(async () => {
  try {
    const email = process.argv[2] || (process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com');
    const password = process.argv[3] || process.env.TEST_ADMIN_PASSWORD;
    if (!password) {
      console.error('Usage: node verify_admin_password.js [email] <password>');
      process.exit(2);
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      console.log('Admin user not found for email', email);
      process.exit(0);
    }

    const ok = await bcrypt.compare(password, row.password_hash);
    console.log('password match:', ok);
    if (!ok) {
      console.log('Stored hash:', row.password_hash);
    }
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  } finally {
    db.close();
  }
})();
