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

  const prompt = `You are a dermatology-aware assistant. Given the following analysis object (JSON), generate ONLY valid JSON with these keys:
- routine: an object with 'morning' and 'evening' arrays. Each array contains ordered steps objects with keys: type (cleanser/toner/serum/moisturizer/sunscreen/treatment), name, description, timing (short), tips (short).
- metrics: array of metric objects { name, score (0-100), icon (short name), description } derived from the analysis concerns and explanation.
- tips: short array of prioritized tips (strings).
- rationale: short string explaining why this routine was suggested.

Provide outputs targeted to the following analysis:
${JSON.stringify(analysis, null, 2)}

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside the JSON.`;

  try {
    const url = `${GEMINI_API_URL}?key=${encodeURIComponent(key)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1000 }
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
  const prompt = `You are a dermatology-aware assistant. Given the following analysis object (JSON), generate ONLY valid JSON with these keys:
- routine: an object with 'morning' and 'evening' arrays. Each array contains ordered steps objects with keys: type (cleanser/toner/serum/moisturizer/sunscreen/treatment), name, description, timing (short), tips (short).
- metrics: array of metric objects { name, score (0-100), icon (short name), description } derived from the analysis concerns and explanation.
- tips: short array of prioritized tips (strings).
- rationale: short string explaining why this routine was suggested.

Provide outputs targeted to the following analysis:
${JSON.stringify(analysis, null, 2)}

IMPORTANT: Return ONLY valid JSON, no markdown, no explanation outside the JSON.`;

  const messages = [{ role: 'user', content: prompt }];

  try {
    const response = await openrouterRequest(model, messages, { max_tokens: 1000, temperature: 0.3 });
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

  // If all models failed due to rate limit, try Gemini fallback
  if (successCount === 0 && rateLimitErrors.length === modelResults.length) {
    console.log('[Ensemble] All routine models rate limited - trying Gemini fallback...');
    try {
      const geminiResult = await geminiGenerateRoutine(analysis, options);
      if (geminiResult.success) {
        console.log('[Ensemble] Gemini routine fallback succeeded!');
        return {
          text: {
            ...geminiResult.result,
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

  return {
    text: aggregated,
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

// Export available models for frontend selection
module.exports.FREE_MODELS = FREE_MODELS;
module.exports.DEFAULT_ENSEMBLE_MODELS = DEFAULT_ENSEMBLE_MODELS;
