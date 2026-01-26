-- PostgreSQL Schema Migration for Neon Database
-- This script creates all necessary tables for the Glowmatch skin care application
-- Run this script to initialize a fresh PostgreSQL database
-- The script is idempotent - it uses CREATE TABLE IF NOT EXISTS

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table: core user information
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255),
  role VARCHAR(50) DEFAULT 'user',
  referral_code VARCHAR(10),
  referrer_id UUID,
  disabled INT DEFAULT 0,
  deleted INT DEFAULT 0,
  status_message TEXT,
  google_id VARCHAR(255),
  avatar_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_referrer FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_referral_code ON users(referral_code);
CREATE INDEX idx_users_created_at ON users(created_at);

-- User profiles: extended profile information
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE,
  full_name VARCHAR(255),
  role VARCHAR(50),
  referral_code VARCHAR(10),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_profile_user FOREIGN KEY (id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_profiles_email ON user_profiles(email);

-- User subscriptions: tracks active subscriptions and quiz attempt limits
CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  plan_id VARCHAR(100),
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  quiz_attempts_used INT DEFAULT 0,
  quiz_attempts_limit INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_subscription_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX idx_subscriptions_status ON user_subscriptions(status);
CREATE INDEX idx_subscriptions_user_status ON user_subscriptions(user_id, status);

-- Quiz autosave: temporarily stores user quiz progress
CREATE TABLE IF NOT EXISTS quiz_autosave (
  user_id UUID PRIMARY KEY,
  quiz_data TEXT,
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_autosave_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Quiz attempts: completed quiz attempts with analysis results
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  subscription_id UUID,
  quiz_data TEXT,
  results TEXT,
  has_image_analysis INT DEFAULT 0,
  report_url VARCHAR(500),
  report_storage_path VARCHAR(500),
  analysis TEXT,
  attempt_date TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_attempt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_attempt_subscription FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE SET NULL
);

CREATE INDEX idx_attempts_user_id ON quiz_attempts(user_id);
CREATE INDEX idx_attempts_attempt_date ON quiz_attempts(attempt_date);
CREATE INDEX idx_attempts_created_at ON quiz_attempts(created_at);

-- Blogs: published content articles
CREATE TABLE IF NOT EXISTS blogs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(255) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  excerpt TEXT,
  content TEXT,
  image_url VARCHAR(500),
  published INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_blogs_slug ON blogs(slug);
CREATE INDEX idx_blogs_published ON blogs(published);
CREATE INDEX idx_blogs_created_at ON blogs(created_at);

-- Referrals: tracks user referral relationships
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL,
  referred_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_referral_referrer FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_referral_referred FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX idx_referrals_referred ON referrals(referred_id);
CREATE INDEX idx_referrals_created_at ON referrals(created_at);

-- Referral codes: unique referral codes for users
CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(10) UNIQUE NOT NULL,
  owner_id UUID NOT NULL,
  uses_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP,
  last_10_reached_at TIMESTAMP,
  CONSTRAINT fk_code_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_referral_codes_code ON referral_codes(code);
CREATE INDEX idx_referral_codes_owner ON referral_codes(owner_id);

-- Notifications: admin-sent notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255),
  body TEXT,
  sender_id UUID,
  target_all INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_notification_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_notifications_created_at ON notifications(created_at);

-- User notifications: join table for user-specific notification tracking
CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL,
  user_id UUID NOT NULL,
  read INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_user_notif_notification FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_notifications_user_id ON user_notifications(user_id);
CREATE INDEX idx_user_notifications_notification_id ON user_notifications(notification_id);
CREATE INDEX idx_user_notifications_user_read ON user_notifications(user_id, read);

-- Site sessions: user session tracking
CREATE TABLE IF NOT EXISTS site_sessions (
  session_id VARCHAR(255) PRIMARY KEY,
  user_id UUID,
  path VARCHAR(500),
  started_at TIMESTAMP DEFAULT NOW(),
  last_ping_at TIMESTAMP DEFAULT NOW(),
  duration_seconds INT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_sessions_user_id ON site_sessions(user_id);
CREATE INDEX idx_sessions_started_at ON site_sessions(started_at);
CREATE INDEX idx_sessions_last_ping ON site_sessions(last_ping_at);

-- Page views: individual page visit tracking
CREATE TABLE IF NOT EXISTS page_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255),
  user_id UUID,
  path VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT fk_view_session FOREIGN KEY (session_id) REFERENCES site_sessions(session_id) ON DELETE SET NULL,
  CONSTRAINT fk_view_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_page_views_session ON page_views(session_id);
CREATE INDEX idx_page_views_user ON page_views(user_id);
CREATE INDEX idx_page_views_created_at ON page_views(created_at);

-- Contact messages: user contact form submissions
CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  email VARCHAR(255),
  message TEXT,
  read INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_contact_created_at ON contact_messages(created_at);
CREATE INDEX idx_contact_read ON contact_messages(read);

-- Grant appropriate permissions
-- Note: Update these usernames based on your Neon PostgreSQL setup
-- GRANT CONNECT ON DATABASE your_database TO your_user;
-- GRANT USAGE ON SCHEMA public TO your_user;
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_user;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO your_user;
