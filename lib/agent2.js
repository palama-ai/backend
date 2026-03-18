/**
 * Agent 2 — Deep Product Verification
 * 
 * Runs as a background job after Agent 1 passes.
 * Uses Perplexity Search API + Groq LLM to verify product legitimacy,
 * check for recalls, score reputation, and update the product record.
 */

// Uses native fetch (Node.js 18+)
const { v4: uuidv4 } = require('uuid');
const { sql } = require('../db');
const { searchProduct } = require('./perplexitySearch');

const fetch = require('node-fetch');
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SCORING_MODEL = 'llama-3.3-70b-versatile';

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Try to extract valid JSON from a text response that may contain markdown fences.
 */
function tryParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  // Strip markdown code fences if present
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = cleaned.substring(first, last + 1);
    try { return JSON.parse(candidate); } catch (e) { /* fallthrough */ }
  }
  try { return JSON.parse(cleaned); } catch (e) { return null; }
}

/**
 * Call Groq chat completion API.
 * @param {Array} messages - Chat messages
 * @param {object} opts - max_tokens, temperature
 * @returns {Promise<string>} - The assistant's text response
 */
async function groqChat(messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not configured');

  const body = {
    model: opts.model || SCORING_MODEL,
    messages,
    max_tokens: opts.max_tokens || 1024,
    temperature: opts.temperature ?? 0.2
  };

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify(body)
  });

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || JSON.stringify(json.error));
  }

  return json?.choices?.[0]?.message?.content || '';
}

/**
 * Call Groq with one retry after 3 seconds on failure.
 */
async function groqChatWithRetry(messages, opts = {}) {
  try {
    return await groqChat(messages, opts);
  } catch (err) {
    console.warn('[Agent2] Groq call failed, retrying in 3s:', err?.message);
    await new Promise(r => setTimeout(r, 3000));
    return await groqChat(messages, opts);
  }
}

/**
 * Send a notification to a specific user (seller or admin).
 */
async function sendNotification(userId, title, body) {
  try {
    const notificationId = uuidv4();
    await sql`
      INSERT INTO notifications (id, title, body, target_all)
      VALUES (${notificationId}, ${title}, ${body}, 0)
    `;
    await sql`
      INSERT INTO user_notifications (notification_id, user_id)
      VALUES (${notificationId}, ${userId})
    `;
    console.log(`[Agent2] Notification sent to ${userId}: ${title}`);
  } catch (err) {
    console.error('[Agent2] Failed to send notification:', err?.message);
  }
}

/**
 * Send a notification to all admin users.
 */
async function sendAdminNotification(title, body) {
  try {
    const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
    for (const admin of admins) {
      await sendNotification(admin.id, title, body);
    }
  } catch (err) {
    console.error('[Agent2] Failed to send admin notification:', err?.message);
  }
}

// ─── Recall Detection (Priority Check) ─────────────────────────────

const RECALL_SYSTEM_PROMPT = `You are a product safety analyst. Analyze these search results about a cosmetic product.
Determine:
1. Was this product recalled or banned from the market? (yes/no)
2. If yes, what is the reason for the recall?
3. Is the reason dangerous to human skin? (causes burns, irritation, disease, contains toxic ingredients)
4. Does the reason harm the reputation of an e-commerce platform selling it? (fraud, legal violations, scandal)

Return ONLY valid JSON, no markdown:
{
  "recalled": true/false,
  "recall_reason": "string or null",
  "recall_source_url": "string or null",
  "harmful_to_skin": true/false,
  "harmful_to_reputation": true/false,
  "confidence": 0-100
}`;

/**
 * Check if a product has been recalled or banned.
 * @param {string} productName
 * @param {string} brand
 * @param {Array} safetyResults - Search results from the safety query
 * @returns {Promise<object>} - Recall check result
 */
async function checkRecall(productName, brand, safetyResults) {
  const userMessage = `Product: "${productName}" by "${brand}"\n\nSafety search results:\n${JSON.stringify(safetyResults, null, 2)}`;

  const text = await groqChatWithRetry([
    { role: 'system', content: RECALL_SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ], { max_tokens: 500, temperature: 0.1 });

  const parsed = tryParseJson(text);
  if (!parsed) {
    console.warn('[Agent2] Could not parse recall check response, assuming not recalled');
    return {
      recalled: false,
      recall_reason: null,
      recall_source_url: null,
      harmful_to_skin: false,
      harmful_to_reputation: false,
      confidence: 0
    };
  }

  return parsed;
}

// ─── Full Scoring ───────────────────────────────────────────────────

const SCORING_SYSTEM_PROMPT = `You are a cosmetic product verification expert for an e-commerce platform.
Analyze the provided web search results about this skincare product and return a structured evaluation.

Scoring weights:
- Customer reviews sentiment: 40 points max
- Brand/manufacturer reputation: 30 points max  
- Manufacturing location & certifications: 15 points max
- Product safety record (no bans/warnings): 15 points max

Total score: 0-100

Verdict thresholds:
- 70-100: verified (trustworthy product, good reviews)
- 40-69: unverified (insufficient data or mixed signals)
- 0-39:  flagged (concerning signals, poor reviews, or unknown brand)

Return ONLY valid JSON, no markdown, no explanation:
{
  "score": <integer 0-100>,
  "verdict": "verified" | "unverified" | "flagged",
  "manufacturer_info": {
    "name": "string or null",
    "country": "string or null",
    "founded": "string or null",
    "certifications": ["string"] or []
  },
  "review_summary": "2-3 sentence summary of what customers say",
  "sample_reviews": [
    {"text": "review snippet 1", "url": "source url 1"},
    {"text": "review snippet 2", "url": "source url 2"}
  ],
  "positive_signals": ["string"],
  "red_flags": ["string"] or [],
  "confidence": <integer 0-100>
}`;

/**
 * Run full scoring via Groq LLM.
 * @param {object} product - Product record from DB
 * @param {object} searchResults - All 4 search result sets
 * @param {number|null} maxScore - Optional cap on the maximum score
 * @returns {Promise<object>} - Scoring result
 */
async function runFullScoring(product, searchResults, maxScore = null) {
  const ingredientsSummary = product.ingredients
    ? product.ingredients.substring(0, 300)
    : 'Not provided';

  const userMessage = `Product Name: ${product.name}
Brand: ${product.brand || 'Unknown'}
Ingredients (summary): ${ingredientsSummary}

Search Results:
${JSON.stringify(searchResults, null, 2)}`;

  const text = await groqChatWithRetry([
    { role: 'system', content: SCORING_SYSTEM_PROMPT },
    { role: 'user', content: userMessage }
  ], { max_tokens: 1200, temperature: 0.2 });

  const parsed = tryParseJson(text);
  if (!parsed) {
    console.warn('[Agent2] Could not parse scoring response, defaulting to unverified');
    return {
      score: 50,
      verdict: 'unverified',
      manufacturer_info: null,
      review_summary: 'Unable to analyze search results.',
      sample_reviews: [],
      positive_signals: [],
      red_flags: [],
      confidence: 0
    };
  }

  // Apply score cap if set (e.g. for recalled-but-not-harmful products)
  if (maxScore !== null && parsed.score > maxScore) {
    parsed.score = maxScore;
    // Recalculate verdict based on capped score
    if (parsed.score >= 70) parsed.verdict = 'verified';
    else if (parsed.score >= 40) parsed.verdict = 'unverified';
    else parsed.verdict = 'flagged';
  }

  return parsed;
}

// ─── Main Verification Flow ────────────────────────────────────────

/**
 * Run deep verification on a product. This is the main entry point.
 * Should be called without await (fire-and-forget from HTTP handler).
 * 
 * @param {string} productId - UUID of the product to verify
 */
async function runDeepVerification(productId) {
  console.log(`[Agent2] Starting deep verification for product ${productId}`);

  // 1. Fetch product from DB
  const products = await sql`
    SELECT id, seller_id, name, brand, description, ingredients, published
    FROM seller_products WHERE id = ${productId}
  `;

  if (!products || products.length === 0) {
    console.error(`[Agent2] Product ${productId} not found in database`);
    return;
  }

  const product = products[0];
  console.log(`[Agent2] Verifying: "${product.name}" by "${product.brand || 'Unknown'}"`);

  // 2. Perform web searches
  let searchResults;
  let hasSearchData = true;
  try {
    searchResults = await searchProduct(product.brand, product.name);

    // Check if we got any data at all
    const totalResults = searchResults.manufacturer.length +
      searchResults.reputation.length +
      searchResults.reviews.length +
      searchResults.safety.length;

    if (totalResults === 0) {
      hasSearchData = false;
      console.log('[Agent2] No search results returned from Perplexity (API key missing or no results)');
    }
  } catch (err) {
    console.error('[Agent2] Perplexity research failed:', err?.message);
    hasSearchData = false;
    searchResults = { manufacturer: [], reputation: [], reviews: [], safety: [] };

    // Perplexity failure → set unverified with score 50
    await sql`
      UPDATE seller_products SET
        verification_status = 'unverified',
        verification_score = 50,
        verification_date = NOW(),
        visibility_score = 80
      WHERE id = ${productId}
    `;
    console.log('[Agent2] Set to unverified (score 50) due to Perplexity failure');
    return;
  }

  // 3. Recall detection (priority check) — only if we have safety search data
  let recallResult = null;
  let maxScoreCap = null;

  if (hasSearchData && searchResults.safety.length > 0) {
    try {
      recallResult = await checkRecall(product.name, product.brand, searchResults.safety);
      console.log(`[Agent2] Recall check: recalled=${recallResult.recalled}, confidence=${recallResult.confidence}`);

      if (recallResult.recalled === true) {
        const isHarmful = recallResult.harmful_to_skin === true || recallResult.harmful_to_reputation === true;

        if (isHarmful) {
          // AUTO-HIDE: Recalled + harmful
          console.log('[Agent2] ⚠️ Product recalled and harmful — auto-hiding');

          await sql`
            UPDATE seller_products SET
              published = 0,
              verification_status = 'recalled_hidden',
              verification_score = 0,
              verification_date = NOW(),
              visibility_score = 0,
              recall_reason = ${recallResult.recall_reason || 'Product recalled'},
              recall_source = ${recallResult.recall_source_url || null},
              hidden_by = 'agent2_auto',
              hidden_at = NOW()
            WHERE id = ${productId}
          `;

          // Notify admin
          await sendAdminNotification(
            '⚠️ Product auto-hidden by Agent 2',
            `Product "${product.name}" (${product.brand || 'Unknown'}) was automatically hidden.\nReason: ${recallResult.recall_reason || 'Recalled/banned product detected'}\nSource: ${recallResult.recall_source_url || 'N/A'}`
          );

          // Notify seller
          if (product.seller_id) {
            await sendNotification(
              product.seller_id,
              '⚠️ Your product was removed',
              `Your product "${product.name}" has been removed from the marketplace.\nReason: ${recallResult.recall_reason || 'Product recalled or banned'}\n\nIf you believe this is an error, please contact support.`
            );
          }

          console.log(`[Agent2] Product ${productId} hidden (recalled_hidden). Verification complete.`);
          return; // STOP — do not continue to full scoring
        } else {
          // Recalled but not harmful — flag it, cap score at 39
          console.log('[Agent2] Product recalled but not harmful — flagging with score cap 39');
          maxScoreCap = 39;

          await sql`
            UPDATE seller_products SET
              verification_status = 'flagged',
              verification_score = 20,
              verification_date = NOW(),
              red_flags = ${JSON.stringify([recallResult.recall_reason || 'Product recall detected'])}
            WHERE id = ${productId}
          `;

          // Notify admin for manual review
          await sendAdminNotification(
            '🔍 Product flagged by Agent 2 — manual review needed',
            `Product "${product.name}" (${product.brand || 'Unknown'}) has a recall record but was assessed as non-harmful.\nReason: ${recallResult.recall_reason || 'Unknown'}\nPlease review manually.`
          );
        }
      }
    } catch (err) {
      console.error('[Agent2] Recall check failed:', err?.message);
      // Continue to full scoring even if recall check fails
    }
  }

  // 4. Full scoring via Groq
  let scoringResult;
  try {
    // If no search data and no PERPLEXITY_API_KEY, cap score at 60
    if (!hasSearchData) {
      maxScoreCap = maxScoreCap !== null ? Math.min(maxScoreCap, 60) : 60;
    }

    scoringResult = await runFullScoring(product, searchResults, maxScoreCap);
    console.log(`[Agent2] Scoring complete: score=${scoringResult.score}, verdict=${scoringResult.verdict}`);
  } catch (err) {
    console.error('[Agent2] Full scoring failed after retry:', err?.message);

    // Groq failure fallback
    await sql`
      UPDATE seller_products SET
        verification_status = 'unverified',
        verification_score = 50,
        verification_date = NOW(),
        visibility_score = 80
      WHERE id = ${productId}
    `;
    console.log('[Agent2] Set to unverified (score 50) due to Groq failure');
    return;
  }

  // 5. Calculate visibility_score
  let visibilityScore;
  if (scoringResult.score >= 70) {
    visibilityScore = 100; // verified
  } else if (scoringResult.score >= 40) {
    visibilityScore = 80;  // unverified
  } else {
    visibilityScore = 40;  // flagged
  }

  // 6. Save results to database
  const manufacturerJson = scoringResult.manufacturer_info
    ? JSON.stringify(scoringResult.manufacturer_info)
    : null;
  const sampleReviewsJson = scoringResult.sample_reviews
    ? JSON.stringify(scoringResult.sample_reviews)
    : null;
  const redFlagsJson = scoringResult.red_flags && scoringResult.red_flags.length > 0
    ? JSON.stringify(scoringResult.red_flags)
    : null;

  await sql`
    UPDATE seller_products SET
      verification_status = ${scoringResult.verdict},
      verification_score = ${scoringResult.score},
      verification_date = NOW(),
      manufacturer_info = ${manufacturerJson},
      review_summary = ${scoringResult.review_summary || null},
      sample_reviews = ${sampleReviewsJson},
      red_flags = ${redFlagsJson},
      visibility_score = ${visibilityScore},
      published = ${scoringResult.verdict === 'flagged' ? 0 : 1}
    WHERE id = ${productId}
  `;

  console.log(`[Agent2] ✅ Verification saved: ${scoringResult.verdict} (score: ${scoringResult.score}, visibility: ${visibilityScore}, published: ${scoringResult.verdict === 'flagged' ? 0 : 1})`);

  // 7. Send admin notification if flagged
  if (scoringResult.verdict === 'flagged') {
    const flagsList = scoringResult.red_flags?.join(', ') || 'No specific flags';
    await sendAdminNotification(
      '🚩 Product flagged by Agent 2',
      `Product "${product.name}" (${product.brand || 'Unknown'}) scored ${scoringResult.score}/100.\nRed flags: ${flagsList}`
    );
  }

  console.log(`[Agent2] Deep verification complete for product ${productId}`);
}

module.exports = { runDeepVerification };
