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
    if (!apiKey || !name) return { description: null, image_urls: [], ingredients: null, category: null };

    const query = `Find the official product description, full ingredients list, 3 high-quality direct image URLs (from sites like Amazon, Sephora, or official brands), and category for: "${name}" by "${brand || ''}".`;
    
    const systemPrompt = `You are a product research assistant. Find authentic information for the requested product. 
  Return ONLY valid JSON (no markdown):
  {
    "description": "2-3 sentence official product description",
    "ingredients": "full comma separated list of ingredients",
    "category": "e.g., Cleanser, Moisturizer, Serum, Sunscreen",
    "image_urls": ["url1", "url2", "url3"],
    "suggested_price": "estimated price in numbers only",
    "official_site": "url"
  }
  IMPORTANT: Ensure image_urls are direct links to images (ending in .jpg, .png, etc.) from reputable public sources.`;

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
      return tryParseJsonFromText(content) || { description: null, image_urls: [], ingredients: null, category: null };
    } catch (err) {
      console.error('[SellerAgent] Discovery failed:', err.message);
      return { description: null, image_urls: [], ingredients: null, category: null };
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
      
      // If we have a barcode but no name, try barcode lookup
      if (extractedData && extractedData.barcode && !extractedData.name) {
        console.log(`[SellerAgent] No name from vision, trying barcode lookup for: ${extractedData.barcode}`);
        const barcodeInfo = await lookupBarcode(extractedData.barcode);
        if (barcodeInfo && barcodeInfo.name) {
          extractedData.name = barcodeInfo.name;
          extractedData.brand = barcodeInfo.brand || extractedData.brand;
        }
      }

      if (extractedData && extractedData.name) {
        discoveredData = await discoverProductDetails(extractedData.name, extractedData.brand);
      }
    } else if (message && (message.length > 5 && /^\d+$/.test(message))) {
      // If the message is just a barcode
      extractedData = { barcode: message };
      const barcodeInfo = await lookupBarcode(message);
      if (barcodeInfo && barcodeInfo.name) {
        extractedData.name = barcodeInfo.name;
        extractedData.brand = barcodeInfo.brand;
        discoveredData = await discoverProductDetails(barcodeInfo.name, barcodeInfo.brand);
      }
    }

    // System prompt to guide the LLM on how to respond to the seller
  const systemPrompt = `You are "Glowimatch Seller Assistant", a helpful AI that helps sellers add products.
Your goal is to gather: Name, Brand, Ingredients, Price, Purchase URL, and Category.
Current Date: ${new Date().toISOString()}

RULES:
1. If the user sent an image, use the extracted data provided.
2. If ingredients are missing, POLITELY ask the user to type them or upload a photo of the back of the product.
3. If you have Name, Brand, and Ingredients, you MUST ask for the missing fields: Price, Purchase URL, and Category.
4. Once you have ALL fields, show a summary and ask for final confirmation (e.g. "Do you want to save this product?").
5. If the user says "YES", "OK", "Save it", "تأكيد", "نعم", use action: "EXECUTE_SAVE".
6. If the user is still providing info, use action: "ASK_INFO" or "CHAT".
7. Speak in the user's language (Arabic or English).

Current Extracted Data: ${JSON.stringify(extractedData)}
Current Discovered Data: ${JSON.stringify(discoveredData)}

Return JSON:
{
  "reply": "Your message to the user",
  "extracted_info": { "name": "...", "brand": "...", "ingredients": "...", "description": "...", "category": "...", "price": "...", "purchase_url": "...", "image_url": "...", "barcode": "...", "suggested_images": [] },
  "action": "ASK_INFO" | "CONFIRM_SAVE" | "EXECUTE_SAVE" | "CHAT",
  "missing_fields": ["ingredients", "price", "purchase_url", "category"]
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
      
      if (data.error) {
          throw new Error(`Groq API Error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      let result = tryParseJsonFromText(data?.choices?.[0]?.message?.content);
      
      if (!result) {
          result = { reply: data?.choices?.[0]?.message?.content || "I'm not sure how to respond to that.", action: "CHAT" };
      }

      if (extractedData || discoveredData) {
        result.extracted_info = {
          ...(result.extracted_info || {}),
          ...extractedData,
          description: discoveredData?.description || result.extracted_info?.description,
          category: extractedData?.category || discoveredData?.category || result.extracted_info?.category,
          price: extractedData?.price || discoveredData?.suggested_price || result.extracted_info?.price,
          ingredients: extractedData?.ingredients || discoveredData?.ingredients || result.extracted_info?.ingredients,
          barcode: extractedData?.barcode || result.extracted_info?.barcode,
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
