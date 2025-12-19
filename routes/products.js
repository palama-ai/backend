const express = require('express');
const router = express.Router();
const { sql } = require('../db');
const { voteOnProducts } = require('../lib/aiProviders');

/**
 * POST /api/products/ai-recommend
 * AI-powered product recommendation using multi-model voting
 * Body:
 *   - analysis: object with skinType, concerns, confidence, explanation
 */
router.post('/ai-recommend', async (req, res) => {
    try {
        const { analysis } = req.body;

        if (!analysis || !analysis.skinType) {
            return res.status(400).json({ error: 'analysis with skinType is required' });
        }

        console.log('[AI-Recommend] Starting for skinType:', analysis.skinType);

        // Fetch all published products from database
        const products = await sql`
            SELECT 
                id, seller_id, name, brand, description, 
                price, original_price, image_url, category,
                skin_types, concerns, purchase_url, view_count
            FROM seller_products 
            WHERE published = 1
            ORDER BY view_count DESC, created_at DESC
            LIMIT 30
        `;

        if (!products || products.length === 0) {
            return res.json({
                data: [],
                votingInfo: { success: false, error: 'No products available' },
                meta: { total: 0 }
            });
        }

        // Parse JSON fields for each product
        const parsedProducts = products.map(product => {
            let skinTypes = [];
            let concerns = [];

            try {
                if (product.skin_types) {
                    skinTypes = typeof product.skin_types === 'string'
                        ? JSON.parse(product.skin_types)
                        : product.skin_types;
                }
            } catch (e) { /* ignore */ }

            try {
                if (product.concerns) {
                    concerns = typeof product.concerns === 'string'
                        ? JSON.parse(product.concerns)
                        : product.concerns;
                }
            } catch (e) { /* ignore */ }

            return {
                ...product,
                skin_types: skinTypes,
                concerns: concerns,
                // Normalized field names for frontend
                image: product.image_url,
                purchaseUrl: product.purchase_url,
                originalPrice: product.original_price,
                rating: 4.5,
                reviewCount: Math.floor(Math.random() * 500) + 100,
                type: product.category
            };
        });

        // Use AI voting to rank products
        const { rankedProducts, votingInfo } = await voteOnProducts({
            analysis,
            products: parsedProducts
        });

        console.log('[AI-Recommend] Voting complete:', votingInfo);

        res.json({
            data: rankedProducts,
            votingInfo,
            meta: {
                total: rankedProducts.length,
                skinType: analysis.skinType,
                concerns: analysis.concerns
            }
        });
    } catch (err) {
        console.error('[AI-Recommend] Error:', err);
        res.status(500).json({ error: 'Failed to get AI recommendations', details: err.message });
    }
});

/**
 * GET /api/products/recommended
 * Public endpoint to fetch products matching skin type and concerns
 * Query params:
 *   - skinType: string (e.g., "oily", "dry", "combination", "sensitive", "normal")
 *   - concerns: comma-separated string (e.g., "acne,pores,dryness")
 *   - category: optional filter (e.g., "cleanser", "serum", "moisturizer")
 *   - limit: max products to return (default 20)
 */
router.get('/recommended', async (req, res) => {
    try {
        const { skinType, concerns, category, limit = 20 } = req.query;

        // Parse concerns into array
        const concernsArray = concerns ? concerns.split(',').map(c => c.trim().toLowerCase()) : [];
        const skinTypeLower = skinType ? skinType.toLowerCase() : null;

        // Fetch all published products
        let products = await sql`
            SELECT 
                id, seller_id, name, brand, description, 
                price, original_price, image_url, category,
                skin_types, concerns, purchase_url, view_count
            FROM seller_products 
            WHERE published = 1
            ORDER BY view_count DESC, created_at DESC
        `;

        // Score and filter products based on matching
        const scoredProducts = products.map(product => {
            let score = 0;

            // Parse JSON fields (stored as TEXT in DB)
            let productSkinTypes = [];
            let productConcerns = [];

            try {
                if (product.skin_types) {
                    productSkinTypes = typeof product.skin_types === 'string'
                        ? JSON.parse(product.skin_types)
                        : product.skin_types;
                    productSkinTypes = productSkinTypes.map(t => t.toLowerCase());
                }
            } catch (e) { /* ignore parse errors */ }

            try {
                if (product.concerns) {
                    productConcerns = typeof product.concerns === 'string'
                        ? JSON.parse(product.concerns)
                        : product.concerns;
                    productConcerns = productConcerns.map(c => c.toLowerCase());
                }
            } catch (e) { /* ignore parse errors */ }

            // Score based on skin type match (higher priority)
            if (skinTypeLower && productSkinTypes.includes(skinTypeLower)) {
                score += 10;
            }

            // Score based on concerns match
            if (concernsArray.length > 0) {
                const matchingConcerns = concernsArray.filter(c => productConcerns.includes(c));
                score += matchingConcerns.length * 5;
            }

            // Bonus for products that match both skin type and at least one concern
            if (score >= 15) {
                score += 5;
            }

            // Filter by category if specified
            if (category && product.category && product.category.toLowerCase() !== category.toLowerCase()) {
                return null; // Exclude non-matching category
            }

            return {
                ...product,
                matchScore: score,
                // Normalize field names for frontend compatibility
                image: product.image_url,
                purchaseUrl: product.purchase_url,
                originalPrice: product.original_price,
                // Default values for missing fields
                rating: 4.5,
                reviewCount: Math.floor(Math.random() * 500) + 100,
                type: product.category,
                concerns: productConcerns
            };
        }).filter(p => p !== null);

        // Sort by match score (descending), then by view_count
        scoredProducts.sort((a, b) => {
            if (b.matchScore !== a.matchScore) {
                return b.matchScore - a.matchScore;
            }
            return (b.view_count || 0) - (a.view_count || 0);
        });

        // Limit results
        const limitedProducts = scoredProducts.slice(0, parseInt(limit));

        res.json({
            data: limitedProducts,
            meta: {
                total: scoredProducts.length,
                returned: limitedProducts.length,
                filters: { skinType, concerns: concernsArray, category }
            }
        });
    } catch (err) {
        console.error('[products] Error fetching recommended products:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

/**
 * POST /api/products/:id/view
 * Track product view (for analytics)
 * Rules:
 * - Count views per user per quiz attempt
 * - Same product viewed multiple times in one quiz = 1 view
 * - New quiz attempt = new view can be counted
 */
router.post('/:id/view', async (req, res) => {
    try {
        const { id } = req.params;
        const { userId, quizAttemptId } = req.body;

        // If we have userId and quizAttemptId, check for duplicate views
        if (userId && quizAttemptId) {
            // Check if this user already viewed this product in this quiz attempt
            const existing = await sql`
                SELECT id FROM product_views 
                WHERE product_id = ${id} 
                AND user_id = ${userId} 
                AND quiz_attempt_id = ${quizAttemptId}
            `;

            if (existing && existing.length > 0) {
                // Already viewed in this quiz attempt, don't increment
                return res.json({ success: true, alreadyViewed: true });
            }

            // New view - insert into product_views and increment count
            try {
                await sql`
                    INSERT INTO product_views (id, product_id, user_id, quiz_attempt_id, created_at)
                    VALUES (gen_random_uuid(), ${id}, ${userId}, ${quizAttemptId}, NOW())
                `;
            } catch (e) {
                // Ignore duplicate key errors
                if (!e.message?.includes('duplicate')) {
                    console.error('[products] Error inserting view:', e);
                }
            }
        } else {
            // Anonymous view - just track in product_views table without user/quiz info
            try {
                await sql`
                    INSERT INTO product_views (id, product_id, created_at)
                    VALUES (gen_random_uuid(), ${id}, NOW())
                `;
            } catch (e) {
                // Ignore if product_views table doesn't exist
            }
        }

        // Increment view count on the product
        await sql`
            UPDATE seller_products 
            SET view_count = COALESCE(view_count, 0) + 1 
            WHERE id = ${id}
        `;

        res.json({ success: true });
    } catch (err) {
        console.error('[products] Error tracking view:', err);
        res.status(500).json({ error: 'Failed to track view' });
    }
});

/**
 * GET /api/products/:id
 * Get single product details (public)
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const products = await sql`
            SELECT 
                sp.*, 
                u.full_name as seller_name
            FROM seller_products sp
            LEFT JOIN users u ON u.id = sp.seller_id
            WHERE sp.id = ${id} AND sp.published = 1
        `;

        if (!products || products.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const product = products[0];

        // Parse JSON fields
        try {
            if (product.skin_types && typeof product.skin_types === 'string') {
                product.skin_types = JSON.parse(product.skin_types);
            }
            if (product.concerns && typeof product.concerns === 'string') {
                product.concerns = JSON.parse(product.concerns);
            }
        } catch (e) { /* ignore */ }

        res.json({ data: product });
    } catch (err) {
        console.error('[products] Error fetching product:', err);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

// ============================================
// Product Reviews System (Ratings & Comments)
// ============================================

// Helper: Get user from JWT token (optional auth)
const getUserFromToken = (req) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
        const token = authHeader.split(' ')[1];
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
};

// Require auth middleware
const requireAuth = (req, res, next) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    req.user = user;
    next();
};

/**
 * GET /api/products/:id/reviews
 * Get product ratings summary and comments
 */
router.get('/:id/reviews', async (req, res) => {
    try {
        const { id } = req.params;
        const user = getUserFromToken(req);

        // Get rating stats
        const ratingStats = await sql`
            SELECT 
                COUNT(*) as total_ratings,
                COALESCE(AVG(rating), 0) as avg_rating
            FROM product_ratings 
            WHERE product_id = ${id}
        `;

        // Get user's rating if logged in
        let userRating = null;
        if (user) {
            const userRatingResult = await sql`
                SELECT rating FROM product_ratings 
                WHERE product_id = ${id} AND user_id = ${user.id}
            `;
            userRating = userRatingResult?.[0]?.rating || null;
        }

        // Get comments with user info (parent comments first)
        const comments = await sql`
            SELECT 
                pc.id, pc.product_id, pc.user_id, pc.parent_id,
                pc.content, pc.likes_count, pc.created_at,
                u.full_name as user_name
            FROM product_comments pc
            LEFT JOIN users u ON u.id = pc.user_id
            WHERE pc.product_id = ${id}
            ORDER BY pc.created_at DESC
        `;

        // Get user's liked comments
        let userLikedComments = [];
        if (user) {
            const likes = await sql`
                SELECT comment_id FROM comment_likes WHERE user_id = ${user.id}
            `;
            userLikedComments = likes.map(l => l.comment_id);
        }

        // Organize comments (parent + replies)
        const parentComments = comments.filter(c => !c.parent_id);
        const replies = comments.filter(c => c.parent_id);

        const organizedComments = parentComments.map(parent => ({
            ...parent,
            isLiked: userLikedComments.includes(parent.id),
            isOwner: user?.id === parent.user_id,
            replies: replies
                .filter(r => r.parent_id === parent.id)
                .map(r => ({
                    ...r,
                    isLiked: userLikedComments.includes(r.id),
                    isOwner: user?.id === r.user_id
                }))
        }));

        res.json({
            data: {
                avgRating: parseFloat(ratingStats[0]?.avg_rating || 0).toFixed(1),
                totalRatings: parseInt(ratingStats[0]?.total_ratings || 0),
                userRating,
                comments: organizedComments,
                totalComments: comments.length
            }
        });
    } catch (err) {
        console.error('[products] Error fetching reviews:', err);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

/**
 * POST /api/products/:id/rate
 * Add or update user's rating
 */
router.post('/:id/rate', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { rating } = req.body;
        const userId = req.user.id;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
        }

        // Upsert rating (insert or update)
        await sql`
            INSERT INTO product_ratings (id, product_id, user_id, rating)
            VALUES (gen_random_uuid(), ${id}, ${userId}, ${rating})
            ON CONFLICT (product_id, user_id) 
            DO UPDATE SET rating = ${rating}, updated_at = NOW()
        `;

        // Get new average
        const stats = await sql`
            SELECT AVG(rating) as avg_rating, COUNT(*) as total
            FROM product_ratings WHERE product_id = ${id}
        `;

        res.json({
            data: {
                success: true,
                userRating: rating,
                avgRating: parseFloat(stats[0]?.avg_rating || 0).toFixed(1),
                totalRatings: parseInt(stats[0]?.total || 0)
            }
        });
    } catch (err) {
        console.error('[products] Error rating product:', err);
        res.status(500).json({ error: 'Failed to rate product' });
    }
});

/**
 * POST /api/products/:id/comments
 * Add a comment to product
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { content, parentId } = req.body;
        const userId = req.user.id;

        if (!content || content.trim().length === 0) {
            return res.status(400).json({ error: 'Comment content is required' });
        }

        const commentId = require('uuid').v4();
        await sql`
            INSERT INTO product_comments (id, product_id, user_id, parent_id, content)
            VALUES (${commentId}, ${id}, ${userId}, ${parentId || null}, ${content.trim()})
        `;

        // Get the created comment with user info
        const comments = await sql`
            SELECT pc.*, u.full_name as user_name
            FROM product_comments pc
            LEFT JOIN users u ON u.id = pc.user_id
            WHERE pc.id = ${commentId}
        `;

        res.json({ data: { ...comments[0], isOwner: true, isLiked: false, replies: [] } });
    } catch (err) {
        console.error('[products] Error adding comment:', err);
        res.status(500).json({ error: 'Failed to add comment' });
    }
});

/**
 * POST /api/products/:id/comments/:commentId/like
 * Like or unlike a comment
 */
router.post('/:id/comments/:commentId/like', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user.id;

        // Check if already liked
        const existing = await sql`
            SELECT id FROM comment_likes 
            WHERE comment_id = ${commentId} AND user_id = ${userId}
        `;

        if (existing && existing.length > 0) {
            // Unlike
            await sql`DELETE FROM comment_likes WHERE comment_id = ${commentId} AND user_id = ${userId}`;
            await sql`UPDATE product_comments SET likes_count = likes_count - 1 WHERE id = ${commentId}`;
            res.json({ data: { liked: false } });
        } else {
            // Like
            await sql`
                INSERT INTO comment_likes (id, comment_id, user_id)
                VALUES (gen_random_uuid(), ${commentId}, ${userId})
            `;
            await sql`UPDATE product_comments SET likes_count = likes_count + 1 WHERE id = ${commentId}`;
            res.json({ data: { liked: true } });
        }
    } catch (err) {
        console.error('[products] Error liking comment:', err);
        res.status(500).json({ error: 'Failed to like comment' });
    }
});

/**
 * DELETE /api/products/:id/comments/:commentId
 * Delete own comment
 */
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user.id;

        // Verify ownership
        const comment = await sql`
            SELECT id, user_id FROM product_comments WHERE id = ${commentId}
        `;

        if (!comment || comment.length === 0) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        if (comment[0].user_id !== userId) {
            return res.status(403).json({ error: 'You can only delete your own comments' });
        }

        // Delete comment (and replies due to cascade... but we don't have cascade on parent_id)
        // First delete replies
        await sql`DELETE FROM product_comments WHERE parent_id = ${commentId}`;
        // Then delete the comment
        await sql`DELETE FROM product_comments WHERE id = ${commentId}`;

        res.json({ data: { success: true, deletedId: commentId } });
    } catch (err) {
        console.error('[products] Error deleting comment:', err);
        res.status(500).json({ error: 'Failed to delete comment' });
    }
});

module.exports = router;
