/**
 * Seller AI Chatbot Logic
 * 
 * Handles multi-turn conversations for adding products via chat.
 * Features:
 * - Vision: Extracting ingredients and product info from photos.
 * - Discovery: Using Perplexity to find official descriptions and product images.
 * - State Management: Guiding the seller through the required fields.
 */

const { GROQ_API_URL, IMAGE_ANALYSIS_MODEL, groqRequest, tryParseJsonFromText } = require('./aiProviders');
const { searchProduct } = require('./perplexitySearch');
const fetch = require('node-fetch');

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Analyze a product image (packaging/barcode) using Groq Vision.
 * @param {string} base64Image - Base64 encoded image data
 * @returns {Promise<object>} - Extracted product data
 */
async function analyzeProductImage(base64Image) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not configured');

  const messages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `You are a product database assistant. Analyze this photo of a skincare product packaging or barcode.
          
Extract the following information:
1. Product Name
2. Brand Name
3. Full Ingredients List
4. Barcode number (if visible)
5. Category (e.g., Cleanser, Moisturizer, Serum)

Return ONLY valid JSON with keys:
- name: string or null
- brand: string or null
- ingredients: string or null (comma separated)
- barcode: string or null
- category: string or null
- confidence: 0-100 score

IMPORTANT: If you see a barcode, try to read it accurately. If you see ingredients, transcribe them exactly.
Return ONLY valid JSON, no markdown.`
        },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${base64Image}` }
        }
      ]
    }
  ];

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: IMAGE_ANALYSIS_MODEL,
        messages,
        max_tokens: 1000,
        temperature: 0.1
      })
    });

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return tryParseJsonFromText(text) || { error: 'Failed to parse vision response' };
  } catch (err) {
    console.error('[SellerAgent] Vision analysis failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Use Perplexity to find official product details and images.
 * @param {string} name - Product name
 * @param {string} brand - Brand name
 * @returns {Promise<object>} - Discovered details and images
 */
async function discoverProductDetails(name, brand) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return { description: null, image_urls: [] };

  const query = `Find the official product description and 3 high-quality direct image URLs for: "${name}" by "${brand}".`;
  
  const systemPrompt = `You are a product research assistant. Find authentic information for the requested product.
Return ONLY valid JSON (no markdown):
{
  "description": "2-3 sentence official product description",
  "image_urls": ["url1", "url2", "url3"],
  "suggested_price": "estimated price in USD or range",
  "official_site": "url"
}`;

  try {
    const response = await fetch(PERPLEXITY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return tryParseJsonFromText(content) || { description: null, image_urls: [] };
  } catch (err) {
    console.error('[SellerAgent] Discovery failed:', err.message);
    return { description: null, image_urls: [] };
  }
}

/**
 * Main conversation logic.
 * @param {Array} history - Previous messages
 * @param {string} message - User's current message
 * @param {string|null} base64Image - Optional image
 * @returns {Promise<object>} - Agent response and state
 */
async function processConversation(history, message, base64Image = null) {
  // If an image is provided, we prioritize analysis
  let extractedData = null;
  let discoveredData = null;

  if (base64Image) {
    extractedData = await analyzeProductImage(base64Image);
    if (extractedData && extractedData.name) {
      discoveredData = await discoverProductDetails(extractedData.name, extractedData.brand);
    }
  }

  // System prompt to guide the LLM on how to respond to the seller
  const systemPrompt = `You are "Glowimatch Seller Assistant", a helpful AI that helps sellers add products.
Your goal is to gather: Name, Brand, Ingredients, Price, and Purchase URL.

RULES:
1. If the user sent an image, it was analyzed. Use the extracted data provided.
2. If ingredients are missing, POLITELY ask the user to type them or upload a photo of the back of the product.
3. If you have enough info (Name, Brand, Ingredients), show a summary and ask for Price and Purchase URL.
4. Once you have EVERYTHING, ask for confirmation to save.
5. Speak in the user's language (Arabic or English).

Current Extracted Data: ${JSON.stringify(extractedData)}
Current Discovered Data: ${JSON.stringify(discoveredData)}

Return JSON:
{
  "reply": "Your message to the user",
  "extracted_info": { "name": "...", "brand": "...", "ingredients": "...", "description": "...", "image_url": "...", "suggested_images": [] },
  "action": "ASK_INFO" | "CONFIRM_SAVE" | "CHAT",
  "missing_fields": ["ingredients", "price", etc]
}`;

  const userMsg = `History: ${JSON.stringify(history.slice(-5))}\nUser Message: ${message || (base64Image ? "Analyzed image" : "")}`;

  try {
    const key = process.env.GROQ_API_KEY;
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.3,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();
    let result = tryParseJsonFromText(data?.choices?.[0]?.message?.content);
    
    if (!result) {
        result = { reply: data?.choices?.[0]?.message?.content || "I'm not sure how to respond to that.", action: "CHAT" };
    }

    if (extractedData || discoveredData) {
      result.extracted_info = {
        ...(result.extracted_info || {}),
        ...extractedData,
        description: discoveredData?.description || result.extracted_info?.description,
        suggested_images: discoveredData?.image_urls || []
      };
    }

    return result;
  } catch (err) {
    console.error('[SellerAgent] Chat processing failed:', err.message);
    return { reply: "Sorry, I'm having trouble processing that right now.", action: "CHAT" };
  }
}

module.exports = {
  analyzeProductImage,
  discoverProductDetails,
  processConversation
};
