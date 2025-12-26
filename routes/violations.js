/**
 * Violations Admin Routes
 * 
 * Admin endpoints for managing seller violations, appeals, and blacklists
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { sql } = require('../db');
const { unlockAccount, reviewAppeal, isBlacklisted } = require('../lib/penaltyService');
const { getToxicIngredients, addToxicIngredient } = require('../lib/ingredientScanner');
const { seedToxicIngredients, deepScanWithAI, TOXIC_INGREDIENTS_DATABASE } = require('../lib/safetyAgent');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
    process.exit(1);
}

// Middleware to require admin access
const requireAdmin = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        const users = await sql`SELECT id, email, role FROM users WHERE id = ${decoded.id}`;
        if (!users || users.length === 0) {
            return res.status(401).json({ error: 'User not found' });
        }

        if (users[0].role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        req.user = users[0];
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// Get all violations with pagination
router.get('/violations', requireAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let violations;
        if (status) {
            violations = await sql`
                SELECT v.*, u.email as seller_email, u.full_name as seller_name,
                       a.status as appeal_status
                FROM seller_violations v
                LEFT JOIN users u ON v.seller_id = u.id
                LEFT JOIN seller_appeals a ON a.violation_id = v.id
                WHERE a.status = ${status} OR (${status} = 'no_appeal' AND a.id IS NULL)
                ORDER BY v.created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${offset}
            `;
        } else {
            violations = await sql`
                SELECT v.*, u.email as seller_email, u.full_name as seller_name,
                       a.status as appeal_status
                FROM seller_violations v
                LEFT JOIN users u ON v.seller_id = u.id
                LEFT JOIN seller_appeals a ON a.violation_id = v.id
                ORDER BY v.created_at DESC
                LIMIT ${parseInt(limit)} OFFSET ${offset}
            `;
        }

        const total = await sql`SELECT COUNT(*) as count FROM seller_violations`;

        res.json({
            data: violations,
            meta: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(total[0]?.count || 0)
            }
        });
    } catch (err) {
        console.error('[violations] Error fetching violations:', err);
        res.status(500).json({ error: 'Failed to fetch violations' });
    }
});

// Get all pending appeals
router.get('/appeals', requireAdmin, async (req, res) => {
    try {
        const { status = 'pending' } = req.query;

        const appeals = await sql`
            SELECT a.*, v.product_name, v.violation_type, v.detected_ingredients,
                   u.email as seller_email, u.full_name as seller_name
            FROM seller_appeals a
            JOIN seller_violations v ON a.violation_id = v.id
            JOIN users u ON a.seller_id = u.id
            WHERE a.status = ${status}
            ORDER BY a.created_at ASC
        `;

        res.json({ data: appeals });
    } catch (err) {
        console.error('[violations] Error fetching appeals:', err);
        res.status(500).json({ error: 'Failed to fetch appeals' });
    }
});

// Review an appeal (approve/reject)
router.post('/appeals/:id/review', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { decision, notes } = req.body;

        if (!decision || !['approved', 'rejected'].includes(decision)) {
            return res.status(400).json({ error: 'Decision must be "approved" or "rejected"' });
        }

        const result = await reviewAppeal(id, req.user.id, decision, notes || '');

        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        res.json({ data: result });
    } catch (err) {
        console.error('[violations] Error reviewing appeal:', err);
        res.status(500).json({ error: 'Failed to review appeal' });
    }
});

// Unlock a locked seller account (with probation)
router.post('/sellers/:id/unlock', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await unlockAccount(id, req.user.id);

        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        res.json({ data: result });
    } catch (err) {
        console.error('[violations] Error unlocking account:', err);
        res.status(500).json({ error: 'Failed to unlock account' });
    }
});

// Get blacklisted sellers
router.get('/blacklist', requireAdmin, async (req, res) => {
    try {
        const blacklist = await sql`
            SELECT b.*, u.full_name as original_name
            FROM seller_blacklist b
            LEFT JOIN users u ON b.original_user_id = u.id
            ORDER BY b.created_at DESC
        `;

        res.json({ data: blacklist });
    } catch (err) {
        console.error('[violations] Error fetching blacklist:', err);
        res.status(500).json({ error: 'Failed to fetch blacklist' });
    }
});

// Check if email is blacklisted
router.get('/blacklist/check', requireAdmin, async (req, res) => {
    try {
        const { email } = req.query;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const result = await isBlacklisted(email);
        res.json({ data: result });
    } catch (err) {
        console.error('[violations] Error checking blacklist:', err);
        res.status(500).json({ error: 'Failed to check blacklist' });
    }
});

// Get all toxic ingredients
router.get('/toxic-ingredients', requireAdmin, async (req, res) => {
    try {
        const ingredients = await getToxicIngredients();
        res.json({ data: ingredients });
    } catch (err) {
        console.error('[violations] Error fetching toxic ingredients:', err);
        res.status(500).json({ error: 'Failed to fetch toxic ingredients' });
    }
});

// Add a new toxic ingredient
router.post('/toxic-ingredients', requireAdmin, async (req, res) => {
    try {
        const { name, aliases, severity, reason, source } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Ingredient name is required' });
        }

        const result = await addToxicIngredient({ name, aliases, severity, reason, source });

        if (!result.success) {
            return res.status(400).json({ error: result.error });
        }

        res.json({ data: result });
    } catch (err) {
        console.error('[violations] Error adding toxic ingredient:', err);
        res.status(500).json({ error: 'Failed to add toxic ingredient' });
    }
});

// Get sellers with locked/banned status
router.get('/problem-sellers', requireAdmin, async (req, res) => {
    try {
        const sellers = await sql`
            SELECT id, email, full_name, violation_count, account_status, 
                   is_under_probation, probation_started_at, last_violation_at, created_at
            FROM users
            WHERE role = 'seller' AND (account_status != 'ACTIVE' OR violation_count > 0)
            ORDER BY violation_count DESC, last_violation_at DESC
        `;

        res.json({ data: sellers });
    } catch (err) {
        console.error('[violations] Error fetching problem sellers:', err);
        res.status(500).json({ error: 'Failed to fetch problem sellers' });
    }
});

// Get rejected products for AI training
router.get('/rejected-products', requireAdmin, async (req, res) => {
    try {
        const { limit = 50 } = req.query;

        const products = await sql`
            SELECT rp.*, u.email as seller_email
            FROM rejected_products rp
            LEFT JOIN users u ON rp.seller_id = u.id
            ORDER BY rp.created_at DESC
            LIMIT ${parseInt(limit)}
        `;

        res.json({ data: products });
    } catch (err) {
        console.error('[violations] Error fetching rejected products:', err);
        res.status(500).json({ error: 'Failed to fetch rejected products' });
    }
});

// Seed comprehensive toxic ingredients database
router.post('/seed-toxic-ingredients', requireAdmin, async (req, res) => {
    try {
        console.log('[violations] Admin triggered toxic ingredients seeding');
        const result = await seedToxicIngredients(sql);

        res.json({
            success: true,
            message: `Seeded ${result.added} new toxic ingredients (${result.skipped} already existed)`,
            data: result
        });
    } catch (err) {
        console.error('[violations] Error seeding toxic ingredients:', err);
        res.status(500).json({ error: 'Failed to seed toxic ingredients' });
    }
});

// Get toxic ingredients database stats
router.get('/toxic-ingredients/stats', requireAdmin, async (req, res) => {
    try {
        const dbCount = await sql`SELECT COUNT(*) as count FROM toxic_ingredients`;
        const bySeverity = await sql`
            SELECT severity, COUNT(*) as count 
            FROM toxic_ingredients 
            GROUP BY severity 
            ORDER BY severity
        `;

        res.json({
            data: {
                totalInDatabase: parseInt(dbCount[0]?.count || 0),
                availableToSeed: TOXIC_INGREDIENTS_DATABASE.length,
                bySeverity: bySeverity
            }
        });
    } catch (err) {
        console.error('[violations] Error fetching stats:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Deep scan a product with AI
router.post('/products/:id/deep-scan', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await deepScanWithAI(id, sql);

        if (result.error) {
            return res.status(400).json({ error: result.error });
        }

        res.json({ data: result });
    } catch (err) {
        console.error('[violations] Error running deep scan:', err);
        res.status(500).json({ error: 'Failed to run deep scan' });
    }
});

module.exports = router;
