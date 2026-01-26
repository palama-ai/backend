-- SQL migration to create PostgreSQL schema for GlowMatch
-- Run this against your PostgreSQL database (e.g. Neon, Supabase)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user',
  referral_code TEXT,
  referrer_id UUID,
  disabled INTEGER DEFAULT 0,
  deleted INTEGER DEFAULT 0,
  status_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  role TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  referral_code TEXT
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT,
  plan_id TEXT,
  current_period_start TIMESTAMP WITH TIME ZONE,
  current_period_end TIMESTAMP WITH TIME ZONE,
  quiz_attempts_used INTEGER DEFAULT 0,
  quiz_attempts_limit INTEGER DEFAULT 999999999,
  last_attempt_date TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_autosave (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quiz_data TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subscription_id UUID,
  quiz_data TEXT,
  results TEXT,
  has_image_analysis INTEGER DEFAULT 0,
  attempt_date TIMESTAMP WITH TIME ZONE DEFAULT now(),
  report_url TEXT,
  report_storage_path TEXT,
  analysis TEXT
);

CREATE TABLE IF NOT EXISTS blogs (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT,
  excerpt TEXT,
  content TEXT,
  image_url TEXT,
  published INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY,
  referrer_id UUID REFERENCES users(id) ON DELETE SET NULL,
  referred_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY,
  code TEXT UNIQUE,
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  uses_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  last_used_at TIMESTAMP WITH TIME ZONE,
  last_10_reached_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,
  title TEXT,
  body TEXT,
  sender_id UUID,
  target_all INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY,
  notification_id UUID REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  read INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_sessions (
  session_id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  path TEXT,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  last_ping_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  duration_seconds INTEGER,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS page_views (
  id UUID PRIMARY KEY,
  session_id TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  path TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id UUID PRIMARY KEY,
  name TEXT,
  email TEXT,
  message TEXT,
  read INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
