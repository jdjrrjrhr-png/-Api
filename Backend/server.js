'use strict';

const fs      = require('fs');
const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const cookieParser = require('cookie-parser');

const app = express();

// ─── SHARED CONFIG ─────────────────────────────────────────────
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

const imgPath = path.join(__dirname, '..', 'img');
app.use('/img', express.static(imgPath));

app.get('/config.json', (req, res) => res.json(appConfig));

// ─── ROUTES & ROUTERS ─────────────────────────────────────────
const authRouter    = require('./routes/auth');
const serversRouter = require('./routes/servers');

app.use('/oauth',           authRouter);
app.use('/api/auth',        authRouter);
app.use('/api/servers',     serversRouter);
app.use('/api/punishments', require('./routes/punishments'));
app.use('/api/tracking',    require('./routes/tracking'));
app.use('/api/audit',       require('./routes/audit'));
app.use('/api/serverkeys',  require('./routes/serverkeys'));

// Duty + staff legacy aliases
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

// ─── SPA FALLBACK ─────────────────────────────────────────────
app.get(/^\/Api/i, (req, res) => {
    res.sendFile(path.join(frontendPath, 'Api', 'index.html'));
});

app.get('/', (req, res) => {
    res.redirect('/Api');
});

// ─── 404 HANDLER ──────────────────────────────────────────────
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