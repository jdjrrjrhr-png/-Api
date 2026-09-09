'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const http         = require('http');
const cookieParser = require('cookie-parser');
const { initWebSocket } = require('./ws');

const app = express();

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

// ─── ROUTES ───────────────────────────────────────────────────
// NOTE: previously /api/admin/duty and /api/admin/staff were mounted by
// passing the servers router directly into app.post()/app.get() as a
// bare middleware — that never actually matched (a sub-router needs
// app.use(prefix, router) to have its internal routes reachable). This
// was the real cause of "Staff Status stuck on Loading forever": every
// call to those two endpoints silently fell through to a 404. Duty and
// staff endpoints now live properly under /api/servers/* below.
app.use('/oauth',           require('./routes/auth'));
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/servers',     require('./routes/servers'));
app.use('/api/punishments', require('./routes/punishments'));
app.use('/api/tracking',    require('./routes/tracking'));
app.use('/api/audit',       require('./routes/audit'));
app.use('/api/serverkeys',  require('./routes/serverkeys'));
app.use('/api/config',      require('./routes/config'));

// ─── SPA FALLBACK ─────────────────────────────────────────────
app.get(/^\/Api/i, (req, res) => {
    res.sendFile(path.join(frontendPath, 'Api', 'index.html'));
});

// ─── 404 ──────────────────────────────────────────────────────
// Any route outside /Api and outside the API surface gets a friendly
// page pointing back to /Api instead of Express's bare "Cannot GET /".
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
