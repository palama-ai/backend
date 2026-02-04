const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { generateProductDescription } = require('../lib/aiProviders');

/**
 * GET /api/barcode/lookup/:code
 * Lookup product information from Open Beauty Facts database
 * Falls back to Open Food Facts if not found in beauty database
 * Also generates AI description if product is found
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

        // If still not found, try UPCitemdb (commercial database with more products)
        if (!product) {
            product = await lookupUPCitemdb(code);
        }

        // If still not found, try Cosmily database
        if (!product) {
            product = await lookupCosmily(code);
        }

        if (product) {
            console.log(`[barcode] Found product: ${product.name}`);

            // Generate AI description for the product
            let suggestedDescription = '';
            let highlightedIngredients = [];

            if (product.name || product.ingredients || product.brand) {
                try {
                    console.log(`[barcode] Generating AI description for: ${product.brand} ${product.name}`);
                    const descResult = await generateProductDescription(
                        product.name,
                        product.brand,
                        product.ingredients
                    );
                    suggestedDescription = descResult.description || '';
                    highlightedIngredients = descResult.highlightedIngredients || [];
                    console.log(`[barcode] Description generated successfully`);
                } catch (descError) {
                    console.error('[barcode] Description generation failed:', descError.message);
                    // Continue without description - not a fatal error
                }
            }

            return res.json({
                found: true,
                product: {
                    name: product.name || '',
                    brand: product.brand || '',
                    ingredients: product.ingredients || '',
                    imageUrl: product.imageUrl || '',
                    category: product.category || '',
                    source: product.source,
                    suggestedDescription: suggestedDescription,
                    highlightedIngredients: highlightedIngredients
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

/**
 * Lookup product in UPCitemdb database (free tier)
 * @param {string} barcode - Product barcode
 * @returns {object|null} Product data or null if not found
 */
async function lookupUPCitemdb(barcode) {
    try {
        // UPCitemdb free API (limited to 100 requests/day)
        const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${barcode}`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Glowimatch/1.0'
            },
            timeout: 10000
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();

        if (data.code !== 'OK' || !data.items || data.items.length === 0) {
            return null;
        }

        const item = data.items[0];

        // Check if it looks like a beauty/cosmetic product
        const title = (item.title || '').toLowerCase();
        const category = (item.category || '').toLowerCase();
        const description = (item.description || '').toLowerCase();

        const isBeautyProduct =
            category.includes('beauty') ||
            category.includes('cosmetic') ||
            category.includes('skin') ||
            category.includes('hair') ||
            category.includes('personal care') ||
            title.includes('serum') ||
            title.includes('cream') ||
            title.includes('lotion') ||
            title.includes('cleanser') ||
            title.includes('moisturizer') ||
            title.includes('sunscreen');

        // Accept all products from UPCitemdb (user can verify)
        return {
            name: item.title || '',
            brand: item.brand || '',
            ingredients: '', // UPCitemdb doesn't provide ingredients
            imageUrl: (item.images && item.images.length > 0) ? item.images[0] : '',
            category: isBeautyProduct ? extractCategoryFromTitle(item.title || '') : '',
            source: 'upcitemdb'
        };
    } catch (err) {
        console.error('[barcode] UPCitemdb error:', err.message);
        return null;
    }
}

/**
 * Lookup product in Cosmily (cosmetics-focused database)
 * @param {string} barcode - Product barcode
 * @returns {object|null} Product data or null if not found
 */
async function lookupCosmily(barcode) {
    try {
        // Try the Open Products Facts (covers more products)
        const url = `https://world.openproductsfacts.org/api/v2/product/${barcode}.json`;
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
            source: 'openproductsfacts'
        };
    } catch (err) {
        console.error('[barcode] Open Products Facts error:', err.message);
        return null;
    }
}

/**
 * Extract category from product title
 * @param {string} title - Product title
 * @returns {string} Mapped category
 */
function extractCategoryFromTitle(title) {
    const t = title.toLowerCase();

    if (t.includes('cleanser') || t.includes('wash') || t.includes('soap') || t.includes('gel')) {
        return 'cleanser';
    }
    if (t.includes('toner') || t.includes('tonic') || t.includes('lotion')) {
        return 'toner';
    }
    if (t.includes('serum') || t.includes('essence') || t.includes('ampoule')) {
        return 'serum';
    }
    if (t.includes('moistur') || t.includes('cream') || t.includes('hydrat')) {
        return 'moisturizer';
    }
    if (t.includes('sunscreen') || t.includes('spf') || t.includes('sun')) {
        return 'sunscreen';
    }
    if (t.includes('mask') || t.includes('masque')) {
        return 'mask';
    }
    if (t.includes('treatment') || t.includes('acid') || t.includes('retinol') || t.includes('peel')) {
        return 'treatment';
    }

    return '';
}

module.exports = router;
