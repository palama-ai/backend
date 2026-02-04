const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

/**
 * GET /api/barcode/lookup/:code
 * Lookup product information from Open Beauty Facts database
 * Falls back to Open Food Facts if not found in beauty database
 */
router.get('/lookup/:code', async (req, res) => {
    try {
        const { code } = req.params;

        // Validate barcode format (EAN-13, UPC-A, etc.)
        if (!code || !/^\d{8,14}$/.test(code)) {
            return res.status(400).json({
                found: false,
                error: 'Invalid barcode format. Expected 8-14 digits.'
            });
        }

        console.log(`[barcode] Looking up barcode: ${code}`);

        // Try Open Beauty Facts first (specifically for cosmetics)
        let product = await lookupOpenBeautyFacts(code);

        // If not found, try Open Food Facts (has some beauty products too)
        if (!product) {
            product = await lookupOpenFoodFacts(code);
        }

        if (product) {
            console.log(`[barcode] Found product: ${product.name}`);
            return res.json({
                found: true,
                product: {
                    name: product.name || '',
                    brand: product.brand || '',
                    ingredients: product.ingredients || '',
                    imageUrl: product.imageUrl || '',
                    category: product.category || '',
                    source: product.source
                }
            });
        }

        console.log(`[barcode] Product not found for barcode: ${code}`);
        return res.json({
            found: false,
            message: 'Product not found in database'
        });

    } catch (err) {
        console.error('[barcode] Lookup error:', err);
        return res.status(500).json({
            found: false,
            error: 'Failed to lookup barcode'
        });
    }
});

/**
 * Lookup product in Open Beauty Facts database
 * @param {string} barcode - Product barcode
 * @returns {object|null} Product data or null if not found
 */
async function lookupOpenBeautyFacts(barcode) {
    try {
        const url = `https://world.openbeautyfacts.org/api/v2/product/${barcode}.json`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Glowimatch/1.0 (contact@glowimatch.com)'
            },
            timeout: 10000
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();

        if (data.status !== 1 || !data.product) {
            return null;
        }

        const p = data.product;
        return {
            name: p.product_name || p.product_name_en || p.product_name_fr || '',
            brand: p.brands || '',
            ingredients: p.ingredients_text || p.ingredients_text_en || p.ingredients_text_fr || '',
            imageUrl: p.image_front_url || p.image_url || '',
            category: extractCategory(p.categories_tags || []),
            source: 'openbeautyfacts'
        };
    } catch (err) {
        console.error('[barcode] Open Beauty Facts error:', err.message);
        return null;
    }
}

/**
 * Lookup product in Open Food Facts database (fallback)
 * @param {string} barcode - Product barcode
 * @returns {object|null} Product data or null if not found
 */
async function lookupOpenFoodFacts(barcode) {
    try {
        const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Glowimatch/1.0 (contact@glowimatch.com)'
            },
            timeout: 10000
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();

        if (data.status !== 1 || !data.product) {
            return null;
        }

        const p = data.product;

        // Only accept if it looks like a beauty/cosmetic product
        const categories = (p.categories_tags || []).join(' ').toLowerCase();
        const isBeautyProduct = categories.includes('beauty') ||
            categories.includes('cosmetic') ||
            categories.includes('skin') ||
            categories.includes('hair') ||
            categories.includes('hygien');

        if (!isBeautyProduct) {
            return null; // Skip non-beauty products
        }

        return {
            name: p.product_name || p.product_name_en || '',
            brand: p.brands || '',
            ingredients: p.ingredients_text || p.ingredients_text_en || '',
            imageUrl: p.image_front_url || p.image_url || '',
            category: extractCategory(p.categories_tags || []),
            source: 'openfoodfacts'
        };
    } catch (err) {
        console.error('[barcode] Open Food Facts error:', err.message);
        return null;
    }
}

/**
 * Extract cosmetic category from tags
 * @param {string[]} tags - Category tags from API
 * @returns {string} Mapped category or empty string
 */
function extractCategory(tags) {
    const tagStr = tags.join(' ').toLowerCase();

    if (tagStr.includes('cleanser') || tagStr.includes('wash') || tagStr.includes('soap')) {
        return 'cleanser';
    }
    if (tagStr.includes('toner') || tagStr.includes('tonic')) {
        return 'toner';
    }
    if (tagStr.includes('serum') || tagStr.includes('essence')) {
        return 'serum';
    }
    if (tagStr.includes('moistur') || tagStr.includes('cream') || tagStr.includes('lotion')) {
        return 'moisturizer';
    }
    if (tagStr.includes('sunscreen') || tagStr.includes('spf') || tagStr.includes('sun protection')) {
        return 'sunscreen';
    }
    if (tagStr.includes('mask') || tagStr.includes('masque')) {
        return 'mask';
    }
    if (tagStr.includes('treatment') || tagStr.includes('acid') || tagStr.includes('retinol')) {
        return 'treatment';
    }

    return '';
}

module.exports = router;
