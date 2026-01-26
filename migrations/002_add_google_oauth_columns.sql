-- Migration: Add Google OAuth columns to users table
-- Run this migration to enable Google OAuth authentication

-- Add google_id column to store Google's unique user identifier
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);

-- Add avatar_url column to store user profile picture (from Google or elsewhere)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);

-- Add updated_at column if not exists (useful for tracking changes)
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Create index on google_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Note: After running this migration, the Google OAuth login should work correctly.
