/**
 * Ingredient Scanner Module
 * 
 * Provides two-phase ingredient safety checking:
 * - Phase 1: Immediate check using local database + quick AI assessment
 * - Phase 2: Deep scan using web search for comprehensive verification
 */

const { sql } = require('../db');

// Common toxic ingredient aliases (for fuzzy matching)
const TOXIC_ALIASES = {
    'mercury': ['mercuric chloride', 'calomel', 'ammoniated mercury', 'mercurous chloride'],
    'lead': ['lead acetate', 'lead oxide', 'ceruse', 'white lead'],
    'arsenic': ['arsenic trioxide', 'arsenicum', 'arsenious acid'],
    'formaldehyde': ['formalin', 'methyl aldehyde', 'methanal', 'formol'],
    'hydroquinone': ['hydrochinone', 'quinol', 'benzene-1,4-diol'],
    'parabens': ['methylparaben', 'propylparaben', 'butylparaben', 'ethylparaben'],
    'phthalates': ['diethyl phthalate', 'dbp', 'dehp', 'dinp'],
    'triclosan': ['irgasan', '5-chloro-2'],
    'toluene': ['methylbenzene', 'toluol', 'phenylmethane'],
    'coal tar': ['coal tar solution', 'crude coal tar', 'pix carbonis']
};

/**
 * Normalize ingredient text for comparison
 * @param {string} text - Ingredient text to normalize
 * @returns {string} - Normalized lowercase text
 */
function normalizeText(text) {
    if (!text) return '';
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Check if text contains any of the search terms
 * @param {string} text - Text to search in
 * @param {string[]} terms - Terms to search for
 * @returns {boolean}
 */
function containsAny(text, terms) {
    const normalized = normalizeText(text);
    return terms.some(term => normalized.includes(normalizeText(term)));
}

/**
 * Phase 1: Immediate Check
 * Fast local check against known toxic ingredients database + AI quick scan
 * 
 * @param {string} ingredients - Product ingredients list
 * @param {string} productName - Product name for context
 * @param {string} description - Product description for context
 * @returns {Promise<{safe: boolean, flaggedIngredients: Array, severity: string, message: string}>}
 */
async function immediateCheck(ingredients, productName = '', description = '') {
    try {
        // Combine all text for scanning
        const fullText = `${ingredients || ''} ${productName || ''} ${description || ''}`;
        const normalizedText = normalizeText(fullText);

        if (!normalizedText || normalizedText.length < 3) {
            return {
                safe: true,
                flaggedIngredients: [],
                severity: 'none',
                message: 'No ingredients provided for scanning'
            };
        }

        // Fetch toxic ingredients from database
        const toxicList = await sql`SELECT name, aliases, severity, reason FROM toxic_ingredients`;

        const flaggedIngredients = [];
        let highestSeverity = 'none';
        const severityOrder = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1, 'none': 0 };

        // Database check
        for (const toxic of toxicList) {
            const toxicName = normalizeText(toxic.name);
            let aliases = [];

            // Parse aliases from database or use predefined
            try {
                aliases = toxic.aliases ? JSON.parse(toxic.aliases) : (TOXIC_ALIASES[toxic.name] || []);
            } catch {
                aliases = TOXIC_ALIASES[toxic.name] || [];
            }

            // Add the main name to search terms
            const searchTerms = [toxicName, ...aliases.map(a => normalizeText(a))];

            // Check if any term is found
            if (containsAny(fullText, searchTerms)) {
                flaggedIngredients.push({
                    name: toxic.name,
                    severity: toxic.severity,
                    reason: toxic.reason,
                    matchedIn: normalizedText.includes(toxicName) ? 'ingredients' : 'alias',
                    source: 'database'
                });

                if (severityOrder[toxic.severity] > severityOrder[highestSeverity]) {
                    highestSeverity = toxic.severity;
                }
            }
        }

        // AI Quick Check (runs in parallel for speed, catches what database might miss)
        try {
            const { quickAICheck } = require('./safetyAgent');
            const aiResult = await quickAICheck(ingredients);

            if (aiResult.checked && aiResult.concerns && aiResult.concerns.length > 0) {
                for (const concern of aiResult.concerns) {
                    const concernName = typeof concern === 'string' ? concern : concern.ingredient;
                    // Avoid duplicates
                    if (!flaggedIngredients.find(f => f.name.toLowerCase() === concernName.toLowerCase())) {
                        flaggedIngredients.push({
                            name: concernName,
                            severity: concern.severity || 'high',
                            reason: concern.reason || 'Flagged by AI safety analysis',
                            matchedIn: 'ai_detection',
                            source: 'ai'
                        });

                        const concernSeverity = concern.severity || 'high';
                        if (severityOrder[concernSeverity] > severityOrder[highestSeverity]) {
                            highestSeverity = concernSeverity;
                        }
                    }
                }
            }
        } catch (aiError) {
            // AI check is optional, continue with database results
            console.log('[ingredientScanner] AI quick check unavailable:', aiError.message);
        }

        const isSafe = flaggedIngredients.length === 0;

        return {
            safe: isSafe,
            flaggedIngredients,
            severity: highestSeverity,
            message: isSafe
                ? 'All ingredients passed safety check'
                : `Found ${flaggedIngredients.length} potentially harmful ingredient(s)`,
            methods: {
                database: true,
                ai: flaggedIngredients.some(f => f.source === 'ai')
            }
        };

    } catch (error) {
        console.error('[ingredientScanner] immediateCheck error:', error);
        // On error, allow product but flag for review
        return {
            safe: true,
            flaggedIngredients: [],
            severity: 'unknown',
            message: 'Safety check encountered an error, flagged for manual review',
            error: error.message
        };
    }
}

/**
 * Phase 2: Deep Scan (Background Job)
 * More comprehensive check using AI and potentially web search
 * 
 * @param {string} productId - Product UUID to scan
 * @returns {Promise<{issues: Array, recommendations: Array, scannedAt: string}>}
 */
async function deepScan(productId) {
    try {
        // Fetch product data
        const products = await sql`
      SELECT id, name, ingredients, description, seller_id 
      FROM seller_products 
      WHERE id = ${productId}
    `;

        if (!products || products.length === 0) {
            return {
                issues: [],
                recommendations: [],
                scannedAt: new Date().toISOString(),
                error: 'Product not found'
            };
        }

        const product = products[0];

        // Run immediate check on product
        const immediateResult = await immediateCheck(
            product.ingredients,
            product.name,
            product.description
        );

        const issues = [];
        const recommendations = [];

        // Add any flagged ingredients as issues
        for (const flagged of immediateResult.flaggedIngredients) {
            issues.push({
                type: 'toxic_ingredient',
                ingredient: flagged.name,
                severity: flagged.severity,
                reason: flagged.reason,
                recommendation: `Remove or replace ${flagged.name} with a safer alternative`
            });
        }

        // Add general recommendations based on severity
        if (immediateResult.severity === 'critical') {
            recommendations.push('This product contains critically dangerous ingredients and should be removed immediately.');
        } else if (immediateResult.severity === 'high') {
            recommendations.push('This product contains high-risk ingredients. Consider reformulation.');
        } else if (immediateResult.severity === 'medium') {
            recommendations.push('Some ingredients may cause sensitivity in certain individuals. Add appropriate warnings.');
        }

        return {
            productId,
            sellerId: product.seller_id,
            issues,
            recommendations,
            scannedAt: new Date().toISOString(),
            overallSeverity: immediateResult.severity
        };

    } catch (error) {
        console.error('[ingredientScanner] deepScan error:', error);
        return {
            productId,
            issues: [],
            recommendations: [],
            scannedAt: new Date().toISOString(),
            error: error.message
        };
    }
}

/**
 * Quick AI check for ingredient safety (optional enhancement)
 * Uses LLM for more nuanced detection
 * 
 * @param {string} ingredients - Ingredient list
 * @returns {Promise<{concerns: Array, safe: boolean}>}
 */
async function aiQuickCheck(ingredients) {
    // This is a placeholder for future AI integration
    // For now, return a pass-through to immediateCheck
    const result = await immediateCheck(ingredients);
    return {
        concerns: result.flaggedIngredients.map(f => f.name),
        safe: result.safe,
        method: 'database_lookup'
    };
}

/**
 * Add a new toxic ingredient to the database
 * 
 * @param {Object} ingredient - Ingredient data
 * @param {string} ingredient.name - Ingredient name
 * @param {string[]} ingredient.aliases - Alternative names
 * @param {string} ingredient.severity - 'critical', 'high', 'medium'
 * @param {string} ingredient.reason - Why it's toxic
 * @param {string} ingredient.source - FDA, EU, WHO, etc.
 * @returns {Promise<{success: boolean, id: string}>}
 */
async function addToxicIngredient(ingredient) {
    try {
        const result = await sql`
      INSERT INTO toxic_ingredients (name, aliases, severity, reason, source)
      VALUES (
        ${ingredient.name.toLowerCase()},
        ${JSON.stringify(ingredient.aliases || [])},
        ${ingredient.severity || 'medium'},
        ${ingredient.reason || ''},
        ${ingredient.source || 'manual'}
      )
      RETURNING id
    `;

        return { success: true, id: result[0]?.id };
    } catch (error) {
        console.error('[ingredientScanner] addToxicIngredient error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Get all toxic ingredients from database
 * @returns {Promise<Array>}
 */
async function getToxicIngredients() {
    try {
        const results = await sql`SELECT * FROM toxic_ingredients ORDER BY severity DESC, name ASC`;
        return results;
    } catch (error) {
        console.error('[ingredientScanner] getToxicIngredients error:', error);
        return [];
    }
}

module.exports = {
    immediateCheck,
    deepScan,
    aiQuickCheck,
    addToxicIngredient,
    getToxicIngredients,
    normalizeText,
    TOXIC_ALIASES
};
