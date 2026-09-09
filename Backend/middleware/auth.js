'use strict';

const { getServerRole } = require('../state');

/** Verify Bearer token from Roblox server — the shared secret (`ApiToken`).
 *  This is completely separate from the per-server API key/serverCode. */
function verifyRobloxToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${process.env.ApiToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function extractServerCode(req) {
    return req.params.serverCode || req.body?.serverCode || req.query?.serverCode;
}

function extractCallerId(req) {
    return parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
}

/** Just requires a numeric caller id — used for endpoints not scoped to one
 *  specific server (e.g. "list the servers I moderate"). Permission per
 *  server is checked inside the handler itself where relevant. */
function verifyLoggedIn(req, res, next) {
    const userId = extractCallerId(req);
    if (!userId || isNaN(userId)) {
        return res.status(403).json({ error: 'Login required' });
    }
    req.callerId = userId;
    next();
}

/** Requires admin OR owner role for the target server. Role is resolved
 *  live from serverAdmins/serverOwners — there is no static list. */
function verifyServerAdmin(req, res, next) {
    const serverCode = extractServerCode(req);
    const userId = extractCallerId(req);

    if (!userId || isNaN(userId)) return res.status(403).json({ error: 'Login required' });
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    const role = getServerRole(serverCode, userId);
    if (!role) return res.status(403).json({ error: 'You are not staff on this server' });

    req.callerId = userId;
    req.adminId = userId; // backward-compat alias
    req.serverRole = role;
    next();
}

/** Requires owner role specifically for the target server */
function verifyServerOwner(req, res, next) {
    const serverCode = extractServerCode(req);
    const userId = extractCallerId(req);

    if (!userId || isNaN(userId)) return res.status(403).json({ error: 'Login required' });
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    const role = getServerRole(serverCode, userId);
    if (role !== 'owner') return res.status(403).json({ error: 'Owner access required' });

    req.callerId = userId;
    req.adminId = userId;
    req.serverRole = role;
    next();
}

/** Rate limiter: 45 requests per 10 seconds per IP */
const rateLimits = {};
function smartRateLimiter(req, res, next) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const now = Date.now();
    if (!rateLimits[ip]) rateLimits[ip] = [];
    rateLimits[ip] = rateLimits[ip].filter(t => now - t < 10000);
    if (rateLimits[ip].length > 45) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    rateLimits[ip].push(now);
    next();
}

setInterval(() => {
    const now = Date.now();
    Object.keys(rateLimits).forEach(ip => {
        rateLimits[ip] = rateLimits[ip].filter(t => now - t < 30000);
        if (rateLimits[ip].length === 0) delete rateLimits[ip];
    });
}, 30000);

module.exports = {
    verifyRobloxToken,
    verifyLoggedIn,
    verifyServerAdmin,
    verifyServerOwner,
    smartRateLimiter
};
