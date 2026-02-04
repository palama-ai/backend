const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { sql } = require('../db');
const { analyzeProductImageWithOCR, generateProductDescription } = require('../lib/aiProviders');

const JWT_SECRET = process.env.GLOWMATCH_JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] CRITICAL: GLOWMATCH_JWT_SECRET environment variable is not set!');
    process.exit(1);
}

// Middleware to authenticate seller
const requireSeller = async (req, res, next) => {
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

        const user = users[0];
        if (user.role !== 'seller' && user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied. Seller account required.' });
        }

        req.user = user;
        next();
    } catch (err) {
        console.error('[product-onboarding] Auth error:', err.message);
        return res.status(401).json({ error: 'Invalid token' });
    }
};

/**
 * POST /api/product-onboarding/analyze-image
 * Analyze a product label image using AI OCR to extract product information
 * 
 * Request body:
 * - image: Base64 encoded image (with or without data URI prefix)
 * 
 * Response:
 * - brand: Extracted brand name
 * - name: Extracted product name
 * - ingredients: Extracted ingredients list
 * - suggestedDescription: AI-generated marketing description
 * - confidence: OCR confidence score (0-100)
 */
router.post('/analyze-image', requireSeller, async (req, res) => {
    try {
        const { image } = req.body;

        if (!image) {
            return res.status(400).json({
                error: 'No image provided',
                message: 'Please provide a base64 encoded image in the "image" field'
            });
        }

        console.log(`[product-onboarding] Starting AI analysis for seller: ${req.user.email}`);

        // Step 1: Extract text using OCR
        const ocrResult = await analyzeProductImageWithOCR(image);

        console.log(`[product-onboarding] OCR result - Brand: ${ocrResult.brand}, Name: ${ocrResult.name}, Confidence: ${ocrResult.confidence}`);

        // Step 2: Generate product description if we have enough data
        let suggestedDescription = '';
        let highlightedIngredients = [];

        if (ocrResult.name || ocrResult.ingredients) {
            const descResult = await generateProductDescription(
                ocrResult.name,
                ocrResult.brand,
                ocrResult.ingredients
            );
            suggestedDescription = descResult.description;
            highlightedIngredients = descResult.highlightedIngredients || [];
        }

        // Return combined result
        res.json({
            success: true,
            data: {
                brand: ocrResult.brand || '',
                name: ocrResult.name || '',
                ingredients: ocrResult.ingredients || '',
                suggestedDescription: suggestedDescription,
                highlightedIngredients: highlightedIngredients,
                confidence: ocrResult.confidence || 0,
                parseError: ocrResult.parseError || false
            }
        });

    } catch (err) {
        console.error('[product-onboarding] Analysis error:', err);
        res.status(500).json({
            error: 'Failed to analyze product image',
            message: err.message || 'An unexpected error occurred'
        });
    }
});

/**
 * POST /api/product-onboarding/generate-description
 * Generate a marketing description for a product based on its details
 * 
 * Request body:
 * - name: Product name
 * - brand: Brand name
 * - ingredients: Comma-separated ingredients list
 * 
 * Response:
 * - description: Generated marketing description
 * - highlightedIngredients: Key ingredients mentioned in description
 */
router.post('/generate-description', requireSeller, async (req, res) => {
    try {
        const { name, brand, ingredients } = req.body;

        if (!name && !ingredients) {
            return res.status(400).json({
                error: 'Insufficient data',
                message: 'Please provide at least a product name or ingredients list'
            });
        }

        console.log(`[product-onboarding] Generating description for: ${brand} ${name}`);

        const result = await generateProductDescription(name, brand, ingredients);

        res.json({
            success: true,
            data: {
                description: result.description,
                highlightedIngredients: result.highlightedIngredients || []
            }
        });

    } catch (err) {
        console.error('[product-onboarding] Description generation error:', err);
        res.status(500).json({
            error: 'Failed to generate description',
            message: err.message || 'An unexpected error occurred'
        });
    }
});

module.exports = router;
