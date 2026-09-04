'use strict';

const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express      = require('express');
const cookieParser = require('cookie-parser');

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

// Serve map image
const imgPath = path.join(__dirname, '..', 'img');
app.use('/img', express.static(imgPath));

// ─── ROUTES ───────────────────────────────────────────────────
app.use('/oauth',           require('./routes/auth'));
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/servers',     require('./routes/servers'));
app.use('/api/punishments', require('./routes/punishments'));
app.use('/api/tracking',    require('./routes/tracking'));
app.use('/api/audit',       require('./routes/audit'));
app.use('/api/serverkeys',  require('./routes/serverkeys'));

// Duty + staff (mounted on /api/admin for backwards compat)
app.use('/api/admin',       require('./routes/servers'));
app.post('/api/admin/disconnect', require('./routes/auth'));

// ─── SPA FALLBACK ─────────────────────────────────────────────
// Serve index.html for all /Api/* or /api/* routes (client-side routing)
// ─── SPA FALLBACK ─────────────────────────────────────────────
// Serve index.html for all /Api/* routes (client-side routing)
// ─── SPA FALLBACK ─────────────────────────────────────────────
// Serve index.html for all /Api routes (client-side routing)
app.get(/^\/Api/i, (req, res) => {
    res.sendFile(path.join(frontendPath, 'Api', 'index.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Emergency Hamburg API running on port ${PORT}`));

module.exports = app;