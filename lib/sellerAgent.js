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

    if (data.error) {
      return { error: data.error.message || JSON.stringify(data.error) };
    }

    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) return { error: 'No response from vision AI' };

    return tryParseJsonFromText(text) || { error: 'Failed to parse vision response' };
  } catch (err) {
    console.error('[SellerAgent] Vision analysis failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Specific lookup using barcode via Perplexity.
 * @param {string} barcode - Product barcode
 * @returns {Promise<object>} - Discovered name and brand
 */
async function lookupBarcode(barcode) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey || !barcode) return null;

  const query = `What skincare product does this barcode: "${barcode}" belong to? Give me exactly the product name and brand.`;
  const systemPrompt = `Return ONLY valid JSON: { "name": "Exact Name", "brand": "Brand Name" }. No preamble.`;

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
    return tryParseJsonFromText(content);
  } catch (err) {
    console.error('[SellerAgent] Barcode lookup failed:', err.message);
    return null;
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
  
  console.log(`[SellerAgent] discoverProductDetails called for: "${name}" by "${brand || ''}"`);
  console.log(`[SellerAgent] PERPLEXITY_API_KEY present: ${!!apiKey}`);
  
  if (!apiKey) {
    console.error('[SellerAgent] PERPLEXITY_API_KEY is NOT set in environment variables!');
    return { description: null, image_urls: [], ingredients: null, category: null };
  }
  if (!name) return { description: null, image_urls: [], ingredients: null, category: null };

  const query = `Find the official product details for the skincare product: "${name}" by "${brand || ''}". Include description, ingredients, category, and product images.`;

  const systemPrompt = `You are a product research assistant. Return ONLY valid JSON (no markdown, no extra text):
{
  "description": "2-3 sentence product description",
  "ingredients": "comma separated ingredient list",
  "category": "one of: Cleanser, Moisturizer, Serum, Sunscreen, Toner, Eye Cream, Mask, Exfoliant, Oil, Balm",
  "suggested_price": "price as number only",
  "official_site": "official website url"
}
Set any unknown field to null. Never write "unable to locate", just use null.`;

  try {
    console.log(`[SellerAgent] Calling Perplexity API with return_images=true...`);
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
        temperature: 0.1,
        return_images: true  // Perplexity native image search
      })
    });

    console.log(`[SellerAgent] Perplexity response status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SellerAgent] Perplexity API error ${response.status}: ${errorText.substring(0, 200)}`);
      return { description: null, image_urls: [], ingredients: null, category: null };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Extract images from Perplexity's native image search results
    // These are returned in data.images when return_images: true
    const nativeImages = (data.images || [])
      .map(img => img?.url || img?.image_url || img)
      .filter(url => url && typeof url === 'string' && url.startsWith('http'));
    
    console.log(`[SellerAgent] Perplexity native images found: ${nativeImages.length}`);
    console.log(`[SellerAgent] Raw response (first 300 chars): ${content.substring(0, 300)}`);
    
    const parsed = tryParseJsonFromText(content);
    if (!parsed) {
      console.error('[SellerAgent] Failed to parse Perplexity response as JSON');
      return { description: null, image_urls: nativeImages, ingredients: null, category: null };
    }
    
    console.log(`[SellerAgent] Parsed: description=${!!parsed.description}, category=${parsed.category}`);
    
    // Filter out bad descriptions
    if (parsed.description) {
      const desc = parsed.description.toLowerCase();
      if (desc.includes('unable to locate') || desc.includes("couldn't find") || desc.includes('not found') || desc.includes('no information') || desc.length < 20) {
        console.log('[SellerAgent] Discarding unhelpful description');
        parsed.description = null;
      }
    }
    
    // Use native Perplexity images + any from parsed JSON, prioritize native
    const jsonImages = (parsed.image_urls || []).filter(url =>
      url && typeof url === 'string' && url.startsWith('http')
    );
    parsed.image_urls = [...new Set([...nativeImages, ...jsonImages])]; // deduplicate
    console.log(`[SellerAgent] Final image count: ${parsed.image_urls.length}`);
    
    return parsed;
  } catch (err) {
    console.error('[SellerAgent] Discovery failed with exception:', err.message);
    return { description: null, image_urls: [], ingredients: null, category: null };
  }
}



/**
 * Main conversation logic.
 * @param {Array} history - Previous messages
 * @param {string} message - User's current message
 * @param {string|null} base64Image - Optional image
 * @param {object|null} currentState - Previously extracted product data from the frontend (preserves state across turns)
 * @returns {Promise<object>} - Agent response and state
 */
async function processConversation(history, message, base64Image = null, currentState = null, options = {}) {
  const { webAccess = true, model = 'auto' } = options;
  const targetModel = model === 'auto' ? 'groq/compound-mini' : model;
  let extractedData = null;
  let discoveredData = null;

  // --- STEP 1: Analyze fresh inputs ---
  if (base64Image) {
    console.log('[SellerAgent] Analyzing product image...');
    extractedData = await analyzeProductImage(base64Image);

    // If we have a barcode but no name, try barcode lookup
    if (extractedData && extractedData.barcode && !extractedData.name) {
      console.log(`[SellerAgent] No name from vision, trying barcode lookup for: ${extractedData.barcode}`);
      const barcodeInfo = await lookupBarcode(extractedData.barcode);
      if (barcodeInfo && barcodeInfo.name) {
        extractedData.name = barcodeInfo.name;
        extractedData.brand = barcodeInfo.brand || extractedData.brand;
      }
    }
  } else if (message && message.length > 5 && /^\d+$/.test(message.trim())) {
    // Pure barcode message
    const barcode = message.trim();
    console.log(`[SellerAgent] Barcode message detected: ${barcode}`);
    extractedData = { barcode };
    const barcodeInfo = await lookupBarcode(barcode);
    if (barcodeInfo && barcodeInfo.name) {
      extractedData.name = barcodeInfo.name;
      extractedData.brand = barcodeInfo.brand;
    }
  }

  // --- STEP 2: Merge currentState + fresh extractedData into a single source of truth ---
  // currentState is sent from the frontend on every message — it contains everything known so far
  const mergedKnownData = {
    ...(currentState || {}),       // base: everything we know from previous turns
    ...(extractedData || {})       // overlay: fresh data from this turn (image/barcode)
  };

  // --- STEP 3: Run discovery if we have a name but missing details ---
  const hasName = mergedKnownData.name;
  const needsDiscovery = hasName && (
    !mergedKnownData.description ||
    !mergedKnownData.category ||
    !mergedKnownData.ingredients ||
    !mergedKnownData.suggested_images?.length
  );

  if (needsDiscovery && webAccess) {
    console.log(`[SellerAgent] Running discovery for: ${mergedKnownData.name}`);
    discoveredData = await discoverProductDetails(mergedKnownData.name, mergedKnownData.brand || '');
  } else if (needsDiscovery && !webAccess) {
    console.log(`[SellerAgent] Skipping discovery (web access disabled) for: ${mergedKnownData.name}`);
  }

  // --- STEP 4: Build complete fullContext for the LLM ---
  const fullContext = {
    name: mergedKnownData.name || discoveredData?.name || null,
    brand: mergedKnownData.brand || discoveredData?.brand || null,
    ingredients: mergedKnownData.ingredients || discoveredData?.ingredients || null,
    category: mergedKnownData.category || discoveredData?.category || null,
    description: mergedKnownData.description || discoveredData?.description || null,
    price: mergedKnownData.price || discoveredData?.suggested_price || null,
    purchase_url: mergedKnownData.purchase_url || null,
    barcode: mergedKnownData.barcode || null,
    image_url: mergedKnownData.image_url || discoveredData?.image_urls?.[0] || null,
    suggested_images: (mergedKnownData.suggested_images?.length
      ? mergedKnownData.suggested_images
      : (discoveredData?.image_urls || []))
  };

  // --- STEP 5: Call the LLM with full context ---
  const systemPrompt = `You are "Glowimatch Seller Assistant", a highly intelligent, polite, and helpful AI assistant for skincare sellers.
Your goal is to help sellers manage their store, add products, and answer any questions they might have.

CURRENT PRODUCT STATE (only relevant if adding a product):
${JSON.stringify(fullContext, null, 2)}

CORE BEHAVIORS & RULES:
1. **Be Conversational & Smart**: If the user is just saying hello, asking a general question, or chatting, reply naturally and helpfully. DO NOT forcefully ask for product fields unless the user clearly wants to add a new product or you're already in the middle of adding one.
2. **Action: "CHAT"**: Use this for general conversation, greetings, answering questions, or when the user hasn't explicitly started adding a product yet.
3. **Action: "ASK_INFO"**: Use this ONLY when the user is actively adding a product and you need to collect missing required fields (name, brand, ingredients, price, purchase_url, category).
4. **Action: "CONFIRM_SAVE"**: Use this when you have collected all required fields and want the user to confirm before saving.
5. **Action: "EXECUTE_SAVE"**: Use this only when the user explicitly confirms saving/adding the product.
6. **Action: "FIX_IMAGES"**: Use this if the user asks you to "fix images", "repair pictures", or anything about missing images for their existing products.
7. **Action: "MODIFY_PRODUCT"**: Use this when the user explicitly asks to edit, change, or update an EXISTING product in their inventory (e.g. "change price of CeraVe to 15", "update description for my cleanser"). YOU MUST INCLUDE \`target_product_name\` and \`updates\` in the JSON.
8. **Language**: Always reply in English. Be warm and professional.

If the user is adding a product, remember:
- Never ask for a field that is already present in CURRENT PRODUCT STATE.
- If ingredients are missing, suggest they upload a photo of the product's back.
- Only show a summary and ask for confirmation once all required fields are filled.

Return ONLY valid JSON (no markdown):
{
  "reply": "Your conversational reply",
  "extracted_info": {
    "name": "...", "brand": "...", "ingredients": "...", "description": "...",
    "category": "...", "price": "...", "purchase_url": "...", "image_url": "...",
    "barcode": "...", "suggested_images": []
  },
  "action": "ASK_INFO" | "CONFIRM_SAVE" | "EXECUTE_SAVE" | "FIX_IMAGES" | "MODIFY_PRODUCT" | "CHAT",
  "missing_fields": ["list of still-missing required fields"],
  "target_product_name": "Name of product to edit (only if action is MODIFY_PRODUCT)",
  "updates": {
    "price": "new price",
    "description": "new description",
    "name": "new name"
  }
}

IMPORTANT: In extracted_info, include ALL fields from the CURRENT PRODUCT STATE, even ones not mentioned in this message.`;

  const userMsg = `User Message: ${message || (base64Image ? '[Image sent for analysis]' : '')}
Recent History (last 4): ${JSON.stringify(history.slice(-4))}`;

  try {
    const key = process.env.GROQ_API_KEY;
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: targetModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`Groq API Error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    let result = tryParseJsonFromText(data?.choices?.[0]?.message?.content);

    if (!result) {
      result = { reply: data?.choices?.[0]?.message?.content || "Sorry, I couldn't understand that.", action: "CHAT" };
    }

    // --- STEP 6: Protect state — LLM must never overwrite known data with nulls ---
    result.extracted_info = {
      ...fullContext,
      ...(result.extracted_info || {}),
      // Safeguard each field: use LLM value if it's non-null, else fall back to fullContext
      name: result.extracted_info?.name || fullContext.name,
      brand: result.extracted_info?.brand || fullContext.brand,
      ingredients: result.extracted_info?.ingredients || fullContext.ingredients,
      description: result.extracted_info?.description || fullContext.description,
      category: result.extracted_info?.category || fullContext.category,
      barcode: fullContext.barcode || result.extracted_info?.barcode,
      price: result.extracted_info?.price || fullContext.price,
      purchase_url: result.extracted_info?.purchase_url || fullContext.purchase_url,
      image_url: result.extracted_info?.image_url || fullContext.image_url,
      suggested_images: (fullContext.suggested_images?.length
        ? fullContext.suggested_images
        : (result.extracted_info?.suggested_images || []))
    };

    return result;
  } catch (err) {
    console.error('[SellerAgent] Chat processing failed:', err.message);
    // Return current known state so the frontend doesn't lose data on error
    return {
      reply: "Sorry, an error occurred while processing. Please try again.",
      action: "CHAT",
      extracted_info: fullContext
    };
  }
}

module.exports = {
  analyzeProductImage,
  discoverProductDetails,
  processConversation
};
