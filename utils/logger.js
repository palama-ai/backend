/**
 * 📊 Winston Logger - Centralized Logging System
 * Logs all events to console and files
 */

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
};

const getCurrentTimestamp = () => {
    return new Date().toISOString();
};

// In-memory log storage (for serverless environments like Vercel)
const logs = {
    error: [],
    warn: [],
    info: [],
    http: [],
    security: []
};

const MAX_LOG_ENTRIES = 500;

function addLog(level, message, meta = {}) {
    const entry = {
        timestamp: getCurrentTimestamp(),
        level,
        message,
        ...meta
    };

    // Console output with colors
    const colors = {
        error: '\x1b[31m',   // Red
        warn: '\x1b[33m',    // Yellow
        info: '\x1b[36m',    // Cyan
        http: '\x1b[35m',    // Magenta
        debug: '\x1b[37m',   // White
        security: '\x1b[31m' // Red
    };
    const reset = '\x1b[0m';

    console.log(`${colors[level] || ''}[${entry.timestamp}] [${level.toUpperCase()}] ${message}${reset}`, meta.details ? JSON.stringify(meta.details) : '');

    // Store in memory
    if (!logs[level]) logs[level] = [];
    logs[level].push(entry);

    // Keep log size manageable
    if (logs[level].length > MAX_LOG_ENTRIES) {
        logs[level].shift();
    }
}

const logger = {
    error: (message, meta) => addLog('error', message, meta),
    warn: (message, meta) => addLog('warn', message, meta),
    info: (message, meta) => addLog('info', message, meta),
    http: (message, meta) => addLog('http', message, meta),
    debug: (message, meta) => addLog('debug', message, meta),
    security: (message, meta) => addLog('security', message, meta),

    // Get logs for admin dashboard
    getLogs: (level, limit = 100) => {
        if (level && logs[level]) {
            return logs[level].slice(-limit);
        }
        // Return all logs merged
        const all = [];
        for (const lvl of Object.keys(logs)) {
            all.push(...logs[lvl]);
        }
        return all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
    },

    // Clear logs
    clear: (level) => {
        if (level && logs[level]) {
            logs[level] = [];
        } else {
            for (const lvl of Object.keys(logs)) {
                logs[lvl] = [];
            }
        }
    }
};

// HTTP request logger middleware
function httpLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - start;
        const logLevel = res.statusCode >= 400 ? 'warn' : 'http';

        logger[logLevel](`${req.method} ${req.path}`, {
            details: {
                status: res.statusCode,
                duration: `${duration}ms`,
                ip: req.ip || req.connection?.remoteAddress
            }
        });
    });

    next();
}

module.exports = { logger, httpLogger };
