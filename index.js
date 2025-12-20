// Load environment variables from project .env for local development.
// If the server is started from the `backend` folder, prefer loading the
// `.env` file from the project root so keys placed there are picked up.
const path = require('path');
const fs = require('fs');
try {
  const dotenv = require('dotenv');
  const backendEnv = path.join(__dirname, '.env');
  const rootEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(backendEnv)) {
    console.log('[backend] Loading .env from backend folder');
    dotenv.config({ path: backendEnv });
  } else if (fs.existsSync(rootEnv)) {
    console.log('[backend] Loading .env from root folder');
    dotenv.config({ path: rootEnv });
  } else {
    console.log('[backend] No specific .env found, using default');
    dotenv.config();
  }
} catch (e) { console.error('[backend] Error loading .env:', e); }

const express = require('express');
const cors = require('cors');
const bodyParser = require('express').json;
const { init } = require('./db');
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const quizRoutes = require('./routes/quiz');
const subscriptionRoutes = require('./routes/subscription');
const analysisRoutes = require('./routes/analysis');
const reportRoutes = require('./routes/report');
const adminRoutes = require('./routes/admin');
const blogsRoutes = require('./routes/blogs');
const eventsRoutes = require('./routes/events');
const contactRoutes = require('./routes/contact');
const referralsRoutes = require('./routes/referrals');
const notificationsRoutes = require('./routes/notifications');
const sellerRoutes = require('./routes/seller');
const productsRoutes = require('./routes/products');

// 🛡️ SECURITY: Import defense system middleware
const { securityMiddleware, getSecurityStats, getSecurityLogs } = require('./middleware/security');

const PORT = process.env.PORT || 4000;

const app = express();

// Configure CORS properly
const allowedOrigins = [
  process.env.FRONTEND_URL || 'https://glowimatch.vercel.app',
  'https://glowimatch.vercel.app',
];

// SECURITY: Log requests with null origin but don't block (mobile apps, health checks need this)
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: function (origin, callback) {
    // Allow null origin (from mobile apps, server-to-server, Postman, health checks)
    if (!origin) {
      if (IS_PRODUCTION) {
        // Just log for monitoring, don't block
        console.log('[CORS] Request with null origin (mobile/server/health check)');
      }
      return callback(null, true);
    }

    // Allow listed origins
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Log blocked origins for debugging
      console.warn('[CORS] Blocked origin:', origin);
      callback(new Error('CORS not allowed'));
    }
  },
  credentials: true
}));

// SECURITY: Add basic security headers
app.use((req, res, next) => {
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  // XSS protection (for older browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// SECURITY: Basic rate limiting for auth endpoints
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_AUTH_ATTEMPTS = 10; // Max attempts per window

function checkRateLimit(key, maxAttempts = MAX_AUTH_ATTEMPTS) {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { startTime: now, count: 1 });
    return true;
  }

  if (record.count >= maxAttempts) {
    return false;
  }

  record.count++;
  return true;
}

// Rate limit middleware for auth endpoints
app.use('/api/auth', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const key = `auth:${ip}`;

  if (!checkRateLimit(key)) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000 / 60) + ' minutes'
    });
  }
  next();
});

// simple request logger to aid debugging
app.use((req, res, next) => {
  try { console.log('[backend] incoming request', req.method, req.originalUrl); } catch (e) { }
  next();
});
// Increase JSON body limit to allow base64 image uploads from the frontend
app.use(bodyParser({ limit: '12mb' }));

// 🛡️ SECURITY: Apply global security middleware (IP filter, rate limit, validation)
app.use(securityMiddleware);

// Debug: show whether critical API keys are present (do NOT log their values)
try {
  console.log('[backend] OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
  console.log('[backend] GEMINI_API_KEY present:', !!process.env.GEMINI_API_KEY);
  console.log('[backend] GOOGLE_VISION_API_KEY present:', !!process.env.GOOGLE_VISION_API_KEY);
} catch (e) { }

// Initialize database asynchronously on first request (Vercel serverless compatibility)
let dbReady = false;
let dbInitializing = false;
let dbInitPromise = null;

function ensureDbInitialized() {
  if (dbReady) return Promise.resolve();
  if (dbInitializing) return dbInitPromise;

  dbInitializing = true;
  dbInitPromise = init()
    .then(() => {
      dbReady = true;
      console.log('[backend] Database initialized successfully');
    })
    .catch(err => {
      console.error('[backend] Database initialization failed:', err);
      dbInitializing = false;
      dbInitPromise = null;
      throw err;
    });

  return dbInitPromise;
}

// Middleware to ensure DB is initialized before handling requests
app.use(async (req, res, next) => {
  // Routes that don't need DB initialization
  const skipDbInit = ['/api', '/__routes', '/favicon.ico'];
  const isSkipPath = skipDbInit.some(path => req.path === path || req.path.startsWith(path + '/'));

  // Also skip health check endpoint
  if (isSkipPath || req.path === '/api/health') {
    return next();
  }

  // For /api/* endpoints, always ensure DB is initialized
  if (req.path.startsWith('/api/')) {
    try {
      await ensureDbInitialized();
      return next();
    } catch (err) {
      console.error('[backend] DB initialization error during request:', err);

      // Check if this is a DATABASE_URL missing error
      const isDatabaseUrlMissing = err.message && err.message.includes('DATABASE_URL');

      if (isDatabaseUrlMissing) {
        return res.status(503).json({
          error: 'Database configuration missing',
          message: 'DATABASE_URL environment variable is not set in Vercel project settings.',
          help: 'Go to Vercel Dashboard > Project Settings > Environment Variables and add DATABASE_URL',
          details: err.message
        });
      }

      return res.status(503).json({
        error: 'Database not ready',
        message: 'The database is still initializing. Please try again in a moment.',
        details: err.message
      });
    }
  }

  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/subscription', subscriptionRoutes);
app.use('/api/analysis', analysisRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/blogs', blogsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/referrals', referralsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/products', productsRoutes);

// Basic API root - helpful for health checks and to avoid "Cannot GET /api" responses
app.get('/api', (req, res) => {
  try {
    res.json({
      ok: true,
      message: 'GlowMatch API',
      routes: '/__routes',
      db_ready: dbReady,
      db_initializing: dbInitializing,
      database_url_present: !!process.env.DATABASE_URL
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// debug: list registered routes for quick inspection
app.get('/__routes', (req, res) => {
  try {
    const routes = [];
    (app._router && app._router.stack || []).forEach(mw => {
      // middleware entries without a route are often present; ignore them
      if (!mw || !mw.route) return;
      const methodsObj = mw.route.methods || {};
      const methods = Object.keys(methodsObj).map(m => m.toUpperCase()).join(',');
      routes.push({ path: mw.route.path || mw.route?.stack?.[0]?.route?.path || '', methods });
    });
    res.json({ data: routes });
  } catch (e) {
    // safe stringify for unknown thrown values (could be undefined)
    const msg = (e && (e.message || e.stack)) ? (e.message || e.stack) : String(e);
    res.status(500).json({ error: msg });
  }
});

// Health check with detailed database status
app.get('/api/health', (req, res) => {
  try {
    const dbUrl = process.env.DATABASE_URL;
    const hasDbUrl = !!dbUrl;
    const dbUrlMasked = hasDbUrl ? dbUrl.substring(0, 20) + '...' : 'NOT SET';

    res.json({
      status: dbReady ? 'healthy' : 'initializing',
      db_ready: dbReady,
      db_initializing: dbInitializing,
      database_url_present: hasDbUrl,
      database_url_preview: dbUrlMasked,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: String(e) });
  }
});

// Serve favicon
const faviconPath = path.join(__dirname, '../public/favicon.ico');
if (fs.existsSync(faviconPath)) {
  app.get('/favicon.ico', (req, res) => {
    res.sendFile(faviconPath);
  });
} else {
  // Fallback: serve a 1x1 transparent pixel favicon
  app.get('/favicon.ico', (req, res) => {
    res.set('Content-Type', 'image/x-icon');
    res.send(Buffer.from('AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'base64'));
  });
}

// Serve uploaded reports as static files
app.use('/reports', express.static(path.join(__dirname, 'uploads', 'reports')));

// Serve static files from the React app build directory
const buildPath = path.join(__dirname, '../build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  // Catch-all route for SPA - MUST use app.use() not app.get('*') in Express v5
  app.use((req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => res.json({ ok: true, msg: 'GlowMatch backend running' }));
}

// Only start the server if running directly (not imported)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GlowMatch backend listening on port ${PORT}`);
  });
}

module.exports = app;
