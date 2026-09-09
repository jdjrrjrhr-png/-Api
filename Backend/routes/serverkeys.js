'use strict';

const express = require('express');
const router  = express.Router();
const {
    liveServers, serverMeta, activeAdmins, commandsQueue,
    apiKeyRegenCooldowns, generateServerApiKey, maskApiKey, pushAuditLog
} = require('../state');
const { verifyServerOwner } = require('../middleware/auth');
const { getConfig } = require('../config');
const { broadcastEvent } = require('../ws');

/**
 * IMPORTANT: the server's API key IS its serverCode — there is no second,
 * separate "key" hiding behind it. This is deliberately distinct from the
 * `ApiToken` (the shared secret in .env used for every Roblox->API call);
 * that token never appears in any dashboard response, ever. This panel is
 * the ONLY place the full key is ever returned — every other endpoint
 * that mentions a server returns `maskedServerCode` instead.
 */

router.get('/:serverCode', verifyServerOwner, (req, res) => {
    const { serverCode } = req.params;
    const cooldown = apiKeyRegenCooldowns[serverCode];

    res.json({
        maskedKey: maskApiKey(serverCode),
        fullKey: serverCode,
        generatedAt: serverMeta[serverCode]?.keyGeneratedAt || liveServers[serverCode]?.startTime || Date.now(),
        cooldownUntil: cooldown && cooldown > Date.now() ? cooldown : null
    });
});

/** Dashboard-initiated rotation. This only PROPOSES the new key by queuing
 *  a command — the Roblox server must call POST /api/servers/setkey to
 *  actually confirm and complete the rotation on its side (persisting the
 *  new key to its own DataStore). Active dashboard viewers are evicted
 *  immediately so nobody keeps acting under the soon-to-be-invalid code. */
router.post('/:serverCode/regenerate', verifyServerOwner, (req, res) => {
    const { serverCode } = req.params;
    const cfg = getConfig();
    const cooldownMs = (cfg.serverCodeRegenerateCooldown || 900) * 1000;

    const cooldown = apiKeyRegenCooldowns[serverCode];
    if (cooldown && cooldown > Date.now()) {
        return res.status(429).json({ error: 'Cooldown active', remainingSeconds: Math.ceil((cooldown - Date.now()) / 1000) });
    }

    const newKey = generateServerApiKey();
    apiKeyRegenCooldowns[serverCode] = Date.now() + cooldownMs;

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({ action: 'api_key_changed', oldKey: serverCode, newKey, issuedAt: Date.now() });

    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode) {
            admin.status = 'Online';
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
            admin.apiKeyChanged = true;
            admin.apiKeyChangedAt = Date.now();
        }
    });
    broadcastEvent(serverCode, 'api_key_changed', { newKey });

    pushAuditLog(serverCode, {
        type: 'command', commandType: 'api_key_regenerated',
        actorId: req.callerId, actorUsername: req.body.username || 'Owner'
    });

    res.json({ success: true, cooldownUntil: apiKeyRegenCooldowns[serverCode] });
});

module.exports = router;
