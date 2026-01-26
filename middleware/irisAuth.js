const { sendWebhook } = require('../utils/webhook');

// Store simple rate limits in memory
// Map<ip, { timestamp, count }>
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 5000; // 5 seconds
const WHITELISTED_IPS = (process.env.IRIS_WHITELISTED_IPS || '127.0.0.1,::1').split(',');

/**
 * Middleware to secure IRIS API endpoints
 */
function irisAuth(req, res, next) {
    const apiKey = req.header('X-IRIS-API-KEY');
    const configuredKey = process.env.IRIS_API_KEY;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    // 1. IP Whitelisting - DISABLED by user request
    // Normalize IP (handle ::ffff: prefix from IPv6 mapped IPv4)
    // const normalizedIp = ip.replace('::ffff:', '');
    // const isWhitelisted = WHITELISTED_IPS.some(w => normalizedIp.includes(w.trim()));

    // Allow if in dev mode or whitelisted
    // if (process.env.NODE_ENV === 'production' && !isWhitelisted) {
    //     console.warn(`[IRIS-AUTH] Blocked non-whitelisted IP: ${ip}`);
    //     // Log critical security event
    //     return res.status(403).json({ error: 'Access denied: IP not whitelisted' });
    // }

    // 2. API Key Validation
    if (!apiKey || !configuredKey || apiKey !== configuredKey) {
        console.warn(`[IRIS-AUTH] Invalid API Key attempt from ${ip}`);
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    // 3. Rate Limiting (1 req / 5 sec)
    const now = Date.now();
    const userLimit = rateLimits.get(ip);

    if (userLimit && now - userLimit.timestamp < RATE_LIMIT_WINDOW) {
        return res.status(429).json({
            error: 'Rate limit exceeded. Max 1 request per 5 seconds.',
            retryAfter: Math.ceil((RATE_LIMIT_WINDOW - (now - userLimit.timestamp)) / 1000)
        });
    }

    // Update rate limit record
    rateLimits.set(ip, { timestamp: now });

    next();
}

module.exports = { irisAuth };
