const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { neon } = require('@neondatabase/serverless');

// Initialize Neon SQL client lazily to handle missing env vars gracefully
let sqlClient = null;
let initError = null;

function getSQLClient() {
  if (sqlClient) return sqlClient;
  if (initError) throw initError;

  try {
    // Log all environment variables that might contain the database URL
    const allKeys = Object.keys(process.env);
    console.log('[db] Environment check:');
    console.log('[db]   - Total env vars:', allKeys.length);
    console.log('[db]   - DATABASE_URL:', !!process.env.DATABASE_URL);
    console.log('[db]   - NEON_CONNECTION_STRING:', !!process.env.NEON_CONNECTION_STRING);
    console.log('[db]   - DB keys:', allKeys.filter(k => k.toUpperCase().includes('DB')));
    console.log('[db]   - DATABASE keys:', allKeys.filter(k => k.toUpperCase().includes('DATABASE')));

    // Try DATABASE_URL, NEON_CONNECTION_STRING, or other alternatives
    let DATABASE_URL = process.env.DATABASE_URL ||
      process.env.NEON_CONNECTION_STRING ||
      process.env.DATABASE_URL_PROD;

    if (!DATABASE_URL) {
      console.error('[db] CRITICAL: DATABASE_URL not found in environment');
      console.error('[db] Vercel requires DATABASE_URL to be set in Project Settings > Environment Variables');
      console.error('[db] Steps to fix:');
      console.error('[db]   1. Go to your Vercel project dashboard');
      console.error('[db]   2. Navigate to Settings > Environment Variables');
      console.error('[db]   3. Add a new variable: DATABASE_URL = postgresql://...');
      console.error('[db]   4. Redeploy the project');

      const availableVars = allKeys.filter(k =>
        k.includes('DB') || k.includes('DATABASE') || k.includes('NEON') || k.includes('SQL')
      );

      const msg = `DATABASE_URL not configured. Available DB-related vars: ${availableVars.join(', ') || 'none'}`;
      initError = new Error(msg);
      throw initError;
    }

    console.log('[db] DATABASE_URL found, initializing Neon client...');
    sqlClient = neon(DATABASE_URL);
    console.log('[db] ✅ Neon PostgreSQL client initialized successfully');
    return sqlClient;
  } catch (err) {
    console.error('[db] Failed to initialize SQL client:', err.message);
    initError = err;
    throw err;
  }
}

// Create a proxy function that acts as a tagged template literal
// When routes do: await sql`SELECT...`, this function gets called
function sql(strings, ...values) {
  const client = getSQLClient();
  return client(strings, ...values);
}

async function init() {
  try {
    console.log('[db] Starting PostgreSQL schema initialization...');

    // Lazy initialize SQL client
    const sqlClient = getSQLClient();

    // Create all tables with proper PostgreSQL syntax
    await sqlClient`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        referral_code VARCHAR(50),
        referrer_id UUID,
        disabled INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0,
        status_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified users table');

    // Create indexes for users
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS user_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255),
        full_name VARCHAR(255),
        role VARCHAR(50),
        referral_code VARCHAR(50),
        brand_name VARCHAR(255),
        website VARCHAR(500),
        bio TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified user_profiles table');

    // Add missing columns for existing tables (migration)
    try {
      await sqlClient`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS brand_name VARCHAR(255)`;
      await sqlClient`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS website VARCHAR(500)`;
      await sqlClient`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bio TEXT`;
      console.log('[db] Added/verified seller columns in user_profiles');
    } catch (e) {
      console.log('[db] Seller columns migration skipped:', e.message);
    }

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(50),
        plan_id VARCHAR(255),
        current_period_start TIMESTAMP,
        current_period_end TIMESTAMP,
        quiz_attempts_used INTEGER DEFAULT 0,
        quiz_attempts_limit INTEGER DEFAULT 999999999,
        last_attempt_date TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified user_subscriptions table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS quiz_autosave (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        quiz_data TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified quiz_autosave table');

    await sqlClient`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        subscription_id UUID REFERENCES user_subscriptions(id) ON DELETE SET NULL,
        quiz_data TEXT,
        results TEXT,
        has_image_analysis INTEGER DEFAULT 0,
        report_url VARCHAR(512),
        report_storage_path TEXT,
        analysis TEXT,
        attempt_date TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified quiz_attempts table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_id ON quiz_attempts(user_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_quiz_attempts_attempt_date ON quiz_attempts(attempt_date)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS blogs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(255) UNIQUE,
        title VARCHAR(500),
        excerpt TEXT,
        content TEXT,
        image_url VARCHAR(512),
        published INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified blogs table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_blogs_slug ON blogs(slug)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_blogs_published ON blogs(published)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS referrals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        referrer_id UUID REFERENCES users(id) ON DELETE CASCADE,
        referred_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified referrals table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_referrals_created_at ON referrals(created_at)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS referral_codes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(50) UNIQUE,
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        uses_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        last_used_at TIMESTAMP,
        last_10_reached_at TIMESTAMP
      )
    `;
    console.log('[db] Created/verified referral_codes table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_referral_codes_owner_id ON referral_codes(owner_id)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(500),
        body TEXT,
        sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
        target_all INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified notifications table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified user_notifications table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON user_notifications(user_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_user_notifications_notification_id ON user_notifications(notification_id)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS site_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        path VARCHAR(512),
        started_at TIMESTAMP DEFAULT NOW(),
        last_ping_at TIMESTAMP DEFAULT NOW(),
        duration_seconds INTEGER,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified site_sessions table');

    await sqlClient`
      CREATE TABLE IF NOT EXISTS page_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id VARCHAR(255) REFERENCES site_sessions(session_id) ON DELETE SET NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        path VARCHAR(512),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified page_views table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_page_views_user_id ON page_views(user_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_page_views_session_id ON page_views(session_id)`;

    await sqlClient`
      CREATE TABLE IF NOT EXISTS contact_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255),
        email VARCHAR(255),
        message TEXT,
        read INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified contact_messages table');

    // Seller products table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS seller_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        brand VARCHAR(255),
        description TEXT,
        price DECIMAL(10,2),
        original_price DECIMAL(10,2),
        image_url VARCHAR(500),
        category VARCHAR(100),
        skin_types TEXT,
        concerns TEXT,
        purchase_url VARCHAR(500),
        published INTEGER DEFAULT 0,
        view_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified seller_products table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_products_seller_id ON seller_products(seller_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_products_category ON seller_products(category)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_products_published ON seller_products(published)`;

    // Product views table for analytics
    await sqlClient`
      CREATE TABLE IF NOT EXISTS product_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified product_views table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_views_product_id ON product_views(product_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_views_created_at ON product_views(created_at)`;


    // Seed admin user if not exists (dev-friendly)
    try {
      const adminEmail = process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com';
      const adminPassword = process.env.GLOWMATCH_ADMIN_PASSWORD || 'Adm1n!Glow2025#';
      const adminFullName = process.env.GLOWMATCH_ADMIN_FULLNAME || 'GlowMatch Admin';

      // Check if admin already exists
      const existing = await sqlClient`SELECT id FROM users WHERE email = ${adminEmail}`;

      if (!existing || existing.length === 0) {
        const id = uuidv4();
        const password_hash = await bcrypt.hash(adminPassword, 10);

        // Insert admin user
        await sqlClient`
          INSERT INTO users (id, email, password_hash, full_name, role)
          VALUES (${id}, ${adminEmail}, ${password_hash}, ${adminFullName}, 'admin')
        `;

        // Insert admin profile
        await sqlClient`
          INSERT INTO user_profiles (id, email, full_name, role)
          VALUES (${id}, ${adminEmail}, ${adminFullName}, 'admin')
        `;

        // Create admin subscription
        const subId = uuidv4();
        const now = new Date().toISOString();
        const far = new Date();
        far.setFullYear(far.getFullYear() + 100);

        await sqlClient`
          INSERT INTO user_subscriptions (id, user_id, status, plan_id, current_period_start, current_period_end, quiz_attempts_used, quiz_attempts_limit, updated_at)
          VALUES (${subId}, ${id}, 'active', null, ${now}, ${far.toISOString()}, 0, 999999999, ${now})
        `;

        console.log(`[db] Created admin account: ${adminEmail}`);
      }
    } catch (e) {
      console.error('[db] Error seeding admin user:', e);
    }

    console.log('[db] PostgreSQL schema initialization complete');
  } catch (err) {
    console.error('[db] Schema initialization error:', err);
    throw err;
  }
}

module.exports = {
  sql,
  init
};



