-- 🚀 Database Indexes for Performance Optimization
-- Run these SQL commands in your PostgreSQL database (Neon DB compatible)

-- ================================================
-- Users table indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
-- Note: If deleted/disabled are integers, use 0 instead of false
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users(deleted) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_users_disabled ON users(disabled) WHERE disabled = 0;

-- ================================================
-- Quiz attempts indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_id ON quiz_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_created_at ON quiz_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_created ON quiz_attempts(user_id, created_at DESC);

-- ================================================
-- Products indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_products_seller_id ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_seller_status ON products(seller_id, status);

-- ================================================
-- Subscriptions indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ================================================
-- Notifications indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
-- Note: If read is integer, use 0 instead of false
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);

-- ================================================
-- Sessions/Events indexes (for analytics)
-- ================================================
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);

-- ================================================
-- Product reviews indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_product_reviews_product_id ON product_reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_product_reviews_user_id ON product_reviews(user_id);

-- ================================================
-- Referrals indexes
-- ================================================
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);

-- ================================================
-- View indexes after creation
-- ================================================
-- SELECT indexname, tablename FROM pg_indexes WHERE schemaname = 'public';
