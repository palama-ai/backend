const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');
const { immediateCheck } = require('../lib/ingredientScanner');
const { applyPenalty, getAccountStatus, getViolationHistory, submitAppeal } = require('../lib/penaltyService');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
    process.exit(1);
}

// Middleware to authenticate seller (basic - for terms acceptance)
const requireSellerBasic = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (jwtErr) {
            console.error('[seller] JWT verification failed:', jwtErr.message);
            return res.status(401).json({ error: 'Invalid token' });
        }

        const users = await sql`SELECT id, email, role, terms_accepted, terms_accepted_at FROM users WHERE id = ${decoded.id}`;
        if (!users || users.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        const user = users[0];
        if (user.role !== 'seller' && user.role !== 'admin') {
            return res.status(403).json({ error: 'Seller access required' });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error('[seller] requireSellerBasic error:', err);
        return res.status(500).json({ error: 'Server error during authentication' });
    }
};

// Middleware to authenticate seller and check account status
const requireSeller = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];

        let decoded;
        try {
            decoded = jwt.verify(token, JWT_SECRET);
        } catch (jwtErr) {
            console.error('[seller] JWT verification failed:', jwtErr.message);
            return res.status(401).json({ error: 'Invalid token' });
        }

        // Check if user exists and is a seller
        const users = await sql`SELECT id, email, role, account_status, violation_count, is_under_probation, terms_accepted FROM users WHERE id = ${decoded.id}`;
        if (!users || users.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        const user = users[0];
        if (user.role !== 'seller' && user.role !== 'admin') {
            return res.status(403).json({ error: 'Seller access required' });
        }

        // EXCEPTION: Allow locked users to access appeal-related endpoints
        const appealPaths = ['/appeals', '/violations', '/account-status'];
        const isAppealPath = appealPaths.some(p => req.path.includes(p));

        // Check account status - block LOCKED or BANNED sellers (except for appeals)
        if (user.account_status === 'LOCKED' && !isAppealPath) {
            return res.status(403).json({
                error: 'Account locked due to safety violations',
                code: 'ACCOUNT_LOCKED',
                message: 'Your account has been locked due to repeated safety violations. You can still submit an appeal via /api/seller/appeals'
            });
        }
        if (user.account_status === 'BANNED' && !isAppealPath) {
            return res.status(403).json({
                error: 'Account permanently banned',
                code: 'ACCOUNT_BANNED',
                message: 'Your account has been permanently banned for repeated safety violations.'
            });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error('[seller] requireSeller error:', err);
        return res.status(500).json({ error: 'Server error during authentication', details: err.message });
    }
};

// Check if seller has accepted terms
router.get('/terms-status', requireSellerBasic, async (req, res) => {
    try {
        res.json({
            data: {
                termsAccepted: req.user.terms_accepted === true || req.user.terms_accepted === 1,
                acceptedAt: req.user.terms_accepted_at
            }
        });
    } catch (err) {
        console.error('[seller] Error checking terms status:', err);
        res.status(500).json({ error: 'Failed to check terms status' });
    }
});

// Accept terms of service
router.post('/accept-terms', requireSellerBasic, async (req, res) => {
    try {
        const { signatureData } = req.body;

        if (!signatureData) {
            return res.status(400).json({ error: 'Signature is required' });
        }

        // Update user with terms acceptance
        await sql`
            UPDATE users 
            SET terms_accepted = true,
                terms_accepted_at = NOW(),
                terms_signature = ${signatureData}
            WHERE id = ${req.user.id}
        `;

        console.log(`[seller] Terms accepted by ${req.user.email}`);

        res.json({
            success: true,
            message: 'Terms of service accepted successfully'
        });
    } catch (err) {
        console.error('[seller] Error accepting terms:', err);
        res.status(500).json({ error: 'Failed to accept terms' });
    }
});

// Get seller's products
router.get('/products', requireSeller, async (req, res) => {
    try {
        const products = await sql`
      SELECT * FROM seller_products 
      WHERE seller_id = ${req.user.id} 
      ORDER BY created_at DESC
    `;
        res.json({ data: products });
    } catch (err) {
        console.error('[seller] Error fetching products:', err);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Create new product with ingredient safety check
router.post('/products', requireSeller, async (req, res) => {
    try {
        const { name, brand, description, price, original_price, image_url, category, skin_types, concerns, purchase_url, ingredients } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Product name is required' });
        }

        // MANDATORY: Ingredients field is required to prevent safety check bypass
        if (!ingredients || ingredients.trim().length < 3) {
            return res.status(400).json({
                error: 'Ingredients field is required',
                code: 'INGREDIENTS_REQUIRED',
                message: 'Please provide the product ingredients list. This is mandatory for safety verification.'
            });
        }

        // Phase 1: Immediate ingredient safety check
        const safetyCheck = await immediateCheck(ingredients, name, description);

        // Only block on critical/high severity (not medium - those are just warnings)
        if (!safetyCheck.safe) {
            console.log(`[seller] Product rejected for ${req.user.email}: ${safetyCheck.message}`);

            // Apply penalty to seller
            const penaltyResult = await applyPenalty(
                req.user.id,
                null, // No product ID yet
                name,
                safetyCheck.flaggedIngredients,
                'toxic_ingredient'
            );

            return res.status(400).json({
                error: 'Product rejected due to harmful ingredients',
                code: 'TOXIC_INGREDIENTS_DETECTED',
                flaggedIngredients: safetyCheck.flaggedIngredients,
                severity: safetyCheck.severity,
                penalty: {
                    action: penaltyResult.action,
                    message: penaltyResult.message,
                    violationCount: penaltyResult.violation?.newViolationCount
                }
            });
        }

        const id = uuidv4();
        const skinTypesJson = skin_types ? JSON.stringify(skin_types) : null;
        const concernsJson = concerns ? JSON.stringify(concerns) : null;

        await sql`
      INSERT INTO seller_products (id, seller_id, name, brand, description, price, original_price, image_url, category, skin_types, concerns, purchase_url, ingredients)
      VALUES (${id}, ${req.user.id}, ${name}, ${brand || null}, ${description || null}, ${price || null}, ${original_price || null}, ${image_url || null}, ${category || null}, ${skinTypesJson}, ${concernsJson}, ${purchase_url || null}, ${ingredients || null})
    `;

        // Return success with any warnings (medium-severity ingredients)
        const response = {
            data: {
                id,
                message: 'Product created successfully',
                safetyCheck: 'passed'
            }
        };

        // Include warnings if any (these don't block but inform the seller)
        if (safetyCheck.warnings && safetyCheck.warnings.length > 0) {
            response.warnings = safetyCheck.warnings.map(w => ({
                ingredient: w.name,
                reason: w.reason,
                severity: 'warning'
            }));
            response.data.message = `Product created with ${safetyCheck.warnings.length} warning(s)`;
        }

        res.json(response);
    } catch (err) {
        console.error('[seller] Error creating product:', err);
        res.status(500).json({ error: 'Failed to create product' });
    }
});

// Update product
router.put('/products/:id', requireSeller, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, brand, description, price, original_price, image_url, category, skin_types, concerns, purchase_url, published } = req.body;

        // Verify ownership
        const existing = await sql`SELECT id FROM seller_products WHERE id = ${id} AND seller_id = ${req.user.id}`;
        if (!existing || existing.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const skinTypesJson = skin_types ? JSON.stringify(skin_types) : null;
        const concernsJson = concerns ? JSON.stringify(concerns) : null;

        await sql`
      UPDATE seller_products SET
        name = ${name},
        brand = ${brand || null},
        description = ${description || null},
        price = ${price || null},
        original_price = ${original_price || null},
        image_url = ${image_url || null},
        category = ${category || null},
        skin_types = ${skinTypesJson},
        concerns = ${concernsJson},
        purchase_url = ${purchase_url || null},
        published = ${published || 0},
        updated_at = NOW()
      WHERE id = ${id} AND seller_id = ${req.user.id}
    `;

        res.json({ data: { message: 'Product updated successfully' } });
    } catch (err) {
        console.error('[seller] Error updating product:', err);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

// Delete product
router.delete('/products/:id', requireSeller, async (req, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const existing = await sql`SELECT id FROM seller_products WHERE id = ${id} AND seller_id = ${req.user.id}`;
        if (!existing || existing.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        await sql`DELETE FROM seller_products WHERE id = ${id} AND seller_id = ${req.user.id}`;

        res.json({ data: { message: 'Product deleted successfully' } });
    } catch (err) {
        console.error('[seller] Error deleting product:', err);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

// Get seller analytics
router.get('/analytics', requireSeller, async (req, res) => {
    try {
        // Total products
        const totalProducts = await sql`
      SELECT COUNT(*) as count FROM seller_products WHERE seller_id = ${req.user.id}
    `;

        // Published products
        const publishedProducts = await sql`
      SELECT COUNT(*) as count FROM seller_products WHERE seller_id = ${req.user.id} AND published = 1
    `;

        // Total views
        const totalViews = await sql`
      SELECT COALESCE(SUM(view_count), 0) as total FROM seller_products WHERE seller_id = ${req.user.id}
    `;

        // Views per day (last 7 days)
        const viewsByDay = await sql`
      SELECT 
        DATE(pv.created_at) as date,
        COUNT(*) as views
      FROM product_views pv
      JOIN seller_products sp ON pv.product_id = sp.id
      WHERE sp.seller_id = ${req.user.id}
        AND pv.created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(pv.created_at)
      ORDER BY date ASC
    `;

        // Top products by views
        const topProducts = await sql`
      SELECT id, name, image_url, view_count
      FROM seller_products
      WHERE seller_id = ${req.user.id}
      ORDER BY view_count DESC
      LIMIT 5
    `;

        res.json({
            data: {
                totalProducts: parseInt(totalProducts[0]?.count || 0),
                publishedProducts: parseInt(publishedProducts[0]?.count || 0),
                totalViews: parseInt(totalViews[0]?.total || 0),
                viewsByDay,
                topProducts
            }
        });
    } catch (err) {
        console.error('[seller] Error fetching analytics:', err);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Get seller profile summary (for dashboard header)
router.get('/profile', requireSeller, async (req, res) => {
    try {
        const users = await sql`SELECT id, email, full_name, role, created_at FROM users WHERE id = ${req.user.id}`;
        if (!users || users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ data: users[0] });
    } catch (err) {
        console.error('[seller] Error fetching profile:', err);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// Get seller account status (violations, warnings, probation)
router.get('/account-status', requireSeller, async (req, res) => {
    try {
        const status = await getAccountStatus(req.user.id);
        if (!status) {
            return res.status(404).json({ error: 'Account not found' });
        }
        res.json({ data: status });
    } catch (err) {
        console.error('[seller] Error fetching account status:', err);
        res.status(500).json({ error: 'Failed to fetch account status' });
    }
});

// Get seller's violation history
router.get('/violations', requireSeller, async (req, res) => {
    try {
        const violations = await getViolationHistory(req.user.id);
        res.json({ data: violations });
    } catch (err) {
        console.error('[seller] Error fetching violations:', err);
        res.status(500).json({ error: 'Failed to fetch violations' });
    }
});

// Submit an appeal for a violation
router.post('/appeals', requireSeller, async (req, res) => {
    try {
        const { violationId, reason } = req.body;

        if (!violationId || !reason) {
            return res.status(400).json({ error: 'Violation ID and reason are required' });
        }

        const result = await submitAppeal(req.user.id, violationId, reason);

        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        res.json({ data: result });
    } catch (err) {
        console.error('[seller] Error submitting appeal:', err);
        res.status(500).json({ error: 'Failed to submit appeal' });
    }
});

module.exports = router;

