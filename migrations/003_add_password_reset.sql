-- Add password reset columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code VARCHAR(6);
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires TIMESTAMP;
