const fetch = require('node-fetch');

// Groq-based AI provider with multi-model ensemble approach
// Uses Groq API for fast skin analysis with Llama models

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Image analysis model (supports vision/multimodal)
const IMAGE_ANALYSIS_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// Ensemble models for quiz analysis and voting (Groq model names)
const DEFAULT_ENSEMBLE_MODELS = [
  'llama-3.3-70b-versatile',
  'qwen-qwq-32b',
  'llama-3.1-8b-instant'
];

// Google Gemini API URL for fallback (backup only)
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

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

// Base Groq API request function
async function groqRequest(model, messages, options = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('Groq API key not configured (set GROQ_API_KEY)');

  const body = {
    model: model,
    messages: messages,
    max_tokens: options.max_tokens || 1024,
    temperature: options.temperature || 0.3
  };

  try {
    const r = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
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
    throw new Error(`Groq (${model}) error: ${e?.message || e}`);
  }
}

// Image analysis using Llama 4 Scout via Groq (multimodal)
async function analyzeImagesWithGroq(images = []) {
  if (!images || images.length === 0) return null;

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.warn('Groq API key not configured - skipping image analysis');
    return null;
  }

  try {
    // Prepare image content for multimodal analysis
    const imageContents = images.map(img => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${img.data}`
      }
    }));

    const messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Analyze this skin image for a skincare assessment. Identify:
1. Visible skin concerns (acne, wrinkles, pigmentation, redness, dryness, oiliness, pores, etc.)
2. Estimated skin type (oily, dry, combination, sensitive, normal)
3. Skin texture and clarity observations
4. Any other notable skin characteristics

Return ONLY valid JSON with keys:
- skinType: one of [oily,dry,combination,sensitive,normal]
- concerns: array of identified concern strings
- texture: description of skin texture
- clarity: description of skin clarity
- observations: array of other notable observations
- confidence: 0-100 confidence score

IMPORTANT: Return ONLY valid JSON, no markdown.`
          },
          ...imageContents
        ]
      }
    ];

    const r = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: IMAGE_ANALYSIS_MODEL,
        messages: messages,
        max_tokens: 800,
        temperature: 0.2
      })
    });

    const json = await r.json();

    if (json.error) {
      console.warn('Groq Vision error:', json.error);
      return null;
    }

    const text = json?.choices?.[0]?.message?.content || '';
    const parsed = tryParseJsonFromText(text);

    if (parsed) {
      return [{
        filename: images[0]?.filename || 'image_0',
        analysis: parsed,
        skinType: parsed.skinType,
        concerns: parsed.concerns || [],
        raw: json
      }];
    }

    return [{
      filename: images[0]?.filename || 'image_0',
      analysis: { explanation: text },
      raw: json
    }];
  } catch (e) {
    console.warn('Groq Vision error:', e?.message || e);
    return null;
  }
}

// Gemini API fallback for when Groq rate limits are reached
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

// Single model skin analysis via Groq
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
    const response = await groqRequest(model, messages, { max_tokens: 600, temperature: 0.2 });
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
    !r.success && r.error && (r.error.includes('Rate limit') || r.error.includes('rate_limit'))
  );

  if (successfulResults.length === 0) {
    if (rateLimitErrors.length === modelResults.length) {
      throw new Error('RATE_LIMIT: Groq rate limit reached. Please try again in a moment.');
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
  // Get image analysis first using Groq's Llama 4 Scout
  const imageAnalysis = images && images.length ? await analyzeImagesWithGroq(images) : null;

  // Select models for ensemble
  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS;

  console.log(`[Groq Ensemble] Starting analysis with ${modelsToUse.length} models:`, modelsToUse);

  // Query all models in parallel
  const modelPromises = modelsToUse.map(model =>
    analyzeWithModel(model, quizData, imageAnalysis, options)
  );

  const modelResults = await Promise.all(modelPromises);

  // Log results summary
  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Groq Ensemble] ${successCount}/${modelsToUse.length} models succeeded`);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && (r.error.includes('Rate limit') || r.error.includes('rate_limit'))
  );

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Groq Ensemble] All models rate limited - trying Gemini fallback...');
    try {
      const geminiResult = await geminiAnalyze(quizData, imageAnalysis, options);
      if (geminiResult.success) {
        console.log('[Groq Ensemble] Gemini fallback succeeded!');
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
      console.warn('[Groq Ensemble] Gemini fallback also failed:', geminiError?.message);
      throw new Error('RATE_LIMIT: Groq limit reached and Gemini fallback failed. Please try again later.');
    }
  }

  // Aggregate results normally
  const aggregated = aggregateResults(modelResults);

  return {
    text: aggregated,
    provider: 'groq-ensemble',
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
async function analyze({ provider = 'groq', quizData, images = [], options = {} }) {
  // Always use ensemble approach with Groq
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
    const response = await groqRequest(model, messages, { max_tokens: 1500, temperature: 0.3 });
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
    !r.success && r.error && (r.error.includes('Rate limit') || r.error.includes('rate_limit'))
  );

  if (successfulResults.length === 0) {
    if (rateLimitErrors.length === modelResults.length) {
      throw new Error('RATE_LIMIT: Groq rate limit reached. Please try again in a moment.');
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

async function generateRoutine({ provider = 'groq', analysis, options = {} }) {
  if (!analysis) throw new Error('analysis required');

  // Use 2 models for routine generation (faster, less critical than analysis)
  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS.slice(0, 2);

  console.log(`[Groq Ensemble] Generating routine with ${modelsToUse.length} models:`, modelsToUse);

  const modelPromises = modelsToUse.map(model =>
    generateRoutineWithModel(model, analysis, options)
  );

  const modelResults = await Promise.all(modelPromises);

  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Groq Ensemble] Routine generation: ${successCount}/${modelsToUse.length} models succeeded`);

  // Check if all failures are due to rate limiting
  const rateLimitErrors = modelResults.filter(r =>
    !r.success && r.error && (r.error.includes('Rate limit') || r.error.includes('rate_limit'))
  );

  // Helper to ensure metrics are present
  const ensureMetrics = (result) => {
    if (!result.metrics || !Array.isArray(result.metrics) || result.metrics.length === 0) {
      console.log('[Groq Ensemble] AI did not return metrics, generating fallback metrics');
      result.metrics = generateFallbackMetrics(analysis);
      result.metricsSource = 'fallback';
    }
    return result;
  };

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Groq Ensemble] All routine models rate limited - trying Gemini fallback...');
    try {
      const geminiResult = await geminiGenerateRoutine(analysis, options);
      if (geminiResult.success) {
        console.log('[Groq Ensemble] Gemini routine fallback succeeded!');
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
      console.warn('[Groq Ensemble] Gemini routine fallback also failed:', geminiError?.message);
      throw new Error('RATE_LIMIT: Groq limit reached and Gemini fallback failed. Please try again later.');
    }
  }

  const aggregated = aggregateRoutineResults(modelResults);

  // Ensure metrics are always present
  const finalResult = ensureMetrics(aggregated);

  return {
    text: finalResult,
    provider: 'groq-ensemble',
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

// Single model product voting via Groq
async function voteOnProductsWithModel(model, analysis, products, options = {}) {
  // Create a simplified product list for the AI - NO idx to avoid confusion!
  const productList = products.map(p => ({
    id: p.id,  // This is the UUID - models MUST use this exact value
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

AVAILABLE PRODUCTS (each has a unique UUID as "id"):
${JSON.stringify(productList, null, 2)}

TASK: Select the TOP 5 products that best match this user's skin needs.

⚠️ CRITICAL RULES:
1. You MUST use the EXACT "id" value (UUID format like "3f634308-829a-46bc-9784-81c68578fb32") for productId
2. Do NOT use simple numbers like "1", "2", "14" - only use the full UUID from the "id" field
3. Copy the UUID exactly as shown in the product list

Return ONLY valid JSON with this exact format:
{
  "votes": [
    {"productId": "paste-exact-uuid-here", "score": 10, "reason": "short reason"},
    {"productId": "paste-exact-uuid-here", "score": 9, "reason": "short reason"},
    {"productId": "paste-exact-uuid-here", "score": 8, "reason": "short reason"},
    {"productId": "paste-exact-uuid-here", "score": 7, "reason": "short reason"},
    {"productId": "paste-exact-uuid-here", "score": 6, "reason": "short reason"}
  ]
}

SCORING: 10 = perfect match, 1 = poor match.
IMPORTANT: Return ONLY valid JSON. Use EXACT UUIDs from the product list.`;

  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await groqRequest(model, messages, { max_tokens: 800, temperature: 0.2 });
    console.log(`[Vote] Model ${model} raw response:`, response.text?.substring(0, 200));

    const parsed = tryParseJsonFromText(response.text);
    console.log(`[Vote] Model ${model} parsed:`, JSON.stringify(parsed)?.substring(0, 300));

    // Handle different response formats
    let votes = [];
    if (parsed) {
      if (Array.isArray(parsed.votes)) {
        votes = parsed.votes;
      } else if (Array.isArray(parsed.recommendations)) {
        // Some models return recommendations instead of votes
        votes = parsed.recommendations.map((rec, idx) => ({
          productId: rec.productId || rec.id || rec.product_id,
          score: rec.score || (10 - idx),
          reason: rec.reason || rec.explanation || ''
        }));
      } else if (Array.isArray(parsed)) {
        // Model returned array directly
        votes = parsed.map((item, idx) => ({
          productId: item.productId || item.id || item.product_id,
          score: item.score || (10 - idx),
          reason: item.reason || ''
        }));
      }
    }

    // Filter out invalid votes (must have productId)
    votes = votes.filter(v => v && v.productId);
    console.log(`[Vote] Model ${model} extracted ${votes.length} votes`);

    if (votes.length > 0) {
      return {
        success: true,
        votes: votes,
        model,
        raw: response.raw
      };
    }

    console.warn(`[Vote] Model ${model} returned no valid votes from response`);
    return { success: false, error: 'No valid votes in response', model };
  } catch (e) {
    console.warn(`[Vote] Model ${model} failed:`, e?.message || e);
    return { success: false, error: e?.message || e, model };
  }
}

// Aggregate votes from multiple models
function aggregateVotes(modelResults, products) {
  const successfulResults = modelResults.filter(r => r.success && r.votes && r.votes.length > 0);

  console.log(`[Vote] Aggregating: ${successfulResults.length} successful results with votes`);

  if (successfulResults.length === 0) {
    console.warn('[Vote] No successful results with votes');
    return [];
  }

  // Create a map of product IDs for validation
  const validProductIds = new Set(products.map(p => p.id));
  console.log(`[Vote] Valid product IDs count: ${validProductIds.size}`);

  // Aggregate scores per product
  const productScores = {};
  const productReasons = {};
  let matchedVotes = 0;
  let unmatchedVotes = 0;

  successfulResults.forEach(result => {
    result.votes.forEach(vote => {
      const pid = vote.productId;

      // Check if this productId exists in our products
      if (!validProductIds.has(pid)) {
        unmatchedVotes++;
        return; // Skip invalid product IDs
      }

      matchedVotes++;
      if (!productScores[pid]) {
        productScores[pid] = [];
        productReasons[pid] = [];
      }
      productScores[pid].push(vote.score || 5);
      if (vote.reason) productReasons[pid].push(vote.reason);
    });
  });

  console.log(`[Vote] Matched votes: ${matchedVotes}, Unmatched: ${unmatchedVotes}`);

  // Calculate average scores and sort
  const aggregatedVotes = Object.entries(productScores)
    .map(([productId, scores]) => ({
      productId,
      averageScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      voteCount: scores.length,
      reasons: productReasons[productId] || []
    }))
    .sort((a, b) => b.averageScore - a.averageScore)
    .slice(0, 10);

  console.log(`[Vote] Final aggregated votes: ${aggregatedVotes.length}`);
  return aggregatedVotes;
}

// Main product voting function
async function voteOnProducts({ analysis, products, options = {} }) {
  if (!analysis || !products || products.length === 0) {
    console.warn('[Vote] Missing analysis or products');
    return {
      rankedProducts: [],
      votingInfo: { success: false, error: 'Missing analysis or products' }
    };
  }

  const modelsToUse = options.models || DEFAULT_ENSEMBLE_MODELS.slice(0, 2);

  console.log(`[Groq Vote] Voting with ${modelsToUse.length} models on ${products.length} products`);

  const modelPromises = modelsToUse.map(model =>
    voteOnProductsWithModel(model, analysis, products, options)
  );

  const modelResults = await Promise.all(modelPromises);

  const successCount = modelResults.filter(r => r.success).length;
  console.log(`[Groq Vote] ${successCount}/${modelsToUse.length} models voted successfully`);

  const aggregatedVotes = aggregateVotes(modelResults, products);

  // Map aggregated votes back to full product objects with AI scores
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  const rankedProducts = aggregatedVotes
    .filter(vote => productMap[vote.productId])
    .map(vote => ({
      ...productMap[vote.productId],
      aiScore: vote.averageScore,
      aiVoteCount: vote.voteCount,
      aiReasons: vote.reasons
    }));

  // If no AI votes, return products sorted by view_count as fallback
  if (rankedProducts.length === 0) {
    console.log('[Vote] No AI votes, using view_count fallback');
    const fallbackProducts = [...products]
      .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
      .slice(0, 10);

    return {
      rankedProducts: fallbackProducts,
      votingInfo: {
        success: false,
        fallback: true,
        modelsUsed: modelsToUse,
        successCount: 0,
        error: 'No valid AI votes received'
      }
    };
  }

  return {
    rankedProducts,
    votingInfo: {
      success: true,
      modelsUsed: modelsToUse,
      successCount,
      totalVotes: aggregatedVotes.length
    }
  };
}

module.exports.voteOnProducts = voteOnProducts;

