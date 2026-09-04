'use strict';

const express = require('express');
const router  = express.Router();
const {
    serverApiKeys, apiKeyRegenCooldowns, liveServers,
    activeAdmins, commandsQueue, generateServerApiKey, pushAuditLog
} = require('../state');
const { verifyAdminAccess, verifyRobloxToken } = require('../middleware/auth');
const { SERVER_OWNERS } = require('../state');

const REGEN_COOLDOWN = 15 * 60 * 1000; // 15 minutes

/** GET current key info (masked) — owner only */
router.get('/:serverCode', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const userId = req.adminId;

    if (!SERVER_OWNERS.includes(userId)) {
        return res.status(403).json({ error: 'Owner access required' });
    }

    const keyInfo = serverApiKeys[serverCode];
    if (!keyInfo) {
        // Auto-generate on first request
        const newKey = generateServerApiKey();
        serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
        return res.json({
            maskedKey: newKey.replace(/(....-)(.+-.+)(-....)/,
                (_, a, m, z) => a + m.replace(/[a-z0-9]/g, '*') + z),
            fullKey: newKey,
            generatedAt: serverApiKeys[serverCode].generatedAt,
            cooldownUntil: null
        });
    }

    const cooldown = apiKeyRegenCooldowns[serverCode];
    const maskedKey = keyInfo.key.replace(
        /^([a-z0-9]{4}-)([a-z0-9]{4}-[a-z0-9]{4}-)([a-z0-9]{4})$/,
        (_, a, m, z) => a + m.replace(/[a-z0-9]/g, '*') + z
    );

    res.json({
        maskedKey,
        fullKey: keyInfo.key,
        generatedAt: keyInfo.generatedAt,
        cooldownUntil: cooldown && cooldown > Date.now() ? cooldown : null
    });
});

/** POST — regenerate key (owner only, 15min cooldown) */
router.post('/:serverCode/regenerate', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const userId = req.adminId;

    if (!SERVER_OWNERS.includes(userId)) {
        return res.status(403).json({ error: 'Owner access required' });
    }

    const cooldown = apiKeyRegenCooldowns[serverCode];
    if (cooldown && cooldown > Date.now()) {
        const remaining = Math.ceil((cooldown - Date.now()) / 1000);
        return res.status(429).json({ error: `Cooldown active`, remainingSeconds: remaining });
    }

    const newKey = generateServerApiKey();
    serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
    apiKeyRegenCooldowns[serverCode] = Date.now() + REGEN_COOLDOWN;

    // Notify the live Roblox server about the new key
    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'api_key_changed',
        newKey,
        issuedAt: Date.now()
    });

    // Kick all admins out of this server's dashboard
    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode) {
            admin.status        = 'Online';
            admin.serverCode    = null;
            admin.updatedAt     = new Date().toISOString();
            admin.apiKeyChanged = true;
            admin.apiKeyChangedAt = Date.now();
        }
    });

    const admin = activeAdmins[userId];
    pushAuditLog(serverCode, {
        type: 'api_key_regenerated',
        actorId: userId,
        actorUsername: admin?.username || 'Owner'
    });

    res.json({ success: true, cooldownUntil: apiKeyRegenCooldowns[serverCode] });
});

/** Roblox server calls this to validate its API key */
router.post('/:serverCode/validate', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { apiKey } = req.body;

    const stored = serverApiKeys[serverCode];
    if (!stored) {
        // First time — auto-register
        serverApiKeys[serverCode] = { key: apiKey, generatedAt: Date.now() };
        return res.json({ valid: true });
    }

    res.json({ valid: stored.key === apiKey });
});

module.exports = router;
