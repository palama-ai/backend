/**
 * Perplexity Search API Wrapper for Agent 2
 * 
 * Replaces Brave Search with Perplexity AI's "sonar" model.
 * Performs deep research on a skincare product and returns structured findings.
 */

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Execute a deep research query via Perplexity and return structured findings.
 * @param {string} brand - Product brand
 * @param {string} productName - Product name
 * @returns {Promise<{manufacturer: Array, reputation: Array, reviews: Array, safety: Array}>}
 */
async function searchProduct(brand, productName) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    console.warn('[Agent2] WARNING: PERPLEXITY_API_KEY is not set. Web research will be skipped.');
    return { manufacturer: [], reputation: [], reviews: [], safety: [] };
  }

  const safeBrand = brand || 'unknown brand';
  const safeName = productName || 'unknown product';

  const systemPrompt = `You are a professional skincare product researcher. 
Research the following product: "${safeName}" by "${safeBrand}".
Provide deep analysis in 4 areas:
1. Manufacturer: Where is it made? Who owns the brand? What are their certifications?
2. Reputation: Is the brand trustworthy? Are they known for high quality or many complaints?
3. Reviews: What is the general sentiment of online reviews? (Reddit, Amazon, Trustpilot)
4. Safety: Has the product or brand been recalled, banned, or warned by FDA/EU/health authorities?

Return ONLY valid JSON in this exact format:
{
  "manufacturer": [{"title": "Finding", "description": "Details", "url": "Source URL if available"}],
  "reputation": [{"title": "Finding", "description": "Details", "url": "url"}],
  "reviews": [{"title": "Finding", "description": "Details", "url": "url"}],
  "safety": [{"title": "Finding", "description": "Details", "url": "url"}]
}`;

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Research product: ${safeName} by ${safeBrand}` }
        ],
        temperature: 0.2,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Agent2] Perplexity HTTP ${response.status}: ${errText.substring(0, 200)}`);
      return { manufacturer: [], reputation: [], reviews: [], safety: [] };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Try to parse JSON from content
    let parsed = null;
    try {
      // Remove possible markdown fences
      const cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');
      if (first >= 0 && last > first) {
        parsed = JSON.parse(cleaned.substring(first, last + 1));
      } else {
        parsed = JSON.parse(cleaned);
      }
    } catch (e) {
      console.error('[Agent2] Perplexity response parsing failed:', e.message);
      return { manufacturer: [], reputation: [], reviews: [], safety: [] };
    }

    // Ensure all keys exist
    const result = {
      manufacturer: Array.isArray(parsed.manufacturer) ? parsed.manufacturer : [],
      reputation: Array.isArray(parsed.reputation) ? parsed.reputation : [],
      reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
      safety: Array.isArray(parsed.safety) ? parsed.safety : []
    };

    console.log(`[Agent2] Perplexity research complete for "${safeName}"`);
    return result;

  } catch (err) {
    console.error('[Agent2] Perplexity API error:', err?.message || err);
    return { manufacturer: [], reputation: [], reviews: [], safety: [] };
  }
}

module.exports = { searchProduct };
