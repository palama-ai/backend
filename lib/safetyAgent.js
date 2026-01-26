/**
 * Safety Agent Module
 * 
 * AI-powered deep analysis for cosmetic ingredient safety.
 * Uses Gemini AI for comprehensive ingredient analysis.
 */

// Comprehensive list of toxic/banned ingredients from FDA, EU, and international regulations
const TOXIC_INGREDIENTS_DATABASE = [
    // ========================
    // CRITICAL - Banned Internationally
    // ========================

    // Heavy Metals
    { name: 'mercury', aliases: ['mercuric chloride', 'calomel', 'ammoniated mercury', 'mercurous chloride', 'thimerosal', 'mercury iodide'], severity: 'critical', reason: 'Heavy metal poisoning, neurological damage, kidney failure', source: 'FDA/EU' },
    { name: 'lead', aliases: ['lead acetate', 'lead oxide', 'ceruse', 'white lead', 'plumbum'], severity: 'critical', reason: 'Neurological damage, developmental toxicity, carcinogen', source: 'FDA/EU' },
    { name: 'arsenic', aliases: ['arsenic trioxide', 'arsenicum', 'arsenious acid', 'arsenic compounds'], severity: 'critical', reason: 'Carcinogen, systemic toxicity', source: 'FDA/EU' },
    { name: 'cadmium', aliases: ['cadmium chloride', 'cadmium oxide', 'cadmium compounds'], severity: 'critical', reason: 'Carcinogen, kidney and bone damage', source: 'FDA/EU' },
    { name: 'chromium vi', aliases: ['hexavalent chromium', 'chromium trioxide', 'chromate'], severity: 'critical', reason: 'Carcinogen, severe skin burns', source: 'EU' },
    { name: 'antimony', aliases: ['antimony trioxide', 'antimony compounds'], severity: 'critical', reason: 'Toxic to heart and lungs', source: 'EU' },

    // Carcinogens
    { name: 'formaldehyde', aliases: ['formalin', 'methyl aldehyde', 'methanal', 'formol', 'oxymethylene'], severity: 'critical', reason: 'Carcinogen (Category 1B), causes cancer', source: 'EU 2019' },
    { name: 'coal tar', aliases: ['coal tar solution', 'crude coal tar', 'pix carbonis', 'coal tar dyes'], severity: 'critical', reason: 'Known carcinogen, linked to skin cancer', source: 'EU' },
    { name: 'chloroform', aliases: ['trichloromethane', 'methyl trichloride'], severity: 'critical', reason: 'Carcinogen, liver and kidney damage', source: 'FDA' },
    { name: 'methylene chloride', aliases: ['dichloromethane', 'dcm'], severity: 'critical', reason: 'Carcinogen, neurotoxin', source: 'FDA' },
    { name: 'benzene', aliases: ['benzol', 'phenyl hydride'], severity: 'critical', reason: 'Known carcinogen, causes leukemia', source: 'FDA/EU' },
    { name: 'ethylene oxide', aliases: ['oxirane', 'eto'], severity: 'critical', reason: 'Carcinogen, mutagen', source: 'EU' },

    // Skin Bleaching Agents (banned)
    { name: 'hydroquinone', aliases: ['hydrochinone', 'quinol', 'benzene-1,4-diol', '1,4-benzenediol', 'hq'], severity: 'critical', reason: 'Ochronosis, potential carcinogen, organ toxicity', source: 'EU' },
    { name: 'clobetasol', aliases: ['clobetasol propionate', 'clobesol'], severity: 'critical', reason: 'Potent steroid, skin damage, hormone disruption', source: 'Prescription only' },
    { name: 'betamethasone', aliases: ['betamethasone dipropionate', 'betnovate'], severity: 'critical', reason: 'Potent corticosteroid, skin atrophy', source: 'Prescription only' },

    // Other Critical
    { name: 'hexachlorophene', aliases: ['nabac', 'hexachlorofen'], severity: 'critical', reason: 'Neurotoxin, causes brain damage', source: 'FDA' },
    { name: 'bithionol', aliases: ['thiobis', 'bithionolate'], severity: 'critical', reason: 'Severe photosensitivity', source: 'FDA' },
    { name: 'vinyl chloride', aliases: ['chloroethene', 'monochloroethylene'], severity: 'critical', reason: 'Known carcinogen', source: 'FDA' },

    // ========================
    // HIGH RISK - Restricted/Limited
    // ========================

    // Formaldehyde Releasers
    { name: 'dmdm hydantoin', aliases: ['dmdm', 'dimethylol dimethyl hydantoin', 'glydant'], severity: 'high', reason: 'Formaldehyde releaser, carcinogen risk', source: 'EU 2024' },
    { name: 'imidazolidinyl urea', aliases: ['germall 115', 'imidurea'], severity: 'high', reason: 'Formaldehyde releaser', source: 'EU 2024' },
    { name: 'diazolidinyl urea', aliases: ['germall ii', 'diazolidinylurea'], severity: 'high', reason: 'Formaldehyde releaser', source: 'EU 2024' },
    { name: 'quaternium-15', aliases: ['dowicil 200', 'quaternium 15'], severity: 'high', reason: 'Formaldehyde releaser', source: 'EU 2024' },
    { name: 'bronopol', aliases: ['2-bromo-2-nitropropane-1,3-diol', 'bronopole'], severity: 'high', reason: 'Formaldehyde releaser', source: 'EU' },
    { name: 'sodium hydroxymethylglycinate', aliases: ['suttocide a'], severity: 'high', reason: 'Formaldehyde releaser', source: 'EU' },

    // Endocrine Disruptors
    { name: 'triclosan', aliases: ['irgasan', '5-chloro-2', 'microban', 'tcs'], severity: 'high', reason: 'Hormone disruption, antibiotic resistance', source: 'EU/FDA' },
    { name: 'triclocarban', aliases: ['tcc', 'triclocarbone'], severity: 'high', reason: 'Hormone disruption', source: 'EU' },
    { name: 'bha', aliases: ['butylated hydroxyanisole', 'e320'], severity: 'high', reason: 'Potential carcinogen, endocrine disruptor', source: 'EU/CA' },
    { name: 'bht', aliases: ['butylated hydroxytoluene', 'e321'], severity: 'high', reason: 'Potential carcinogen', source: 'CA' },

    // Banned Parabens
    { name: 'isopropylparaben', aliases: ['isopropyl paraben', 'isopropyl 4-hydroxybenzoate'], severity: 'high', reason: 'Endocrine disruptor, banned in EU', source: 'EU' },
    { name: 'isobutylparaben', aliases: ['isobutyl paraben', 'isobutyl 4-hydroxybenzoate'], severity: 'high', reason: 'Endocrine disruptor, banned in EU', source: 'EU' },
    { name: 'phenylparaben', aliases: ['phenyl paraben'], severity: 'high', reason: 'Endocrine disruptor, banned in EU', source: 'EU' },
    { name: 'benzylparaben', aliases: ['benzyl paraben'], severity: 'high', reason: 'Endocrine disruptor, banned in EU', source: 'EU' },
    { name: 'pentylparaben', aliases: ['pentyl paraben', 'amyl paraben'], severity: 'high', reason: 'Endocrine disruptor, banned in EU', source: 'EU' },

    // Phthalates
    { name: 'diethyl phthalate', aliases: ['dep', 'phthalic acid diethyl ester'], severity: 'high', reason: 'Reproductive toxicity, endocrine disruption', source: 'EU/CA' },
    { name: 'dibutyl phthalate', aliases: ['dbp', 'butyl phthalate'], severity: 'high', reason: 'Reproductive toxicity, banned in EU cosmetics', source: 'EU' },
    { name: 'di-2-ethylhexyl phthalate', aliases: ['dehp', 'bis(2-ethylhexyl) phthalate'], severity: 'high', reason: 'Reproductive toxicity', source: 'EU' },
    { name: 'phthalates', aliases: ['phthalate', 'diisononyl phthalate', 'dinp'], severity: 'high', reason: 'Endocrine disruptors, reproductive toxicity', source: 'EU/CA' },

    // UV Filters (Banned)
    { name: '4-methylbenzylidene camphor', aliases: ['4-mbc', 'enzacamene', 'parsol 5000'], severity: 'high', reason: 'Endocrine disruptor, banned EU 2025', source: 'EU 2024' },
    { name: 'oxybenzone', aliases: ['benzophenone-3', 'bp-3'], severity: 'high', reason: 'Hormone disruption, coral reef damage', source: 'Hawaii/Palau' },
    { name: 'octinoxate', aliases: ['ethylhexyl methoxycinnamate', 'octyl methoxycinnamate'], severity: 'high', reason: 'Hormone disruption, coral damage', source: 'Hawaii' },

    // PFAS
    { name: 'pfas', aliases: ['perfluoroalkyl', 'polyfluoroalkyl', 'ptfe', 'teflon', 'pfoa', 'pfos'], severity: 'high', reason: 'Forever chemicals, bioaccumulative, carcinogen', source: 'EU 2024' },

    // Other High Risk
    { name: 'toluene', aliases: ['methylbenzene', 'toluol', 'phenylmethane'], severity: 'high', reason: 'Neurotoxin, developmental toxicity', source: 'EU/CA' },
    { name: 'resorcinol', aliases: ['resorcin', '1,3-benzenediol', 'm-dihydroxybenzene'], severity: 'high', reason: 'Skin irritant, potential endocrine disruptor', source: 'EU restricted' },
    { name: 'homosalate', aliases: ['hms', '3,3,5-trimethylcyclohexyl salicylate'], severity: 'high', reason: 'Hormone disruption', source: 'EU restricted' },
    { name: 'octocrylene', aliases: ['2-ethylhexyl 2-cyano-3,3-diphenylacrylate'], severity: 'high', reason: 'Generates benzophenone over time', source: 'EU restricted' },

    // Silicones (Restricted)
    { name: 'cyclotetrasiloxane', aliases: ['d4', 'octamethylcyclotetrasiloxane'], severity: 'high', reason: 'PBT substance, endocrine disruption', source: 'EU 2024' },
    { name: 'cyclopentasiloxane', aliases: ['d5', 'decamethylcyclopentasiloxane'], severity: 'high', reason: 'vPvB substance, environmental persistence', source: 'EU 2024' },
    { name: 'cyclohexasiloxane', aliases: ['d6', 'dodecamethylcyclohexasiloxane'], severity: 'high', reason: 'PBT substance', source: 'EU 2024' },

    // ========================
    // MEDIUM RISK - Limited/Warnings Required
    // ========================

    // Parabens (Restricted, not banned)
    { name: 'methylparaben', aliases: ['methyl paraben', 'methyl 4-hydroxybenzoate', 'e218'], severity: 'medium', reason: 'Potential endocrine disruption, limited to 0.4%', source: 'EU restricted' },
    { name: 'ethylparaben', aliases: ['ethyl paraben', 'ethyl 4-hydroxybenzoate', 'e214'], severity: 'medium', reason: 'Potential endocrine disruption, limited to 0.4%', source: 'EU restricted' },
    { name: 'propylparaben', aliases: ['propyl paraben', 'propyl 4-hydroxybenzoate', 'e216'], severity: 'medium', reason: 'Restricted to 0.14%, banned in baby products', source: 'EU restricted' },
    { name: 'butylparaben', aliases: ['butyl paraben', 'butyl 4-hydroxybenzoate'], severity: 'medium', reason: 'Restricted to 0.14%, banned in baby products', source: 'EU restricted' },

    // Vitamin A Derivatives (New EU 2024 restrictions)
    { name: 'retinol', aliases: ['vitamin a', 'retinyl'], severity: 'medium', reason: 'Skin sensitivity, restricted concentrations', source: 'EU 2024' },
    { name: 'retinyl palmitate', aliases: ['retinol palmitate', 'vitamin a palmitate'], severity: 'medium', reason: 'Restricted in body lotions (0.05%)', source: 'EU 2024' },
    { name: 'retinyl acetate', aliases: ['retinol acetate', 'vitamin a acetate'], severity: 'medium', reason: 'Restricted in leave-on products', source: 'EU 2024' },

    // Skin Lightening (Restricted)
    { name: 'alpha-arbutin', aliases: ['alpha arbutin', 'α-arbutin'], severity: 'medium', reason: 'Limited to 2% in face creams', source: 'EU 2024' },
    { name: 'arbutin', aliases: ['beta-arbutin', 'β-arbutin'], severity: 'medium', reason: 'Limited to 7% in face products', source: 'EU 2024' },
    { name: 'kojic acid', aliases: ['koji acid', '5-hydroxy-2-hydroxymethyl-4-pyrone'], severity: 'medium', reason: 'Limited to 1% in face/hand products', source: 'EU 2024' },

    // Acids (concentration dependent)
    { name: 'salicylic acid', aliases: ['bha', '2-hydroxybenzoic acid'], severity: 'medium', reason: 'Limited concentrations, not for children under 3', source: 'EU/FDA' },
    { name: 'glycolic acid', aliases: ['hydroxyacetic acid'], severity: 'medium', reason: 'High concentrations cause burns', source: 'EU restricted' },
    { name: 'lactic acid', aliases: ['2-hydroxypropanoic acid'], severity: 'medium', reason: 'High concentrations may irritate', source: 'EU restricted' },

    // Fragrances & Allergens
    { name: 'fragrance', aliases: ['parfum', 'perfume', 'aroma'], severity: 'medium', reason: 'Allergen, may contain phthalates', source: 'EU requires disclosure' },
    { name: 'limonene', aliases: ['d-limonene', 'dipentene'], severity: 'medium', reason: 'Allergen requiring disclosure', source: 'EU' },
    { name: 'linalool', aliases: ['linalol', '3,7-dimethyl-1,6-octadien-3-ol'], severity: 'medium', reason: 'Allergen requiring disclosure', source: 'EU' },
    { name: 'citral', aliases: ['geranial', 'neral'], severity: 'medium', reason: 'Allergen requiring disclosure', source: 'EU' },
    { name: 'coumarin', aliases: ['2h-chromen-2-one'], severity: 'medium', reason: 'Allergen, liver toxicity at high doses', source: 'EU' },
    { name: 'eugenol', aliases: ['4-allyl-2-methoxyphenol'], severity: 'medium', reason: 'Allergen requiring disclosure', source: 'EU' },
    { name: 'cinnamal', aliases: ['cinnamaldehyde', 'cinnamic aldehyde'], severity: 'medium', reason: 'Allergen requiring disclosure', source: 'EU' },

    // Preservatives (Restricted)
    { name: 'methylisothiazolinone', aliases: ['mi', 'mit', 'neolone 950'], severity: 'medium', reason: 'Skin sensitizer, banned in leave-on products', source: 'EU' },
    { name: 'methylchloroisothiazolinone', aliases: ['mci', 'kathon cg'], severity: 'medium', reason: 'Skin sensitizer, restricted use', source: 'EU' },
    { name: 'phenoxyethanol', aliases: ['2-phenoxyethanol', 'rose ether'], severity: 'medium', reason: 'Limited to 1%, not for babies', source: 'Japan/EU' },

    // Sulfates (irritation potential)
    { name: 'sodium lauryl sulfate', aliases: ['sls', 'sodium dodecyl sulfate', 'sds'], severity: 'medium', reason: 'Skin and eye irritation', source: 'General concern' },
    { name: 'sodium laureth sulfate', aliases: ['sles', 'sodium lauryl ether sulfate'], severity: 'medium', reason: 'May contain 1,4-dioxane impurity', source: 'General concern' },

    // Alcohols (drying)
    { name: 'denatured alcohol', aliases: ['alcohol denat', 'sd alcohol', 'ethanol'], severity: 'medium', reason: 'Drying, irritating in high concentrations', source: 'General concern' },
    { name: 'isopropyl alcohol', aliases: ['isopropanol', 'rubbing alcohol', 'ipa'], severity: 'medium', reason: 'Very drying, irritating', source: 'General concern' },

    // ========================
    // NANO MATERIALS (EU 2024 banned)
    // ========================
    { name: 'styrene/acrylate copolymer nano', aliases: ['styrene acrylate nano'], severity: 'high', reason: 'Nano material banned in EU', source: 'EU 2024' },
    { name: 'colloidal silver nano', aliases: ['nano silver', 'silver nanoparticles'], severity: 'high', reason: 'Nano material banned in EU', source: 'EU 2024' },
    { name: 'colloidal gold nano', aliases: ['nano gold', 'gold nanoparticles'], severity: 'high', reason: 'Nano material banned in EU', source: 'EU 2024' },

    // ========================
    // ADDITIONAL HARMFUL INGREDIENTS
    // ========================
    { name: 'mineral oil', aliases: ['paraffinum liquidum', 'petrolatum', 'petroleum jelly'], severity: 'medium', reason: 'May be contaminated with PAHs if not refined', source: 'EU requires purity' },
    { name: 'talc', aliases: ['talcum', 'magnesium silicate'], severity: 'medium', reason: 'Contamination risk with asbestos', source: 'FDA investigating' },
    { name: 'aluminum', aliases: ['aluminum chloride', 'aluminum chlorohydrate', 'aluminium'], severity: 'medium', reason: 'Potential links to breast cancer, Alzheimer\'s', source: 'Under study' },
    { name: 'petrolatum', aliases: ['petroleum jelly', 'white petrolatum', 'vaseline'], severity: 'medium', reason: 'Must be fully refined to remove carcinogens', source: 'EU' },
    { name: 'carbon black', aliases: ['ci 77266', 'd&c black no. 2'], severity: 'medium', reason: 'Potential carcinogen, restricted in EU', source: 'EU' },
    { name: 'titanium dioxide', aliases: ['ci 77891', 'tio2'], severity: 'medium', reason: 'Inhalation risk, restricted in sprays', source: 'EU 2022' },
];

/**
 * Seed all toxic ingredients to database
 */
async function seedToxicIngredients(sql) {
    console.log('[safetyAgent] Seeding toxic ingredients database...');
    let added = 0;
    let skipped = 0;

    for (const ingredient of TOXIC_INGREDIENTS_DATABASE) {
        try {
            // Check if already exists
            const existing = await sql`
        SELECT id FROM toxic_ingredients WHERE LOWER(name) = ${ingredient.name.toLowerCase()}
      `;

            if (existing.length === 0) {
                await sql`
          INSERT INTO toxic_ingredients (name, aliases, severity, reason, source)
          VALUES (
            ${ingredient.name.toLowerCase()},
            ${JSON.stringify(ingredient.aliases)},
            ${ingredient.severity},
            ${ingredient.reason},
            ${ingredient.source}
          )
        `;
                added++;
            } else {
                skipped++;
            }
        } catch (error) {
            console.error(`[safetyAgent] Error adding ${ingredient.name}:`, error.message);
        }
    }

    console.log(`[safetyAgent] Seeding complete: ${added} added, ${skipped} already existed`);
    return { added, skipped, total: TOXIC_INGREDIENTS_DATABASE.length };
}

/**
 * AI-powered ingredient analysis using Gemini
 */
async function aiAnalyzeIngredients(ingredients, productName = '') {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
        console.log('[safetyAgent] No Gemini API key, using database-only check');
        return { aiEnabled: false, concerns: [], safe: true };
    }

    try {
        const prompt = `You are a cosmetic safety expert. Analyze these ingredients for a skincare product and identify any safety concerns.

Product: ${productName || 'Unknown'}
Ingredients: ${ingredients}

Respond in JSON format only:
{
  "safe": true/false,
  "concerns": [
    {
      "ingredient": "ingredient name",
      "severity": "critical/high/medium/low",
      "reason": "brief explanation"
    }
  ],
  "warnings": ["any general warnings"],
  "recommendation": "brief recommendation"
}

Focus on:
1. Known toxic/banned ingredients (mercury, lead, formaldehyde, hydroquinone, etc.)
2. Hidden toxins with alternative names
3. Dangerous ingredient combinations
4. Ingredients banned by FDA, EU, or international regulations
5. High concentrations of restricted ingredients

Be strict about safety. If unsure, flag it.`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 1024,
                    }
                })
            }
        );

        if (!response.ok) {
            throw new Error(`Gemini API error: ${response.status}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return {
                aiEnabled: true,
                ...result
            };
        }

        return { aiEnabled: true, safe: true, concerns: [], warnings: [] };

    } catch (error) {
        console.error('[safetyAgent] AI analysis error:', error.message);
        return { aiEnabled: false, safe: true, concerns: [], error: error.message };
    }
}

/**
 * Deep scan with AI + database combined
 */
async function deepScanWithAI(productId, sql) {
    try {
        // Fetch product
        const products = await sql`
      SELECT id, name, ingredients, description, seller_id 
      FROM seller_products 
      WHERE id = ${productId}
    `;

        if (!products || products.length === 0) {
            return { error: 'Product not found', issues: [] };
        }

        const product = products[0];

        // 1. Database check
        const { immediateCheck } = require('./ingredientScanner');
        const dbResult = await immediateCheck(
            product.ingredients,
            product.name,
            product.description
        );

        // 2. AI analysis
        const aiResult = await aiAnalyzeIngredients(
            product.ingredients,
            product.name
        );

        // Combine results
        const allIssues = [...dbResult.flaggedIngredients];

        if (aiResult.concerns) {
            for (const concern of aiResult.concerns) {
                // Avoid duplicates
                if (!allIssues.find(i => i.name.toLowerCase() === concern.ingredient.toLowerCase())) {
                    allIssues.push({
                        name: concern.ingredient,
                        severity: concern.severity,
                        reason: concern.reason,
                        matchedIn: 'ai_analysis'
                    });
                }
            }
        }

        const isSafe = allIssues.length === 0;
        const highestSeverity = allIssues.reduce((max, issue) => {
            const order = { critical: 4, high: 3, medium: 2, low: 1 };
            return order[issue.severity] > order[max] ? issue.severity : max;
        }, 'none');

        return {
            productId,
            productName: product.name,
            sellerId: product.seller_id,
            safe: isSafe,
            severity: highestSeverity,
            issues: allIssues,
            aiWarnings: aiResult.warnings || [],
            recommendation: aiResult.recommendation || '',
            scannedAt: new Date().toISOString(),
            methods: {
                database: true,
                ai: aiResult.aiEnabled
            }
        };

    } catch (error) {
        console.error('[safetyAgent] deepScanWithAI error:', error);
        return { error: error.message, issues: [] };
    }
}

/**
 * Quick AI check for immediate validation
 */
async function quickAICheck(ingredients) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY || !ingredients || ingredients.length < 5) {
        return { checked: false, concerns: [] };
    }

    try {
        const prompt = `Quick safety check for cosmetic ingredients. List ONLY concerning ingredients in this list (toxic, banned, or dangerous):

${ingredients}

Respond with JSON only: {"concerns": ["ingredient1", "ingredient2"], "safe": true/false}
If all safe, return: {"concerns": [], "safe": true}`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 256 }
                })
            }
        );

        if (!response.ok) {
            return { checked: false, concerns: [] };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            return { checked: true, ...result };
        }

        return { checked: true, concerns: [], safe: true };

    } catch (error) {
        console.error('[safetyAgent] quickAICheck error:', error.message);
        return { checked: false, concerns: [] };
    }
}

module.exports = {
    TOXIC_INGREDIENTS_DATABASE,
    seedToxicIngredients,
    aiAnalyzeIngredients,
    deepScanWithAI,
    quickAICheck
};
