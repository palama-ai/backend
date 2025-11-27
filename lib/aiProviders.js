const fetch = require('node-fetch');

// External-only image analysis provider.
// This implementation relies on external Vision + LLM providers (OpenAI, Gemini, Anthropic).
// If the required API keys are not configured the functions will throw an error so
// failures are visible and the deployment is configured correctly.

async function analyzeImagesWithVision(images = []) {
  if (!images || images.length === 0) return null;
  const key = process.env.GOOGLE_VISION_API_KEY || process.env.VITE_GOOGLE_VISION_API_KEY;
  if (!key) throw new Error('Google Vision API key not configured (set GOOGLE_VISION_API_KEY)');

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
    throw new Error('Vision API error: ' + (e?.message || e));
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

async function openaiAnalyze({ quizData, images, options }) {
  const key = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API key not configured (set OPENAI_API_KEY)');

  const imageAnalysis = images && images.length ? await analyzeImagesWithVision(images) : null;
  const imageFeatures = null; // leave LLM to reason over imageAnalysis directly

  const imageSection = imageAnalysis ? `\n\nImage analysis results:\n${JSON.stringify(imageAnalysis, null, 2)}` : '';
  const prompt = `You are a dermatology-aware assistant. Analyze the following quiz responses and any provided image analysis and produce ONLY valid JSON with the keys:\n- skinType: one of [oily,dry,combination,sensitive,normal]\n- confidence: integer 0-100 representing confidence percentage\n- concerns: array of short keyword strings (e.g. ["acne","pigmentation"])\n- recommendations: array of short product or routine recommendation strings\n- explanation: a short human-friendly analysis string\n\nQuiz responses:\n${JSON.stringify(quizData.responses || quizData, null, 2)}${imageSection}`;

  const body = { model: options?.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0.2 };
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || JSON.stringify(json);
  const parsed = tryParseJsonFromText(text);
  if (parsed) return { text: parsed, provider: 'openai', raw: json, imageAnalysis };
  return { text: { explanation: text }, provider: 'openai', raw: json, imageAnalysis };
}

async function geminiAnalyze({ quizData, images, options }) {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('Gemini API key not configured (set GEMINI_API_KEY)');
  const imageAnalysis = images && images.length ? await analyzeImagesWithVision(images) : null;
  const prompt = `Analyze the user's quiz responses and any attached images and produce a JSON object with fields: skinType (oily/dry/combination/sensitive/normal), confidence (0-100), concerns (array of keywords), recommendations (array of strings), explanation (string). Return ONLY valid JSON. Responses: ${JSON.stringify(quizData.responses || quizData)}\n\nImage analysis:\n${JSON.stringify(imageAnalysis || [], null, 2)}`;
  try {
    const r = await fetch('https://gemini.googleapis.com/v1beta3/models/gemini-text:predict', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ prompt }) });
    const json = await r.json();
    const text = json?.output?.[0]?.content || JSON.stringify(json);
    const parsed = tryParseJsonFromText(text);
    if (parsed) return { text: parsed, provider: 'gemini', raw: json, imageAnalysis };
    return { text: { explanation: text }, provider: 'gemini', raw: json, imageAnalysis };
  } catch (e) {
    throw new Error('Gemini API error: ' + (e?.message || e));
  }
}

async function cloudAnalyze({ quizData, images, options }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key not configured (set ANTHROPIC_API_KEY)');
  const imageAnalysis = images && images.length ? await analyzeImagesWithVision(images) : null;
  const prompt = `Provide a JSON object with fields: skinType (oily/dry/combination/sensitive/normal), confidence (0-100), concerns (array), recommendations (array), explanation (string). Return ONLY valid JSON. Responses: ${JSON.stringify(quizData.responses || quizData)}\n\nImage analysis:\n${JSON.stringify(imageAnalysis || [], null, 2)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: options?.model || 'claude-2.1', prompt, max_tokens: 500 }) });
    const json = await r.json();
    const text = json?.completion || JSON.stringify(json);
    const parsed = tryParseJsonFromText(text);
    if (parsed) return { text: parsed, provider: 'cloud', raw: json, imageAnalysis };
    return { text: { explanation: text }, provider: 'cloud', raw: json, imageAnalysis };
  } catch (e) {
    throw new Error('Anthropic API error: ' + (e?.message || e));
  }
}

async function analyze({ provider = 'openai', quizData, images = [], options = {} }) {
  // Route to the requested provider. Errors are thrown if API keys are not present.
  if (provider === 'openai') return openaiAnalyze({ quizData, images, options });
  if (provider === 'gemini') return geminiAnalyze({ quizData, images, options });
  if (provider === 'cloud') return cloudAnalyze({ quizData, images, options });
  // Unknown provider: try openai, else gemini, else cloud
  try { return await openaiAnalyze({ quizData, images, options }); } catch (e) {}
  try { return await geminiAnalyze({ quizData, images, options }); } catch (e) {}
  return await cloudAnalyze({ quizData, images, options });
}

module.exports = { analyze };

// Generate a detailed routine and expanded metrics from an existing analysis object
async function openaiGenerateRoutine({ analysis, options }) {
  const key = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI API key not configured (set OPENAI_API_KEY)');

  const prompt = `You are a dermatology-aware assistant. Given the following analysis object (JSON), generate ONLY valid JSON with these keys:\n- routine: an object with 'morning' and 'evening' arrays. Each array contains ordered steps objects with keys: type (cleanser/toner/serum/moisturizer/sunscreen/treatment), name, description, timing (short), tips (short).\n- metrics: array of metric objects { name, score (0-100), icon (short name), description } derived from the analysis concerns and explanation.\n- tips: short array of prioritized tips (strings).\n- rationale: short string explaining why this routine was suggested.\n\nProvide outputs targeted to the following analysis:\n${JSON.stringify(analysis, null, 2)}`;

  const body = { model: options?.model || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 900, temperature: 0.2 };
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || JSON.stringify(json);
  const parsed = tryParseJsonFromText(text);
  if (parsed) return { text: parsed, provider: 'openai', raw: json };
  return { text: { rationale: text }, provider: 'openai', raw: json };
}

async function geminiGenerateRoutine({ analysis, options }) {
  const key = process.env.GEMINI_API_KEY || process.env.VITE_GEMINI_API_KEY;
  if (!key) throw new Error('Gemini API key not configured (set GEMINI_API_KEY)');
  const prompt = `Given this analysis JSON, produce ONLY valid JSON with keys: routine {morning, evening}, metrics, tips, rationale. Analysis: ${JSON.stringify(analysis)} `;
  try {
    const r = await fetch('https://gemini.googleapis.com/v1beta3/models/gemini-text:predict', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ prompt }) });
    const status = r.status;
    const text = await r.text();
    // Try to extract JSON from text output (Gemini sometimes returns non-JSON wrappers)
    const parsed = tryParseJsonFromText(text);
    if (parsed) return { text: parsed, provider: 'gemini', raw: { status, body: text } };
    // If response looks like HTML or non-json, include raw text for debugging
    return { text: { rationale: text }, provider: 'gemini', raw: { status, body: text } };
  } catch (e) {
    // Bubble up a helpful error
    throw new Error('Gemini generation error: ' + (e?.message || e));
  }
}

async function cloudGenerateRoutine({ analysis, options }) {
  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('Anthropic API key not configured (set ANTHROPIC_API_KEY)');
  const prompt = `Produce a JSON with keys: routine {morning, evening}, metrics, tips, rationale, tailored to analysis: ${JSON.stringify(analysis)}`;
  const r = await fetch('https://api.anthropic.com/v1/complete', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: options?.model || 'claude-2.1', prompt, max_tokens: 700 }) });
  const json = await r.json();
  const text = json?.completion || JSON.stringify(json);
  const parsed = tryParseJsonFromText(text);
  if (parsed) return { text: parsed, provider: 'cloud', raw: json };
  return { text: { rationale: text }, provider: 'cloud', raw: json };
}

async function generateRoutine({ provider = 'openai', analysis, options = {} }) {
  if (!analysis) throw new Error('analysis required');
  // Try the requested provider first, but fall back to the others if it fails.
  const order = [provider, 'openai', 'gemini', 'cloud'].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr = null;
  for (const p of order) {
    try {
      if (p === 'openai') return await openaiGenerateRoutine({ analysis, options });
      if (p === 'gemini') return await geminiGenerateRoutine({ analysis, options });
      if (p === 'cloud') return await cloudGenerateRoutine({ analysis, options });
    } catch (e) {
      lastErr = e;
      console.warn(`generateRoutine: provider ${p} failed:`, e?.message || e);
      // try next
    }
  }
  // If we reach here all providers failed
  throw new Error('All generation providers failed: ' + (lastErr?.message || String(lastErr)));
}

module.exports.generateRoutine = generateRoutine;
