'use strict';

const fs      = require('fs');
const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const cookieParser = require('cookie-parser');

const app = express();

// ─── SHARED CONFIG (config.json is the single source of truth — nothing here
// should re-declare its own copy of map bounds / intervals / limits) ───
let appConfig = {};
try {
    appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
} catch (e) {
    console.error('Failed to load config.json — falling back to defaults:', e.message);
}
app.locals.config = appConfig;

// ─── MIDDLEWARE ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
});

// ─── STATIC FILES ─────────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.use(express.static(frontendPath));

// Serve map image / location icons
const imgPath = path.join(__dirname, '..', 'img');
app.use('/img', express.static(imgPath));

// Expose shared config to the frontend without duplicating it in JS
app.get('/config.json', (req, res) => res.json(appConfig));

// ─── ROUTES ───────────────────────────────────────────────────
<<<<<<< HEAD
app.use('/oauth',             require('./routes/auth'));
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/servers',       require('./routes/servers'));
app.use('/api/punishments',   require('./routes/punishments'));
app.use('/api/tracking',      require('./routes/tracking'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/serverkeys',    require('./routes/serverkeys'));

// Duty + staff (mounted on /api/admin for backwards compat)
const serversRouter = require('./routes/servers');
app.post('/api/admin/duty',         serversRouter);
app.get('/api/admin/staff',         serversRouter);
app.post('/api/admin/disconnect',   require('./routes/auth'));
=======
const authRouter    = require('./routes/auth');
const serversRouter  = require('./routes/servers');

app.use('/oauth',             authRouter);
app.use('/api/auth',          authRouter);
app.use('/api/servers',       serversRouter);
app.use('/api/punishments',   require('./routes/punishments'));
app.use('/api/tracking',      require('./routes/tracking'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/serverkeys',    require('./routes/serverkeys'));

// Duty + staff legacy aliases the dashboard frontend actually calls.
// (Previously these mounted the WHOLE sub-router as a single-route handler,
// which never matched anything internally since req.url wasn't rewritten —
// they were silently dead. Rewriting req.url before handing off to the real
// router fixes that.)
app.post('/api/admin/duty', (req, res, next) => {
    req.url = '/duty';
    serversRouter.handle(req, res, next);
});
app.get('/api/admin/staff', (req, res, next) => {
    req.url = '/staff';
    serversRouter.handle(req, res, next);
});
app.post('/api/admin/disconnect', (req, res, next) => {
    req.url = '/disconnect';
    authRouter.handle(req, res, next);
});
>>>>>>> 501d14fad6ebeba281d4fbd01648110ed25e3981

// ─── SPA FALLBACK ─────────────────────────────────────────────
// Serve index.html for all /Api/* routes (client-side routing)
<<<<<<< HEAD
app.get('/Api*', (req, res) => {
=======
app.get(/^\/Api/i, (req, res) => {
>>>>>>> 501d14fad6ebeba281d4fbd01648110ed25e3981
    res.sendFile(path.join(frontendPath, 'Api', 'index.html'));
});

// Root with no path at all -> send people to the docs/dashboard entry point
// instead of Express's bare "Cannot GET /".
app.get('/', (req, res) => {
    res.redirect('/Api');
});

// ─── 404 (any route we don't recognize) ────────────────────────
app.use((req, res) => {
    res.status(404).type('html').send(notFoundPage());
});

function notFoundPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>404 — Not Found</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html,body{height:100%;margin:0;}
  body{
    display:flex;align-items:center;justify-content:center;
    background:#0d1117;color:#e6edf3;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  }
  .box{text-align:center;padding:40px;}
  h1{font-size:88px;margin:0;color:#3b82f6;}
  p{font-size:18px;color:#8b949e;margin:8px 0 28px;}
  a{
    display:inline-block;padding:12px 26px;border-radius:8px;
    background:rgba(59,130,246,0.12);color:#60a5fa;
    text-decoration:none;font-weight:600;font-size:15px;
    border:1px solid rgba(59,130,246,0.35);
    transition:background .15s ease;
  }
  a:hover{background:rgba(59,130,246,0.22);}
</style>
</head>
<body>
  <div class="box">
    <h1>404</h1>
    <p>Error code 404 — this page doesn't exist.</p>
    <a href="/Api">Go to the official page</a>
  </div>
</body>
</html>`;
}

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Emergency Hamburg API running on port ${PORT}`));

module.exports = app;
