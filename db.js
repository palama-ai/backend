const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.GLOWMATCH_DB_PATH || path.join(__dirname, 'data.db');

const db = new Database(DB_PATH);

function init() {
  // users table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'user',
      referral_code TEXT,
      referrer_id TEXT,
      disabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Ensure existing databases have the `disabled` column (idempotent)
  try {
    const userCols = db.prepare("PRAGMA table_info('users')").all();
    const userColNames = userCols.map(c => c.name);
    if (!userColNames.includes('disabled')) {
      db.prepare('ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0').run();
      console.log('[backend/db] Added missing column `disabled` to users table');
    }
    if (!userColNames.includes('referral_code')) {
      db.prepare("ALTER TABLE users ADD COLUMN referral_code TEXT").run();
      console.log('[backend/db] Added missing column `referral_code` to users table');
    }
    if (!userColNames.includes('referrer_id')) {
      db.prepare("ALTER TABLE users ADD COLUMN referrer_id TEXT").run();
      console.log('[backend/db] Added missing column `referrer_id` to users table');
    }
    if (!userColNames.includes('deleted')) {
      db.prepare("ALTER TABLE users ADD COLUMN deleted INTEGER DEFAULT 0").run();
      console.log('[backend/db] Added missing column `deleted` to users table');
    }
    if (!userColNames.includes('status_message')) {
      db.prepare("ALTER TABLE users ADD COLUMN status_message TEXT").run();
      console.log('[backend/db] Added missing column `status_message` to users table');
    }
  } catch (e) {
    console.warn('[backend/db] Could not verify/add disabled column:', e.message || e);
  }

  // profiles table (simple mirror)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id TEXT PRIMARY KEY,
      email TEXT,
      full_name TEXT,
      role TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // ensure referral_code column exists on user_profiles
  try {
    const profileCols = db.prepare("PRAGMA table_info('user_profiles')").all();
    const profileColNames = profileCols.map(c => c.name);
    if (!profileColNames.includes('referral_code')) {
      db.prepare("ALTER TABLE user_profiles ADD COLUMN referral_code TEXT").run();
      console.log('[backend/db] Added missing column `referral_code` to user_profiles table');
    }
  } catch (e) {
    console.warn('[backend/db] Could not verify/add referral_code to user_profiles:', e.message || e);
  }

  // subscriptions
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      status TEXT,
      plan_id TEXT,
      current_period_start TEXT,
      current_period_end TEXT,
      quiz_attempts_used INTEGER DEFAULT 0,
      quiz_attempts_limit INTEGER DEFAULT 999999999,
      last_attempt_date TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // quiz autosave
  db.prepare(`
    CREATE TABLE IF NOT EXISTS quiz_autosave (
      user_id TEXT PRIMARY KEY,
      quiz_data TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // quiz attempts
  db.prepare(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      subscription_id TEXT,
      quiz_data TEXT,
      results TEXT,
      has_image_analysis INTEGER DEFAULT 0,
      attempt_date TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Ensure additional columns exist for reports and analysis (idempotent)
  try {
    const cols = db.prepare("PRAGMA table_info('quiz_attempts')").all();
    const colNames = cols.map(c => c.name);
    if (!colNames.includes('report_url')) {
      db.prepare('ALTER TABLE quiz_attempts ADD COLUMN report_url TEXT').run();
    }
    if (!colNames.includes('report_storage_path')) {
      db.prepare('ALTER TABLE quiz_attempts ADD COLUMN report_storage_path TEXT').run();
    }
    if (!colNames.includes('analysis')) {
      db.prepare('ALTER TABLE quiz_attempts ADD COLUMN analysis TEXT').run();
    }
  } catch (e) {
    console.warn('Could not add optional columns to quiz_attempts:', e.message || e);
  }

  // Create blogs table for admin-managed posts
  db.prepare(`
    CREATE TABLE IF NOT EXISTS blogs (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      title TEXT,
      excerpt TEXT,
      content TEXT,
      image_url TEXT,
      published INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Ensure image_url column exists (idempotent for existing databases)
  try {
    const blogCols = db.prepare("PRAGMA table_info('blogs')").all();
    const blogColNames = blogCols.map(c => c.name);
    if (!blogColNames.includes('image_url')) {
      db.prepare('ALTER TABLE blogs ADD COLUMN image_url TEXT').run();
      console.log('[backend/db] Added missing column `image_url` to blogs table');
    }
  } catch (e) {
    console.warn('[backend/db] Could not verify/add image_url to blogs:', e.message || e);
  }

  // referrals table to track referral events
  db.prepare(`
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT,
      referred_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // referral_codes table to store generated codes and usage tracking
  db.prepare(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE,
      owner_id TEXT,
      uses_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      last_10_reached_at TEXT
    )
  `).run();

  // notifications table to store admin messages
  db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      title TEXT,
      body TEXT,
      sender_id TEXT,
      target_all INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // user_notifications links notifications to users (read/unread)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      notification_id TEXT,
      user_id TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // site sessions to track live users and session durations (optional lightweight analytics)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS site_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT,
      path TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_ping_at TEXT DEFAULT CURRENT_TIMESTAMP,
      duration_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // page views/events table for visit counts
  db.prepare(`
    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      user_id TEXT,
      path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Create contact messages table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      message TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Seed admin user if not exists (dev-friendly)
  try {
    const adminEmail = process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com';
    const adminPassword = process.env.GLOWMATCH_ADMIN_PASSWORD || 'Adm1n!Glow2025#';
    const adminFullName = process.env.GLOWMATCH_ADMIN_FULLNAME || 'GlowMatch Admin';

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (!existing) {
      const id = uuidv4();
      const password_hash = bcrypt.hashSync(adminPassword, 10);
      db.prepare('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)')
        .run(id, adminEmail, password_hash, adminFullName, 'admin');

      db.prepare('INSERT OR REPLACE INTO user_profiles (id, email, full_name, role) VALUES (?, ?, ?, ?)')
        .run(id, adminEmail, adminFullName, 'admin');

      const subId = uuidv4();
      const now = new Date().toISOString();
      const far = new Date(); far.setFullYear(far.getFullYear() + 100);
      db.prepare('INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(subId, id, 'active', null, now, far.toISOString(), 0, 999999999, now);

      console.log(`[backend/db] Created admin account: ${adminEmail} (use GLOWMATCH_ADMIN_PASSWORD to override)`);
    }
  } catch (e) {
    console.error('Error seeding admin user:', e);
  }
}

module.exports = { db, init };

