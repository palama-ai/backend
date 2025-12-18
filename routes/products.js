const express = require('express');
const router = express.Router();
const { sql } = require('../db');

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
 */
router.post('/:id/view', async (req, res) => {
    try {
        const { id } = req.params;

        // Increment view count
        await sql`
            UPDATE seller_products 
            SET view_count = COALESCE(view_count, 0) + 1 
            WHERE id = ${id}
        `;

        // Optionally track in product_views table for detailed analytics
        try {
            await sql`
                INSERT INTO product_views (id, product_id, created_at)
                VALUES (gen_random_uuid(), ${id}, NOW())
            `;
        } catch (e) {
            // Ignore if product_views table doesn't exist
        }

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

module.exports = router;
