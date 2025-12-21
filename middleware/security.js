/**
 * 🛡️ Security Middleware - Defense System
 * Comprehensive protection against attacks
 */

// ==================== IP BLACKLIST MANAGER ====================
const ipBlacklist = new Map(); // IP -> { blockedAt, reason, permanent }
const BLACKLIST_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function isIPBlacklisted(ip) {
    const record = ipBlacklist.get(ip);
    if (!record) return false;

    // Permanent blacklist
    if (record.permanent) return true;

    // Temporary blacklist - check expiry
    if (Date.now() - record.blockedAt > BLACKLIST_DURATION_MS) {
        ipBlacklist.delete(ip);
        return false;
    }

    return true;
}

function blacklistIP(ip, reason, permanent = false) {
    ipBlacklist.set(ip, {
        blockedAt: Date.now(),
        reason,
        permanent
    });
    console.log(`[SECURITY] 🚫 IP Blacklisted: ${ip} - Reason: ${reason}`);
}

function unblacklistIP(ip) {
    ipBlacklist.delete(ip);
    console.log(`[SECURITY] ✅ IP Removed from blacklist: ${ip}`);
}

// ==================== BRUTE FORCE PROTECTION ====================
const loginAttempts = new Map(); // IP:email -> { attempts, lastAttempt, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function checkBruteForce(ip, email) {
    const key = `${ip}:${email || 'unknown'}`;
    const record = loginAttempts.get(key);

    if (!record) return { allowed: true, attemptsLeft: MAX_LOGIN_ATTEMPTS };

    // Check if locked
    if (record.lockedUntil && Date.now() < record.lockedUntil) {
        const remainingMs = record.lockedUntil - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);
        return {
            allowed: false,
            reason: `Account locked. Try again in ${remainingMin} minute(s)`,
            lockedUntil: record.lockedUntil
        };
    }

    // Reset if window expired
    if (Date.now() - record.lastAttempt > ATTEMPT_WINDOW_MS) {
        loginAttempts.delete(key);
        return { allowed: true, attemptsLeft: MAX_LOGIN_ATTEMPTS };
    }

    const attemptsLeft = MAX_LOGIN_ATTEMPTS - record.attempts;
    return { allowed: true, attemptsLeft };
}

function recordFailedLogin(ip, email) {
    const key = `${ip}:${email || 'unknown'}`;
    const record = loginAttempts.get(key) || { attempts: 0, lastAttempt: 0 };

    record.attempts++;
    record.lastAttempt = Date.now();

    // Lock account after max attempts
    if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
        record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        console.log(`[SECURITY] 🔒 Account locked: ${email} from IP ${ip}`);

        // Auto-blacklist IP after repeated lockouts
        const ipLockouts = getIPLockoutCount(ip);
        if (ipLockouts >= 3) {
            blacklistIP(ip, 'Multiple brute force attempts');
        }
    }

    loginAttempts.set(key, record);
    return record.attempts;
}

function clearLoginAttempts(ip, email) {
    const key = `${ip}:${email || 'unknown'}`;
    loginAttempts.delete(key);
}

// Track IP lockout count
const ipLockoutCounts = new Map();
function getIPLockoutCount(ip) {
    const count = (ipLockoutCounts.get(ip) || 0) + 1;
    ipLockoutCounts.set(ip, count);
    return count;
}

// ==================== ADVANCED RATE LIMITER ====================
const rateLimiters = new Map(); // endpoint:ip -> { count, windowStart }

const RATE_LIMITS = {
    // Strict limits for sensitive endpoints
    '/api/auth/login': { maxRequests: 10, windowMs: 60000 },   // 10 per minute
    '/api/auth/signup': { maxRequests: 5, windowMs: 60000 },   // 5 per minute
    '/api/auth/reset-admin': { maxRequests: 2, windowMs: 3600000 }, // 2 per hour

    // Moderate limits for AI endpoints
    '/api/analysis': { maxRequests: 10, windowMs: 60000 },
    '/api/products/ai-recommend': { maxRequests: 10, windowMs: 60000 },

    // Default for all other endpoints
    'default': { maxRequests: 100, windowMs: 60000 }
};

function checkRateLimit(ip, endpoint) {
    // Find matching rate limit config
    let config = RATE_LIMITS.default;
    for (const [path, limit] of Object.entries(RATE_LIMITS)) {
        if (path !== 'default' && endpoint.startsWith(path)) {
            config = limit;
            break;
        }
    }

    const key = `${endpoint}:${ip}`;
    const now = Date.now();
    const record = rateLimiters.get(key);

    if (!record || now - record.windowStart > config.windowMs) {
        rateLimiters.set(key, { count: 1, windowStart: now });
        return { allowed: true, remaining: config.maxRequests - 1 };
    }

    if (record.count >= config.maxRequests) {
        const retryAfter = Math.ceil((config.windowMs - (now - record.windowStart)) / 1000);
        return { allowed: false, retryAfter };
    }

    record.count++;
    return { allowed: true, remaining: config.maxRequests - record.count };
}

// ==================== REQUEST VALIDATOR ====================
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const SUSPICIOUS_PATTERNS = [
    /<script[\s\S]*?>[\s\S]*?<\/script>/gi,  // XSS
    /javascript:/gi,                           // JS protocol
    /on\w+\s*=/gi,                             // Event handlers
    /\$\{.*\}/g,                               // Template injection
    /\.\.\//g,                                  // Path traversal
];

function validateRequest(req) {
    const issues = [];

    // Check content length
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_BODY_SIZE) {
        issues.push('Request too large');
    }

    // Check for suspicious patterns in body
    if (req.body) {
        const bodyStr = JSON.stringify(req.body);
        for (const pattern of SUSPICIOUS_PATTERNS) {
            if (pattern.test(bodyStr)) {
                issues.push('Suspicious content detected');
                break;
            }
        }
    }

    return { valid: issues.length === 0, issues };
}

// ==================== SECURITY LOGGER ====================
const securityLogs = [];
const MAX_LOG_SIZE = 1000;

function logSecurityEvent(type, ip, details) {
    const event = {
        timestamp: new Date().toISOString(),
        type,
        ip,
        details
    };

    securityLogs.push(event);

    // Keep log size manageable
    if (securityLogs.length > MAX_LOG_SIZE) {
        securityLogs.shift();
    }

    console.log(`[SECURITY] ${type}: IP=${ip} - ${JSON.stringify(details)}`);
}

function getSecurityLogs(limit = 100) {
    return securityLogs.slice(-limit);
}

// ==================== MAIN SECURITY MIDDLEWARE ====================
function securityMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const endpoint = req.path;

    // 1. Check IP blacklist
    if (isIPBlacklisted(ip)) {
        logSecurityEvent('BLOCKED_IP', ip, { endpoint });
        return res.status(403).json({
            error: 'Access denied',
            message: 'Access denied from this address'
        });
    }

    // 2. Check rate limit
    const rateCheck = checkRateLimit(ip, endpoint);
    if (!rateCheck.allowed) {
        logSecurityEvent('RATE_LIMITED', ip, { endpoint, retryAfter: rateCheck.retryAfter });
        res.set('Retry-After', rateCheck.retryAfter);
        return res.status(429).json({
            error: 'Too many requests',
            message: 'Too many requests. Please try again later.',
            retryAfter: rateCheck.retryAfter
        });
    }

    // 3. Validate request
    const validation = validateRequest(req);
    if (!validation.valid) {
        logSecurityEvent('INVALID_REQUEST', ip, { endpoint, issues: validation.issues });
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Invalid request'
        });
    }

    // Add security helpers to request
    req.security = {
        ip,
        checkBruteForce: (email) => checkBruteForce(ip, email),
        recordFailedLogin: (email) => recordFailedLogin(ip, email),
        clearLoginAttempts: (email) => clearLoginAttempts(ip, email),
        blacklistIP: (reason) => blacklistIP(ip, reason),
        logEvent: (type, details) => logSecurityEvent(type, ip, details)
    };

    next();
}

// ==================== BRUTE FORCE MIDDLEWARE (for login) ====================
function bruteForceMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const email = req.body?.email;

    const check = checkBruteForce(ip, email);
    if (!check.allowed) {
        logSecurityEvent('BRUTE_FORCE_BLOCKED', ip, { email, reason: check.reason });
        return res.status(423).json({
            error: 'Account locked',
            message: check.reason
        });
    }

    // Warn user about remaining attempts
    if (check.attemptsLeft <= 2) {
        res.set('X-Attempts-Remaining', check.attemptsLeft);
    }

    next();
}

// ==================== ADMIN SECURITY DASHBOARD ====================
function getSecurityStats() {
    return {
        blacklistedIPs: ipBlacklist.size,
        lockedAccounts: [...loginAttempts.values()].filter(r => r.lockedUntil && Date.now() < r.lockedUntil).length,
        recentEvents: securityLogs.slice(-20),
        rateLimitersActive: rateLimiters.size
    };
}

module.exports = {
    securityMiddleware,
    bruteForceMiddleware,
    blacklistIP,
    unblacklistIP,
    isIPBlacklisted,
    checkBruteForce,
    recordFailedLogin,
    clearLoginAttempts,
    getSecurityLogs,
    getSecurityStats,
    logSecurityEvent
};
