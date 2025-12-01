#!/usr/bin/env node
// Migration helper: reads data from the local SQLite DB and inserts into Postgres.
// Usage: Set env vars `GLOWMATCH_DB_PATH` (path to sqlite file) and `DATABASE_URL` (Postgres)
// then run: node scripts/migrate_sqlite_to_postgres.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

const SQLITE_PATH = process.env.GLOWMATCH_DB_PATH || path.join(__dirname, '..', '..', 'backend', 'data.db');
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('Please set DATABASE_URL environment variable (Postgres connection)');
  process.exit(2);
}

if (!fs.existsSync(SQLITE_PATH)) {
  console.error('SQLite DB not found at', SQLITE_PATH);
  process.exit(2);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pg = new Client({ connectionString: DATABASE_URL });

async function run() {
  await pg.connect();
  try {
    await pg.query('BEGIN');

    // Order matters: users -> profiles -> referral_codes -> subscriptions -> others
    const tables = [
      'users',
      'user_profiles',
      'referral_codes',
      'user_subscriptions',
      'quiz_autosave',
      'quiz_attempts',
      'blogs',
      'referrals',
      'notifications',
      'user_notifications',
      'site_sessions',
      'page_views',
      'contact_messages'
    ];

    for (const t of tables) {
      try {
        const rows = sqlite.prepare(`SELECT * FROM ${t}`).all();
        console.log(`Migrating ${rows.length} rows from ${t}`);
        for (const row of rows) {
          // Build insert dynamically
          const cols = Object.keys(row).filter(k => row[k] !== undefined);
          const vals = cols.map((c, i) => `$${i+1}`);
          const query = `INSERT INTO ${t} (${cols.join(',')}) VALUES (${vals.join(',')}) ON CONFLICT DO NOTHING`;
          const params = cols.map(c => row[c]);
          await pg.query(query, params);
        }
      } catch (e) {
        console.warn(`Table ${t} not found or failed to migrate:`, e.message);
      }
    }

    await pg.query('COMMIT');
    console.log('Migration complete');
  } catch (e) {
    await pg.query('ROLLBACK');
    console.error('Migration failed, rolled back:', e);
    process.exit(1);
  } finally {
    await pg.end();
    sqlite.close();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
