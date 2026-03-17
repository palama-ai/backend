/**
 * Brave Search API Wrapper for Agent 2
 * 
 * Performs 4 targeted web searches about a skincare product:
 * 1. Manufacturer info
 * 2. Brand reputation
 * 3. Customer reviews
 * 4. Safety/recall record
 */

// Uses native fetch (Node.js 18+)

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

// Check API key once at startup
if (!process.env.BRAVE_SEARCH_API_KEY) {
  console.warn('[Agent2] WARNING: BRAVE_SEARCH_API_KEY is not set. Web search verification will be skipped.');
}

/**
 * Execute a single Brave Search query and return top N results.
 * @param {string} query - Search query string
 * @param {number} count - Number of results to request (default 5, extract top 3)
 * @returns {Promise<Array<{title: string, description: string, url: string}>>}
 */
async function braveSearch(query, count = 5) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const url = `${BRAVE_SEARCH_URL}?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      }
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`[Agent2] Brave Search HTTP ${response.status}: ${errText.substring(0, 200)}`);
      return [];
    }

    const data = await response.json();
    const webResults = data.web?.results || [];

    // Extract top 3 results
    return webResults.slice(0, 3).map(r => ({
      title: r.title || '',
      description: r.description || '',
      url: r.url || ''
    }));
  } catch (err) {
    console.error('[Agent2] Brave Search error:', err?.message || err);
    return [];
  }
}

/**
 * Perform all 4 product verification searches.
 * @param {string} brand - Product brand name
 * @param {string} productName - Product name
 * @returns {Promise<{manufacturer: Array, reputation: Array, reviews: Array, safety: Array}>}
 */
async function searchProduct(brand, productName) {
  const safeBrand = brand || 'unknown brand';
  const safeName = productName || 'unknown product';

  // Build search queries
  const queries = {
    manufacturer: `"${safeBrand}" "${safeName}" manufacturer country made`,
    reputation: `"${safeBrand}" skincare brand review trustworthy legit`,
    reviews: `"${safeName}" "${safeBrand}" customer reviews results`,
    safety: `"${safeBrand}" "${safeName}" recalled banned FDA EU warning`
  };

  // Execute searches sequentially with delay to respect rate limits
  // (Free plan: 1 request/second)
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  const manufacturer = await braveSearch(queries.manufacturer);
  await delay(1200);
  const reputation = await braveSearch(queries.reputation);
  await delay(1200);
  const reviews = await braveSearch(queries.reviews);
  await delay(1200);
  const safety = await braveSearch(queries.safety);

  console.log(`[Agent2] Search results: manufacturer=${manufacturer.length}, reputation=${reputation.length}, reviews=${reviews.length}, safety=${safety.length}`);

  return { manufacturer, reputation, reviews, safety };
}

module.exports = { searchProduct, braveSearch };
