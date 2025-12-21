const fetch = require('node-fetch');

// OpenRouter-based AI provider with multi-model ensemble approach
// Uses free models from OpenRouter to provide collaborative skin analysis

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Free models available via OpenRouter
const FREE_MODELS = [
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'z-ai/glm-4.5-air:free',
  'moonshotai/kimi-k2:free'
];

// Default models to use for ensemble (pick 3 for balance of speed and accuracy)
const DEFAULT_ENSEMBLE_MODELS = [
  'moonshotai/kimi-k2:free',
  'openai/gpt-oss-120b:free',
  'z-ai/glm-4.5-air:free'
];

// Google Gemini API URL for fallback (using gemini-2.0-flash which is free)
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// External image analysis using Google Vision API (kept for reliable image processing)
async function analyzeImagesWithVision(images = []) {
  if (!images || images.length === 0) return null;
  const key = process.env.GOOGLE_VISION_API_KEY || process.env.VITE_GOOGLE_VISION_API_KEY;
  if (!key) {
    console.warn('Google Vision API key not configured - skipping image analysis');
    return null;
  }

  try {
    const requests = images.map(img => ({
      image: { content: img.data },
      features: [
        { type: 'LABEL_DETECTION', maxResults: 10 },
        { type: 'FACE_DETECTION', maxResults: 5 },
        { type: 'IMAGE_PROPERTIES', maxResults: 1 },
        { type: 'SAFE_SEARCH_DETECTION', maxResults: 1 }
      ]
    }));

    const body = { requests };
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await r.json();
    const results = (json.responses || []).map((resp, i) => ({
      filename: images[i]?.filename || `image_${i}`,
      labels: (resp.labelAnnotations || []).map(l => ({ description: l.description, score: l.score })),
      faces: (resp.faceAnnotations || []).map(f => ({ joyLikelihood: f.joyLikelihood, sorrowLikelihood: f.sorrowLikelihood, angerLikelihood: f.angerLikelihood, surpriseLikelihood: f.surpriseLikelihood })),
      imageProps: resp.imagePropertiesAnnotation || null,
      safeSearch: resp.safeSearchAnnotation || null,
      raw: resp
    }));
    return results;
  } catch (e) {
    console.warn('Vision API error:', e?.message || e);
    return null;
  }
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = text.substring(first, last + 1);
    try { return JSON.parse(candidate); } catch (e) { /* fallthrough */ }
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

// Fallback metrics generator - creates metrics when AI fails to return them
function generateFallbackMetrics(analysis) {
  const skinType = (analysis?.skinType || 'normal').toLowerCase();
  const concerns = (analysis?.concerns || []).map(c => (c || '').toLowerCase());

  // Base scores (70 = neutral/healthy baseline)
  let scores = {
    hydration: 70,
    elasticity: 75,
    texture: 72,
    clarity: 70,
    oilBalance: 70
  };

  // Adjust based on skin type
  switch (skinType) {
    case 'oily':
      scores.oilBalance -= 20;
      scores.hydration += 5;
      scores.clarity -= 10;
      break;
    case 'dry':
      scores.hydration -= 25;
      scores.oilBalance += 15;
      scores.texture -= 10;
      break;
    case 'combination':
      scores.oilBalance -= 10;
      scores.hydration -= 5;
      break;
    case 'sensitive':
      scores.clarity -= 15;
      scores.texture -= 10;
      scores.hydration -= 5;
      break;
  }

  // Adjust based on concerns
  concerns.forEach(concern => {
    if (concern.includes('acne') || concern.includes('breakout') || concern.includes('pimple')) {
      scores.clarity -= 15;
      scores.texture -= 8;
    }
    if (concern.includes('wrinkle') || concern.includes('aging') || concern.includes('fine line')) {
      scores.elasticity -= 20;
      scores.texture -= 5;
    }
    if (concern.includes('dehydr') || concern.includes('dry') || concern.includes('flak')) {
      scores.hydration -= 15;
    }
    if (concern.includes('oily') || concern.includes('sebum') || concern.includes('shiny')) {
      scores.oilBalance -= 15;
    }
    if (concern.includes('pigment') || concern.includes('dark spot') || concern.includes('uneven')) {
      scores.clarity -= 10;
    }
    if (concern.includes('pore') || concern.includes('blackhead')) {
      scores.texture -= 10;
      scores.clarity -= 5;
    }
    if (concern.includes('dull') || concern.includes('tired')) {
      scores.clarity -= 10;
      scores.hydration -= 5;
    }
    if (concern.includes('redness') || concern.includes('irritat')) {
      scores.clarity -= 10;
    }
  });

  // Clamp all scores to 25-90 range
  Object.keys(scores).forEach(k => {
    scores[k] = Math.max(25, Math.min(90, Math.round(scores[k])));
  });

  return [
    { name: 'Hydration', score: scores.hydration, icon: 'Droplet', description: `Your skin hydration level is ${scores.hydration >= 70 ? 'adequate' : 'needs improvement'}.` },
    { name: 'Elasticity', score: scores.elasticity, icon: 'Gauge', description: `Skin firmness is ${scores.elasticity >= 70 ? 'good' : 'showing signs of reduced elasticity'}.` },
    { name: 'Texture', score: scores.texture, icon: 'Layers', description: `Skin texture is ${scores.texture >= 70 ? 'smooth' : 'uneven in some areas'}.` },
    { name: 'Clarity', score: scores.clarity, icon: 'Sparkles', description: `Skin clarity is ${scores.clarity >= 70 ? 'clear' : 'affected by blemishes or unevenness'}.` },
    { name: 'Oil Balance', score: scores.oilBalance, icon: 'Sun', description: `Sebum production is ${scores.oilBalance >= 60 ? 'balanced' : 'needs regulation'}.` }
  ];
}

// Base OpenRouter API request function
async function openrouterRequest(model, messages, options = {}) {
  const key = process.env.OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
  if (!key) throw new Error('OpenRouter API key not configured (set OPENROUTER_API_KEY)');

  const body = {
    model: model,
    messages: messages,
    max_tokens: options.max_tokens || 800,
    temperature: options.temperature || 0.3
  };

  try {
    const r = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': process.env.FRONTEND_URL || 'https://glowimatch.vercel.app',
        'X-Title': 'GlowMatch Skin Analysis'
      },
      body: JSON.stringify(body)
    });

    const json = await r.json();

    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    const text = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
    return { text, raw: json, model };
  } catch (e) {
    throw new Error(`OpenRouter (${model}) error: ${e?.message || e}`);
  }
}

// Gemini API fallback for when OpenRouter rate limits are reached
async function geminiAnalyze(quizData, imageAnalysis, options = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('Gemini API key not configured (set GEMINI_API_KEY)');

  const imageSection = imageAnalysis ? `\n\nImage analysis results:\n${JSON.stringify(imageAnalysis, null, 2)}` : '';

  const prompt = `You are a dermatology-aware assistant. Analyze the following quiz responses and any provided image analysis and produce ONLY valid JSON with the keys:
- skinType: one of [oily,dry,combination,sensitive,normal]
- confidence: integer 0-100 representing confidence percentage
- concerns: array of short keyword strings (e.g. ["acne","pigmentation"])
- recommendations: array of short product or routine recommendation strings
- explanation: a short human-friendly analysis string

Quiz responses:
${JSON.stringify(quizData.responses || quizData, null, 2)}${imageSection}

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside the JSON.`;

  try {
    const url = `${GEMINI_API_URL}?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
      })
    });

    const json = await r.json();

    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = tryParseJsonFromText(text);

    if (parsed) {
      return {
        success: true,
        result: parsed,
        model: 'gemini-2.0-flash',
        provider: 'google-gemini'
      };
    }

    return {
      success: true,
      result: { explanation: text },
      model: 'gemini-2.0-flash',
      provider: 'google-gemini'
    };
  } catch (e) {
    console.warn('Gemini fallback failed:', e?.message || e);
    throw new Error(`Gemini fallback error: ${e?.message || e}`);
  }
}

// Gemini routine generation fallback
async function geminiGenerateRoutine(analysis, options = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('Gemini API key not configured (set GEMINI_API_KEY)');

  const prompt = `You are a professional dermatologist AI. Given the following skin analysis (JSON), generate a comprehensive skincare response.

SKIN ANALYSIS:
${JSON.stringify(analysis, null, 2)}

You MUST return ONLY valid JSON with these exact keys:

1. "routine": object with "morning" and "evening" arrays. Each step has: type (cleanser/toner/serum/moisturizer/sunscreen/treatment), name, description, timing, tips

2. "metrics": REQUIRED array of EXACTLY 5 skin health metrics. Calculate scores (0-100) based on the skin type and concerns:
   - For "${analysis?.skinType || 'normal'}" skin type and concerns like ${JSON.stringify(analysis?.concerns || [])}
   - Higher scores = healthier/better condition
   - Consider: acne lowers clarity, dryness lowers hydration, oily skin affects oil balance, aging affects elasticity
   
   Return these 5 metrics:
   [
     {"name": "Hydration", "score": <0-100>, "icon": "Droplet", "description": "<1 sentence about current hydration level>"},
     {"name": "Elasticity", "score": <0-100>, "icon": "Gauge", "description": "<1 sentence about skin firmness>"},
     {"name": "Texture", "score": <0-100>, "icon": "Layers", "description": "<1 sentence about skin smoothness>"},
     {"name": "Clarity", "score": <0-100>, "icon": "Sparkles", "description": "<1 sentence about skin clarity/blemishes>"},
     {"name": "Oil Balance", "score": <0-100>, "icon": "Sun", "description": "<1 sentence about sebum production>"}
   ]

3. "tips": array of 4 personalized skincare tips (strings)

4. "rationale": short explanation of the routine

IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, no explanation outside JSON.`;

  try {
    const url = `${GEMINI_API_URL}?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
      })
    });

    const json = await r.json();

    if (json.error) {
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = tryParseJsonFromText(text);

    if (parsed) {
      return {
        success: true,
        result: parsed,
        model: 'gemini-2.0-flash',
        provider: 'google-gemini'
      };
    }

    return {
      success: true,
      result: { rationale: text },
      model: 'gemini-2.0-flash',
      provider: 'google-gemini'
    };
  } catch (e) {
    console.warn('Gemini routine generation failed:', e?.message || e);
    throw new Error(`Gemini routine generation error: ${e?.message || e}`);
  }
}

// Single model skin analysis
async function analyzeWithModel(model, quizData, imageAnalysis, options = {}) {
  const imageSection = imageAnalysis ? `\n\nImage analysis results:\n${JSON.stringify(imageAnalysis, null, 2)}` : '';

  const prompt = `You are a dermatology-aware assistant. Analyze the following quiz responses and any provided image analysis and produce ONLY valid JSON with the keys:
- skinType: one of [oily,dry,combination,sensitive,normal]
- confidence: integer 0-100 representing confidence percentage
- concerns: array of short keyword strings (e.g. ["acne","pigmentation"])
- recommendations: array of short product or routine recommendation strings
- explanation: a short human-friendly analysis string

Quiz responses:
${JSON.stringify(quizData.responses || quizData, null, 2)}${imageSection}

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside the JSON.`;

  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await openrouterRequest(model, messages, { max_tokens: 600, temperature: 0.2 });
    const parsed = tryParseJsonFromText(response.text);

    if (parsed) {
      return {
        success: true,
        result: parsed,
        model,
        raw: response.raw
      };
    }

    return {
      success: true,
      result: { explanation: response.text },
      model,
      raw: response.raw
    };
  } catch (e) {
    console.warn(`Model ${model} failed:`, e?.message || e);
    return { success: false, error: e?.message || e, model };
  }
}

// Aggregate results from multiple models using ensemble approach
function aggregateResults(modelResults) {
  const successfulResults = modelResults.filter(r => r.success && r.result);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && r.error.includes('Rate limit exceeded')
  );

  if (successfulResults.length === 0) {
    if (rateLimitErrors.length === modelResults.length) {
      throw new Error('RATE_LIMIT: Daily free model limit reached. Please try again tomorrow or add credits at openrouter.ai');
    }
    throw new Error('All models failed to provide analysis');
  }

  // If only one model succeeded, return its result
  if (successfulResults.length === 1) {
    return {
      ...successfulResults[0].result,
      ensembleInfo: {
        modelsUsed: [successfulResults[0].model],
        totalModels: modelResults.length,
        successfulModels: 1
      }
    };
  }

  // Majority voting for skin type
  const skinTypeCounts = {};
  successfulResults.forEach(r => {
    const st = r.result.skinType?.toLowerCase();
    if (st) skinTypeCounts[st] = (skinTypeCounts[st] || 0) + 1;
  });
  const skinType = Object.entries(skinTypeCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'combination';

  // Average confidence
  const confidences = successfulResults
    .map(r => r.result.confidence)
    .filter(c => typeof c === 'number' && !isNaN(c));
  const confidence = confidences.length > 0
    ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
    : 70;

  // Union of concerns (deduplicated)
  const allConcerns = new Set();
  successfulResults.forEach(r => {
    if (Array.isArray(r.result.concerns)) {
      r.result.concerns.forEach(c => allConcerns.add(c.toLowerCase()));
    }
  });
  const concerns = Array.from(allConcerns);

  // Combine recommendations (deduplicated, max 8)
  const allRecommendations = new Set();
  successfulResults.forEach(r => {
    if (Array.isArray(r.result.recommendations)) {
      r.result.recommendations.forEach(rec => allRecommendations.add(rec));
    }
  });
  const recommendations = Array.from(allRecommendations).slice(0, 8);

  // Combine explanations
  const explanations = successfulResults
    .map(r => r.result.explanation)
    .filter(e => e && typeof e === 'string');
  const explanation = explanations.length > 0
    ? explanations[0] // Use the first explanation as primary
    : `Analysis based on ${successfulResults.length} AI models.`;

  return {
    skinType,
    confidence,
    concerns,
    recommendations,
    explanation,
    ensembleInfo: {
      modelsUsed: successfulResults.map(r => r.model),
      totalModels: modelResults.length,
      successfulModels: successfulResults.length,
      votingDetails: skinTypeCounts
    }
  };
}

// Main ensemble analysis function
async function ensembleAnalyze({ quizData, images = [], options = {} }) {
  // Get image analysis first (using Google Vision)
  const imageAnalysis = images && images.length ? await analyzeImagesWithVision(images) : null;

  // Select models for ensemble
  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS;

  console.log(`[Ensemble] Starting analysis with ${modelsToUse.length} models:`, modelsToUse);

  // Query all models in parallel
  const modelPromises = modelsToUse.map(model =>
    analyzeWithModel(model, quizData, imageAnalysis, options)
  );

  const modelResults = await Promise.all(modelPromises);

  // Log results summary
  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Ensemble] ${successCount}/${modelsToUse.length} models succeeded`);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && r.error.includes('Rate limit exceeded')
  );

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Ensemble] All models rate limited - trying Gemini fallback...');
    try {
      const geminiResult = await geminiAnalyze(quizData, imageAnalysis, options);
      if (geminiResult.success) {
        console.log('[Ensemble] Gemini fallback succeeded!');
        return {
          text: {
            ...geminiResult.result,
            ensembleInfo: {
              modelsUsed: ['gemini-2.0-flash (fallback)'],
              totalModels: modelsToUse.length + 1,
              successfulModels: 1,
              fallbackUsed: true
            }
          },
          provider: 'google-gemini-fallback',
          imageAnalysis,
          raw: { geminiResult }
        };
      }
    } catch (geminiError) {
      console.warn('[Ensemble] Gemini fallback also failed:', geminiError?.message);
      throw new Error('RATE_LIMIT: OpenRouter limit reached and Gemini fallback failed. Please try again later.');
    }
  }

  // Aggregate results normally
  const aggregated = aggregateResults(modelResults);

  return {
    text: aggregated,
    provider: 'openrouter-ensemble',
    imageAnalysis,
    raw: {
      modelResults: modelResults.map(r => ({
        model: r.model,
        success: r.success,
        error: r.error
      }))
    }
  };
}

// Legacy analyze function - now routes to ensemble
async function analyze({ provider = 'openrouter', quizData, images = [], options = {} }) {
  // Always use ensemble approach with OpenRouter
  return ensembleAnalyze({ quizData, images, options });
}

module.exports = { analyze };

// Generate routine using ensemble approach
async function generateRoutineWithModel(model, analysis, options = {}) {
  const prompt = `You are a professional dermatologist AI. Given the following skin analysis (JSON), generate a comprehensive skincare response.

SKIN ANALYSIS:
${JSON.stringify(analysis, null, 2)}

You MUST return ONLY valid JSON with these exact keys:

1. "routine": object with "morning" and "evening" arrays. Each step has: type (cleanser/toner/serum/moisturizer/sunscreen/treatment), name, description, timing, tips

2. "metrics": REQUIRED array of EXACTLY 5 skin health metrics. Calculate scores (0-100) based on the skin type and concerns:
   - For "${analysis?.skinType || 'normal'}" skin type and concerns like ${JSON.stringify(analysis?.concerns || [])}
   - Higher scores = healthier/better condition
   - Consider: acne lowers clarity, dryness lowers hydration, oily skin affects oil balance, aging affects elasticity
   
   Return these 5 metrics:
   [
     {"name": "Hydration", "score": <0-100>, "icon": "Droplet", "description": "<1 sentence about current hydration level>"},
     {"name": "Elasticity", "score": <0-100>, "icon": "Gauge", "description": "<1 sentence about skin firmness>"},
     {"name": "Texture", "score": <0-100>, "icon": "Layers", "description": "<1 sentence about skin smoothness>"},
     {"name": "Clarity", "score": <0-100>, "icon": "Sparkles", "description": "<1 sentence about skin clarity/blemishes>"},
     {"name": "Oil Balance", "score": <0-100>, "icon": "Sun", "description": "<1 sentence about sebum production>"}
   ]

3. "tips": array of 4 personalized skincare tips (strings)

4. "rationale": short explanation of the routine

IMPORTANT: Return ONLY valid JSON. No markdown, no code blocks, no explanation outside JSON.`;

  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await openrouterRequest(model, messages, { max_tokens: 1500, temperature: 0.3 });
    const parsed = tryParseJsonFromText(response.text);

    if (parsed) {
      return { success: true, result: parsed, model };
    }
    return { success: true, result: { rationale: response.text }, model };
  } catch (e) {
    console.warn(`Routine generation with ${model} failed:`, e?.message || e);
    return { success: false, error: e?.message || e, model };
  }
}

// Aggregate routine results
function aggregateRoutineResults(modelResults) {
  const successfulResults = modelResults.filter(r => r.success && r.result);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && r.error.includes('Rate limit exceeded')
  );

  if (successfulResults.length === 0) {
    if (rateLimitErrors.length === modelResults.length) {
      throw new Error('RATE_LIMIT: Daily free model limit reached. Please try again tomorrow or add credits at openrouter.ai');
    }
    throw new Error('All models failed to generate routine');
  }

  // Use the most complete result (one with the most keys)
  const bestResult = successfulResults.reduce((best, current) => {
    const currentKeys = Object.keys(current.result || {}).length;
    const bestKeys = Object.keys(best.result || {}).length;
    return currentKeys > bestKeys ? current : best;
  }, successfulResults[0]);

  return {
    ...bestResult.result,
    ensembleInfo: {
      modelsUsed: successfulResults.map(r => r.model),
      primaryModel: bestResult.model
    }
  };
}

async function generateRoutine({ provider = 'openrouter', analysis, options = {} }) {
  if (!analysis) throw new Error('analysis required');

  // Use 2 models for routine generation (faster, less critical than analysis)
  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS.slice(0, 2);

  console.log(`[Ensemble] Generating routine with ${modelsToUse.length} models:`, modelsToUse);

  const modelPromises = modelsToUse.map(model =>
    generateRoutineWithModel(model, analysis, options)
  );

  const modelResults = await Promise.all(modelPromises);

  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Ensemble] Routine generation: ${successCount}/${modelsToUse.length} models succeeded`);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && r.error.includes('Rate limit exceeded')
  );

  // Helper to ensure metrics are present
  const ensureMetrics = (result) => {
    if (!result.metrics || !Array.isArray(result.metrics) || result.metrics.length === 0) {
      console.log('[Ensemble] AI did not return metrics, generating fallback metrics');
      result.metrics = generateFallbackMetrics(analysis);
      result.metricsSource = 'fallback';
    }
    return result;
  };

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Ensemble] All routine models rate limited - trying Gemini fallback...');
    try {
      const geminiResult = await geminiGenerateRoutine(analysis, options);
      if (geminiResult.success) {
        console.log('[Ensemble] Gemini routine fallback succeeded!');
        const resultWithMetrics = ensureMetrics({ ...geminiResult.result });
        return {
          text: {
            ...resultWithMetrics,
            ensembleInfo: {
              modelsUsed: ['gemini-2.0-flash (fallback)'],
              primaryModel: 'gemini-2.0-flash',
              fallbackUsed: true
            }
          },
          provider: 'google-gemini-fallback',
          raw: { geminiResult }
        };
      }
    } catch (geminiError) {
      console.warn('[Ensemble] Gemini routine fallback also failed:', geminiError?.message);
      throw new Error('RATE_LIMIT: OpenRouter limit reached and Gemini fallback failed. Please try again later.');
    }
  }

  const aggregated = aggregateRoutineResults(modelResults);

  // Ensure metrics are always present
  const finalResult = ensureMetrics(aggregated);

  return {
    text: finalResult,
    provider: 'openrouter-ensemble',
    raw: {
      modelResults: modelResults.map(r => ({
        model: r.model,
        success: r.success,
        error: r.error
      }))
    }
  };
}

module.exports.generateRoutine = generateRoutine;

// ============================================
// AI Product Voting System
// ============================================

// Single model product voting
async function voteOnProductsWithModel(model, analysis, products, options = {}) {
  // Create a simplified product list for the AI
  const productList = products.map((p, idx) => ({
    idx: idx,
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    description: p.description?.substring(0, 100) || '',
    skinTypes: p.skin_types || [],
    concerns: p.concerns || []
  }));

  const prompt = `You are a dermatology expert. Based on the user's skin analysis, vote for the BEST matching products.

USER SKIN ANALYSIS:
- Skin Type: ${analysis.skinType || 'unknown'}
- Concerns: ${JSON.stringify(analysis.concerns || [])}
- Confidence: ${analysis.confidence || 0}%
${analysis.explanation ? `- Details: ${analysis.explanation}` : ''}

AVAILABLE PRODUCTS:
${JSON.stringify(productList, null, 2)}

TASK: Select the TOP 5 products that best match this user's skin needs.

Return ONLY valid JSON with this exact format:
{
  "votes": [
    {"productId": "id1", "score": 10, "reason": "short reason"},
    {"productId": "id2", "score": 9, "reason": "short reason"},
    {"productId": "id3", "score": 8, "reason": "short reason"},
    {"productId": "id4", "score": 7, "reason": "short reason"},
    {"productId": "id5", "score": 6, "reason": "short reason"}
  ]
}

SCORING: 10 = perfect match, 1 = poor match. Only include products you recommend.
IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside JSON.`;

  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await openrouterRequest(model, messages, { max_tokens: 500, temperature: 0.2 });
    const parsed = tryParseJsonFromText(response.text);

    if (parsed && Array.isArray(parsed.votes)) {
      return {
        success: true,
        votes: parsed.votes,
        model,
        raw: response.raw
      };
    }

    console.warn(`[Vote] Model ${model} returned invalid format`);
    return { success: false, error: 'Invalid response format', model };
  } catch (e) {
    console.warn(`[Vote] Model ${model} failed:`, e?.message || e);
    return { success: false, error: e?.message || e, model };
  }
}

// Gemini fallback for product voting
async function geminiVoteOnProducts(analysis, products, options = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('Gemini API key not configured');

  const productList = products.map((p, idx) => ({
    idx: idx,
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: p.category,
    description: p.description?.substring(0, 100) || '',
    skinTypes: p.skin_types || [],
    concerns: p.concerns || []
  }));

  const prompt = `You are a dermatology expert. Based on the user's skin analysis, vote for the BEST matching products.

USER SKIN ANALYSIS:
- Skin Type: ${analysis.skinType || 'unknown'}
- Concerns: ${JSON.stringify(analysis.concerns || [])}
- Confidence: ${analysis.confidence || 0}%
${analysis.explanation ? `- Details: ${analysis.explanation}` : ''}

AVAILABLE PRODUCTS:
${JSON.stringify(productList, null, 2)}

TASK: Select the TOP 5 products that best match this user's skin needs.

Return ONLY valid JSON with this exact format:
{
  "votes": [
    {"productId": "id1", "score": 10, "reason": "short reason"},
    {"productId": "id2", "score": 9, "reason": "short reason"},
    {"productId": "id3", "score": 8, "reason": "short reason"},
    {"productId": "id4", "score": 7, "reason": "short reason"},
    {"productId": "id5", "score": 6, "reason": "short reason"}
  ]
}

SCORING: 10 = perfect match, 1 = poor match. Only include products you recommend.
IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside JSON.`;

  try {
    const url = `${GEMINI_API_URL}?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 }
      })
    });

    const json = await r.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = tryParseJsonFromText(text);

    if (parsed && Array.isArray(parsed.votes)) {
      return { success: true, votes: parsed.votes, model: 'gemini-2.0-flash' };
    }

    return { success: false, error: 'Invalid response format', model: 'gemini-2.0-flash' };
  } catch (e) {
    console.warn('[Vote] Gemini fallback failed:', e?.message || e);
    return { success: false, error: e?.message || e, model: 'gemini-2.0-flash' };
  }
}

// Aggregate votes from multiple models
function aggregateProductVotes(modelResults, products) {
  const successfulResults = modelResults.filter(r => r.success && Array.isArray(r.votes));

  if (successfulResults.length === 0) {
    console.warn('[Vote] No successful model results');
    return { rankedProducts: products, votingInfo: { success: false } };
  }

  // Create a map to track votes for each product
  const productVotes = {};
  products.forEach(p => {
    productVotes[p.id] = {
      totalScore: 0,
      voteCount: 0,
      reasons: [],
      models: []
    };
  });

  // Aggregate votes from all models
  successfulResults.forEach(result => {
    result.votes.forEach(vote => {
      const pid = vote.productId;
      if (productVotes[pid]) {
        productVotes[pid].totalScore += (vote.score || 0);
        productVotes[pid].voteCount += 1;
        if (vote.reason) productVotes[pid].reasons.push(vote.reason);
        productVotes[pid].models.push(result.model);
      }
    });
  });

  // Calculate final scores and rank products
  const rankedProducts = products.map(p => {
    const votes = productVotes[p.id];
    const avgScore = votes.voteCount > 0 ? votes.totalScore / votes.voteCount : 0;
    const weightedScore = avgScore * (1 + (votes.voteCount / successfulResults.length) * 0.5);

    return {
      ...p,
      aiVoting: {
        totalScore: Math.round(votes.totalScore * 10) / 10,
        voteCount: votes.voteCount,
        avgScore: Math.round(avgScore * 10) / 10,
        weightedScore: Math.round(weightedScore * 10) / 10,
        reasons: votes.reasons.slice(0, 3),
        recommendedBy: votes.models.length
      }
    };
  });

  // Sort by weighted score (highest first)
  rankedProducts.sort((a, b) => b.aiVoting.weightedScore - a.aiVoting.weightedScore);

  return {
    rankedProducts,
    votingInfo: {
      success: true,
      modelsUsed: successfulResults.map(r => r.model),
      totalModels: modelResults.length,
      successfulModels: successfulResults.length
    }
  };
}

// Main function: Vote on products using ensemble approach
async function voteOnProducts({ analysis, products, options = {} }) {
  if (!analysis || !products || products.length === 0) {
    return { rankedProducts: products || [], votingInfo: { success: false, error: 'Missing data' } };
  }

  // Limit products to avoid token limits (max 30 products)
  const limitedProducts = products.slice(0, 30);

  // Use 2 models for faster voting
  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS.slice(0, 2);

  console.log(`[Vote] Starting product voting with ${modelsToUse.length} models for ${limitedProducts.length} products`);

  // Query all models in parallel
  const modelPromises = modelsToUse.map(model =>
    voteOnProductsWithModel(model, analysis, limitedProducts, options)
  );

  const modelResults = await Promise.all(modelPromises);

  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Vote] ${successCount}/${modelsToUse.length} models succeeded`);

  // Check for rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && r.error.includes('Rate limit exceeded')
  );

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Vote] All models rate limited - trying Gemini fallback...');
    const geminiResult = await geminiVoteOnProducts(analysis, limitedProducts, options);
    if (geminiResult.success) {
      console.log('[Vote] Gemini fallback succeeded!');
      const result = aggregateProductVotes([geminiResult], limitedProducts);
      result.votingInfo.fallbackUsed = true;
      return result;
    }
  }

  // Aggregate results
  return aggregateProductVotes(modelResults, limitedProducts);
}

module.exports.voteOnProducts = voteOnProducts;

// Export available models for frontend selection
module.exports.FREE_MODELS = FREE_MODELS;
module.exports.DEFAULT_ENSEMBLE_MODELS = DEFAULT_ENSEMBLE_MODELS;
