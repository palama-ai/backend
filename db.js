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

    // Migration: Update image_url to TEXT for longer URLs
    try {
      await sqlClient`ALTER TABLE blogs ALTER COLUMN image_url TYPE TEXT`;
      console.log('[db] Updated blogs.image_url column to TEXT');
    } catch (e) {
      console.log('[db] blogs.image_url migration skipped:', e.message?.substring(0, 50));
    }

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
        image_url TEXT,
        category VARCHAR(100),
        skin_types TEXT,
        concerns TEXT,
        purchase_url TEXT,
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

    // Migration: Update column types for longer URLs (if table already exists with VARCHAR)
    try {
      await sqlClient`ALTER TABLE seller_products ALTER COLUMN image_url TYPE TEXT`;
      await sqlClient`ALTER TABLE seller_products ALTER COLUMN purchase_url TYPE TEXT`;
      console.log('[db] Updated seller_products URL columns to TEXT');
    } catch (e) {
      // Ignore if already TEXT or table doesn't exist
      console.log('[db] URL columns migration skipped:', e.message?.substring(0, 50));
    }

    // Product views table for analytics
    await sqlClient`
      CREATE TABLE IF NOT EXISTS product_views (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        quiz_attempt_id UUID,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified product_views table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_views_product_id ON product_views(product_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_views_created_at ON product_views(created_at)`;

    // Add quiz_attempt_id column if not exists (migration)
    try {
      await sqlClient`ALTER TABLE product_views ADD COLUMN IF NOT EXISTS quiz_attempt_id UUID`;
    } catch (e) { /* ignore */ }

    // Create unique index for preventing duplicate views per user per quiz attempt
    try {
      await sqlClient`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_views_unique ON product_views(product_id, user_id, quiz_attempt_id) WHERE user_id IS NOT NULL AND quiz_attempt_id IS NOT NULL`;
    } catch (e) {
      console.log('[db] Unique index may already exist:', e.message?.substring(0, 50));
    }

    // Product ratings table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS product_ratings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating >= 1 AND rating <= 5),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(product_id, user_id)
      )
    `;
    console.log('[db] Created/verified product_ratings table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_ratings_product_id ON product_ratings(product_id)`;

    // Product comments table (with replies support via parent_id)
    await sqlClient`
      CREATE TABLE IF NOT EXISTS product_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id UUID REFERENCES seller_products(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        parent_id UUID,
        content TEXT NOT NULL,
        likes_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified product_comments table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_comments_product_id ON product_comments(product_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_product_comments_parent_id ON product_comments(parent_id)`;

    // Comment likes table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        comment_id UUID REFERENCES product_comments(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(comment_id, user_id)
      )
    `;
    console.log('[db] Created/verified comment_likes table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id)`;

    // ============================================
    // PRODUCT SAFETY & SELLER PENALTY SYSTEM
    // ============================================

    // Migration: Add seller violation tracking columns to users table
    try {
      await sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS violation_count INTEGER DEFAULT 0`;
      await sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status VARCHAR(20) DEFAULT 'ACTIVE'`;
      await sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_under_probation INTEGER DEFAULT 0`;
      await sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS probation_started_at TIMESTAMP`;
      await sqlClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_violation_at TIMESTAMP`;
      console.log('[db] Added/verified seller violation columns in users table');
    } catch (e) {
      console.log('[db] Seller violation columns migration skipped:', e.message?.substring(0, 50));
    }

    // Toxic ingredients blacklist table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS toxic_ingredients (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        aliases TEXT,
        severity VARCHAR(20) DEFAULT 'medium',
        reason TEXT,
        source VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified toxic_ingredients table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_toxic_ingredients_name ON toxic_ingredients(name)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_toxic_ingredients_severity ON toxic_ingredients(severity)`;

    // Rejected products table (for AI training)
    await sqlClient`
      CREATE TABLE IF NOT EXISTS rejected_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID REFERENCES users(id) ON DELETE SET NULL,
        original_product_data TEXT,
        detected_ingredients TEXT,
        rejection_reason TEXT,
        rejection_phase VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified rejected_products table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_rejected_products_seller_id ON rejected_products(seller_id)`;

    // Seller blacklist table (for ban evasion prevention)
    await sqlClient`
      CREATE TABLE IF NOT EXISTS seller_blacklist (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255),
        email_hash VARCHAR(255),
        identity_hash VARCHAR(255),
        phone VARCHAR(50),
        device_fingerprint VARCHAR(255),
        ban_reason TEXT,
        original_user_id UUID,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified seller_blacklist table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_blacklist_email ON seller_blacklist(email)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_blacklist_email_hash ON seller_blacklist(email_hash)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_blacklist_identity_hash ON seller_blacklist(identity_hash)`;

    // Seller violations log table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS seller_violations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
        product_id UUID,
        product_name VARCHAR(255),
        violation_type VARCHAR(50),
        detected_ingredients TEXT,
        penalty_applied VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified seller_violations table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_violations_seller_id ON seller_violations(seller_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_violations_created_at ON seller_violations(created_at)`;

    // Seller appeals table
    await sqlClient`
      CREATE TABLE IF NOT EXISTS seller_appeals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id UUID REFERENCES users(id) ON DELETE CASCADE,
        violation_id UUID REFERENCES seller_violations(id) ON DELETE CASCADE,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMP,
        admin_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('[db] Created/verified seller_appeals table');

    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_appeals_seller_id ON seller_appeals(seller_id)`;
    await sqlClient`CREATE INDEX IF NOT EXISTS idx_seller_appeals_status ON seller_appeals(status)`;

    // Add ingredients column to seller_products if not exists
    try {
      await sqlClient`ALTER TABLE seller_products ADD COLUMN IF NOT EXISTS ingredients TEXT`;
      console.log('[db] Added/verified ingredients column in seller_products');
    } catch (e) {
      console.log('[db] Ingredients column migration skipped:', e.message?.substring(0, 50));
    }

    // Seed initial toxic ingredients if table is empty
    try {
      const toxicCount = await sqlClient`SELECT COUNT(*) as count FROM toxic_ingredients`;
      if (parseInt(toxicCount[0]?.count || 0) === 0) {
        const toxicIngredients = [
          { name: 'mercury', severity: 'critical', reason: 'Heavy metal poisoning, neurological damage', source: 'FDA' },
          { name: 'lead', severity: 'critical', reason: 'Heavy metal toxicity, developmental issues', source: 'FDA' },
          { name: 'arsenic', severity: 'critical', reason: 'Carcinogenic, toxic', source: 'WHO' },
          { name: 'formaldehyde', severity: 'high', reason: 'Carcinogenic, skin irritant', source: 'EU' },
          { name: 'hydroquinone', severity: 'high', reason: 'Banned in many countries, skin damage', source: 'EU' },
          { name: 'triclosan', severity: 'medium', reason: 'Hormone disruption, environmental concern', source: 'FDA' },
          { name: 'coal tar', severity: 'high', reason: 'Carcinogenic', source: 'FDA' },
          { name: 'toluene', severity: 'high', reason: 'Neurological damage, reproductive toxicity', source: 'EU' },
          { name: 'parabens', severity: 'medium', reason: 'Potential hormone disruption', source: 'EU' },
          { name: 'phthalates', severity: 'medium', reason: 'Endocrine disruption', source: 'EU' }
        ];

        for (const ing of toxicIngredients) {
          await sqlClient`
            INSERT INTO toxic_ingredients (name, severity, reason, source)
            VALUES (${ing.name}, ${ing.severity}, ${ing.reason}, ${ing.source})
          `;
        }
        console.log('[db] Seeded initial toxic ingredients list');
      }
    } catch (e) {
      console.log('[db] Toxic ingredients seeding skipped:', e.message?.substring(0, 50));
    }


    try {
      const adminEmail = process.env.GLOWMATCH_ADMIN_EMAIL || 'admin@glowmatch.com';
      const adminPassword = process.env.GLOWMATCH_ADMIN_PASSWORD;
      const adminFullName = process.env.GLOWMATCH_ADMIN_FULLNAME || 'GlowMatch Admin';

      // Skip admin seeding if password not set (security: no default password)
      if (!adminPassword) {
        console.log('[db] Skipping admin seed: GLOWMATCH_ADMIN_PASSWORD not set');
      } else {
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
