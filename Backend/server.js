'use strict';

const fs        = require('fs');
const path      = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const http         = require('http');
const cookieParser = require('cookie-parser');
const { initWebSocket } = require('./ws');

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
app.use('/api/config',      require('./routes/config'));

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
    if (req.path.startsWith('/api/') || req.path.startsWith('/oauth/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).sendFile(path.join(frontendPath, '404.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── START (HTTP + WebSocket share one server) ────────────────
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
initWebSocket(server);
server.listen(PORT, () => console.log(`Emergency Hamburg API running on port ${PORT} (HTTP + WebSocket at /ws)`));

module.exports = app;