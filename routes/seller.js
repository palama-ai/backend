const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET || 'dev_secret_change_me';

// Middleware to authenticate seller
const requireSeller = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        // Check if user exists and is a seller
        const users = await sql`SELECT id, email, role FROM users WHERE id = ${decoded.id}`;
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
        return res.status(401).json({ error: 'Invalid token' });
    }
};

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

// Create new product
router.post('/products', requireSeller, async (req, res) => {
    try {
        const { name, brand, description, price, original_price, image_url, category, skin_types, concerns, purchase_url } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Product name is required' });
        }

        const id = uuidv4();
        const skinTypesJson = skin_types ? JSON.stringify(skin_types) : null;
        const concernsJson = concerns ? JSON.stringify(concerns) : null;

        await sql`
      INSERT INTO seller_products (id, seller_id, name, brand, description, price, original_price, image_url, category, skin_types, concerns, purchase_url)
      VALUES (${id}, ${req.user.id}, ${name}, ${brand || null}, ${description || null}, ${price || null}, ${original_price || null}, ${image_url || null}, ${category || null}, ${skinTypesJson}, ${concernsJson}, ${purchase_url || null})
    `;

        res.json({ data: { id, message: 'Product created successfully' } });
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

module.exports = router;
