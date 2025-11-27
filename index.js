// Load environment variables from project .env for local development.
// If the server is started from the `backend` folder, prefer loading the
// `.env` file from the project root so keys placed there are picked up.
const path = require('path');
try {
  const fs = require('fs');
  const dotenv = require('dotenv');
  const backendEnv = path.join(__dirname, '.env');
  const rootEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(backendEnv)) {
    dotenv.config({ path: backendEnv });
  } else if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
  } else {
    // fallback to default behavior
    dotenv.config();
  }
} catch (e) { /* dotenv optional */ }

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

const PORT = process.env.PORT || 4000;

const app = express();
app.use(cors());
// simple request logger to aid debugging
app.use((req, res, next) => {
  try { console.log('[backend] incoming request', req.method, req.originalUrl); } catch (e) {}
  next();
});
// Increase JSON body limit to allow base64 image uploads from the frontend
app.use(bodyParser({ limit: '12mb' }));

// Debug: show whether critical API keys are present (do NOT log their values)
try {
  console.log('[backend] OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
  console.log('[backend] GEMINI_API_KEY present:', !!process.env.GEMINI_API_KEY);
  console.log('[backend] GOOGLE_VISION_API_KEY present:', !!process.env.GOOGLE_VISION_API_KEY);
} catch (e) {}

init();

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

// Serve uploaded reports as static files
app.use('/reports', express.static(path.join(__dirname, 'uploads', 'reports')));

app.get('/', (req, res) => res.json({ ok: true, msg: 'GlowMatch backend running' }));

app.listen(PORT, () => {
  console.log(`GlowMatch backend listening on http://localhost:${PORT}`);
});
