const axios = require('axios');
const crypto = require('crypto');

/**
 * Send a webhook to the IRIS ecosystem
 * @param {string} event - The event type (e.g., 'security_alert', 'system_error')
 * @param {object} data - The payload data
 */
async function sendWebhook(event, data) {
    const webhookUrl = process.env.IRIS_WEBHOOK_URL;
    
    if (!webhookUrl) {
        console.warn('[WEBHOOK] IRIS_WEBHOOK_URL not configured, skipping webhook');
        return;
    }

    try {
        const payload = {
            timestamp: new Date().toISOString(),
            event,
            data
        };

        // Create HMAC signature for security verification
        // Using IRIS_API_KEY as the secret if specific webhook secret isn't present
        const secret = process.env.IRIS_WEBHOOK_SECRET || process.env.IRIS_API_KEY || 'default-secret';
        const signature = crypto
            .createHmac('sha256', secret)
            .update(JSON.stringify(payload))
            .digest('hex');

        await axios.post(webhookUrl, payload, {
            headers: {
                'X-IRIS-Signature': signature,
                'Content-Type': 'application/json'
            },
            timeout: 5000 // 5 second timeout to not block too long
        });

        console.log(`[WEBHOOK] Sent event '${event}' to IRIS`);
    } catch (error) {
        console.error(`[WEBHOOK] Failed to send event '${event}':`, error.message);
    }
}

module.exports = { sendWebhook };
