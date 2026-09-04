'use strict';

const { ALLOWED_ADMINS, INGAME_MODS, SERVER_OWNERS, activeAdmins, liveServers } = require('../state');

/** Verify Bearer token from Roblox server */
function verifyRobloxToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${process.env.ApiToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

/** Verify that the caller is a known admin via userId in body/query */
function verifyAdminAccess(req, res, next) {
    const userId = parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
    if (!userId || isNaN(userId)) {
        return res.status(403).json({ error: 'Admin ID required' });
    }
    if (!ALLOWED_ADMINS.includes(userId) && !INGAME_MODS.includes(userId) && !SERVER_OWNERS.includes(userId)) {
        return res.status(403).json({ error: 'Unauthorized access' });
    }
    req.adminId = userId;
    next();
}

/** Verify server owner only */
function verifyOwnerAccess(req, res, next) {
    const userId = parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
    if (!userId || !SERVER_OWNERS.includes(userId)) {
        return res.status(403).json({ error: 'Owner access required' });
    }
    req.adminId = userId;
    next();
}

/** Verify the admin is on duty in the target server */
function verifyOnDuty(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }
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

/** Clean up rate limit entries older than 30s */
setInterval(() => {
    const now = Date.now();
    Object.keys(rateLimits).forEach(ip => {
        rateLimits[ip] = rateLimits[ip].filter(t => now - t < 30000);
        if (rateLimits[ip].length === 0) delete rateLimits[ip];
    });
}, 30000);

/** Determine role for a userId */
function getUserRole(userId) {
    const id = parseInt(userId);
    if (SERVER_OWNERS.includes(id)) return 'owner';
    if (ALLOWED_ADMINS.includes(id)) return 'admin';
    if (INGAME_MODS.includes(id)) return 'mod';
    return 'user';
}

module.exports = {
    verifyRobloxToken,
    verifyAdminAccess,
    verifyOwnerAccess,
    verifyOnDuty,
    smartRateLimiter,
    getUserRole
};
