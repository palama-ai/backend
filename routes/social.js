const express = require('express');
const router = express.Router();
const { sql } = require('../db');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;

function authFromHeader(req) {
    try {
        const auth = req.headers.authorization;
        if (!auth) return null;
        const token = auth.replace('Bearer ', '');
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// Middleware to require authentication
const requireAuth = (req, res, next) => {
    const user = authFromHeader(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
};

// Follow a user
router.post('/follow/:targetId', requireAuth, async (req, res) => {
    const { targetId } = req.params;
    const followerId = req.user.id;

    if (targetId === followerId) {
        return res.status(400).json({ error: 'Cannot follow yourself' });
    }

    try {
        // Check if target user exists
        const targetExists = await sql`SELECT id FROM users WHERE id = ${targetId}`;
        if (!targetExists || targetExists.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        await sql`
      INSERT INTO followers (follower_id, following_id)
      VALUES (${followerId}, ${targetId})
      ON CONFLICT (follower_id, following_id) DO NOTHING
    `;

        // Get updated follower count for target
        const countResult = await sql`SELECT COUNT(*) as count FROM followers WHERE following_id = ${targetId}`;
        const followerCount = parseInt(countResult[0].count);

        res.json({ success: true, isFollowing: true, followerCount });
    } catch (err) {
        console.error('[social.follow] error:', err);
        res.status(500).json({ error: 'Failed to follow user' });
    }
});

// Unfollow a user
router.delete('/follow/:targetId', requireAuth, async (req, res) => {
    const { targetId } = req.params;
    const followerId = req.user.id;

    try {
        await sql`
      DELETE FROM followers 
      WHERE follower_id = ${followerId} AND following_id = ${targetId}
    `;

        // Get updated follower count for target
        const countResult = await sql`SELECT COUNT(*) as count FROM followers WHERE following_id = ${targetId}`;
        const followerCount = parseInt(countResult[0].count);

        res.json({ success: true, isFollowing: false, followerCount });
    } catch (err) {
        console.error('[social.unfollow] error:', err);
        res.status(500).json({ error: 'Failed to unfollow user' });
    }
});

// Check follow status
router.get('/status/:targetId', requireAuth, async (req, res) => {
    const { targetId } = req.params;
    const followerId = req.user.id;

    try {
        const result = await sql`
      SELECT 1 FROM followers 
      WHERE follower_id = ${followerId} AND following_id = ${targetId}
    `;
        const isFollowing = result && result.length > 0;

        const countResult = await sql`SELECT COUNT(*) as count FROM followers WHERE following_id = ${targetId}`;
        const followerCount = parseInt(countResult[0].count);

        res.json({ isFollowing, followerCount });
    } catch (err) {
        console.error('[social.status] error:', err);
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// Get followers of a user (Public)
router.get('/followers/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const followers = await sql`
      SELECT u.id, u.full_name, up.brand_name, up.role 
      FROM followers f
      JOIN users u ON f.follower_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.id
      WHERE f.following_id = ${userId}
      ORDER BY f.created_at DESC
      LIMIT 50
    `;
        res.json({ data: followers });
    } catch (err) {
        console.error('[social.followers] error:', err);
        res.status(500).json({ error: 'Failed to get followers' });
    }
});

// Get following list of a user (Public)
router.get('/following/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const following = await sql`
      SELECT u.id, u.full_name, up.brand_name, up.role 
      FROM followers f
      JOIN users u ON f.following_id = u.id
      LEFT JOIN user_profiles up ON u.id = up.id
      WHERE f.follower_id = ${userId}
      ORDER BY f.created_at DESC
      LIMIT 50
    `;
        res.json({ data: following });
    } catch (err) {
        console.error('[social.following] error:', err);
        res.status(500).json({ error: 'Failed to get following' });
    }
});

module.exports = router;
