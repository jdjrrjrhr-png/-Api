'use strict';

const { adminRoster, serverStaff, activeAdmins, liveServers, serverApiKeys, apiKeyGrace } = require('../state');

/** Legacy static token — kept only for any not-yet-migrated internal call.
 *  Every Roblox-facing, per-server route should use verifyServerApiKey instead. */
function verifyRobloxToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${process.env.ApiToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

/**
 * Verify the caller is the live Roblox server for THIS serverCode, using that
 * server's own rotating API key (not a single shared secret for every server).
 *
 * - First contact for a serverCode with no stored key yet -> bootstraps (registers
 *   whatever key is presented as the server's key). This lets a fresh server or the
 *   Roblox-side Init command register its own generated key on first run.
 * - If the key was just rotated (owner regenerated it from the dashboard, or the
 *   Roblox module itself rotated it via /rotate-key), the OLD key still validates
 *   for a short grace window so an in-flight heartbeat cycle doesn't 401 and spiral
 *   into retries/disconnects.
 */
function verifyServerApiKey(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    const authHeader = req.headers['authorization'] || '';
    const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!presented) return res.status(401).json({ error: 'Unauthorized' });

    const stored = serverApiKeys[serverCode];
    if (!stored) {
        // First time we've ever heard from this server code — bootstrap its key.
        serverApiKeys[serverCode] = { key: presented, generatedAt: Date.now() };
        req.serverCode = serverCode;
        return next();
    }

    if (presented === stored.key) {
        req.serverCode = serverCode;
        return next();
    }

    const grace = apiKeyGrace[serverCode];
    if (grace && grace.previousKey === presented && grace.expiresAt > Date.now()) {
        req.serverCode = serverCode;
        return next();
    }

    return res.status(401).json({ error: 'Invalid or outdated API key' });
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

    const isGlobalAdmin = adminRoster.globalAdmins.has(userId);
    const isAnyOwner = Object.values(serverStaff).some(s => s.ownerId === userId);
    const isAnyMod   = Object.values(serverStaff).some(s => s.mods.has(userId));

    if (!isGlobalAdmin && !isAnyOwner && !isAnyMod) {
        return res.status(403).json({ error: 'Unauthorized access' });
    }
    req.adminId = userId;
    next();
}

/** Verify server owner only — scoped to the serverCode in the request */
function verifyOwnerAccess(req, res, next) {
    const serverCode = req.params.serverCode || req.body?.serverCode;
    const userId = parseInt(
        req.body?.senderId || req.body?.userId ||
        req.query?.senderId || req.query?.userId
    );
    const staff = serverCode ? serverStaff[serverCode] : null;
    if (!userId || !staff || staff.ownerId !== userId) {
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

/** Determine role for a userId. Pass serverCode to resolve server-scoped owner/mod correctly. */
function getUserRole(userId, serverCode) {
    const id = parseInt(userId);

    if (serverCode) {
        const staff = serverStaff[serverCode];
        if (staff && staff.ownerId === id) return 'owner';
        if (staff && staff.mods.has(id)) return 'mod';
    }

    if (Object.values(serverStaff).some(s => s.ownerId === id)) return 'owner';
    if (adminRoster.globalAdmins.has(id)) return 'admin';
    if (Object.values(serverStaff).some(s => s.mods.has(id))) return 'mod';
    return 'user';
}

module.exports = {
    verifyRobloxToken,
    verifyServerApiKey,
    verifyAdminAccess,
    verifyOwnerAccess,
    verifyOnDuty,
    smartRateLimiter,
    getUserRole
};
