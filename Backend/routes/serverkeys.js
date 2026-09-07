'use strict';

const express = require('express');
const router  = express.Router();
const {
    serverApiKeys, apiKeyGrace, apiKeyRegenCooldowns, liveServers,
    activeAdmins, commandsQueue, generateServerApiKey, pushAuditLog
} = require('../state');
const { verifyAdminAccess, verifyOwnerAccess, verifyServerApiKey } = require('../middleware/auth');

const REGEN_COOLDOWN = 15 * 60 * 1000; // 15 minutes
const ROTATION_GRACE_MS = 60 * 1000;   // old key still accepted for 60s after a rotation

/** GET current key info (masked) — owner only */
router.get('/:serverCode', verifyOwnerAccess, (req, res) => {
    const { serverCode } = req.params;

    const keyInfo = serverApiKeys[serverCode];
    if (!keyInfo) {
        const newKey = generateServerApiKey();
        serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
        return res.json({
            maskedKey: maskKey(newKey),
            fullKey: newKey,
            generatedAt: serverApiKeys[serverCode].generatedAt,
            cooldownUntil: null
        });
    }

    const cooldown = apiKeyRegenCooldowns[serverCode];
    res.json({
        maskedKey: maskKey(keyInfo.key),
        fullKey: keyInfo.key,
        generatedAt: keyInfo.generatedAt,
        cooldownUntil: cooldown && cooldown > Date.now() ? cooldown : null
    });
});

function maskKey(key) {
    // Mask every segment except the first and last, whatever the segment count.
    const parts = key.split('-');
    if (parts.length < 3) return key.replace(/./g, '*');
    return parts.map((p, i) => (i === 0 || i === parts.length - 1) ? p : p.replace(/./g, '*')).join('-');
}

/** POST — regenerate key from the dashboard (owner only, 15min cooldown).
 *  The old key keeps working for a short grace window so the live Roblox server's
 *  current heartbeat cycle doesn't 401 before it picks up the new key. */
router.post('/:serverCode/regenerate', verifyOwnerAccess, (req, res) => {
    const { serverCode } = req.params;
    const userId = req.adminId;

    const cooldown = apiKeyRegenCooldowns[serverCode];
    if (cooldown && cooldown > Date.now()) {
        const remaining = Math.ceil((cooldown - Date.now()) / 1000);
        return res.status(429).json({ error: `Cooldown active`, remainingSeconds: remaining });
    }

    const oldKey = serverApiKeys[serverCode]?.key || null;
    const newKey = generateServerApiKey();
    serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
    apiKeyRegenCooldowns[serverCode] = Date.now() + REGEN_COOLDOWN;

    if (oldKey) {
        apiKeyGrace[serverCode] = { previousKey: oldKey, expiresAt: Date.now() + ROTATION_GRACE_MS };
    }

    // Tell the live Roblox server about the new key so it can update immediately
    // instead of waiting to get 401'd.
    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'api_key_changed',
        newKey,
        issuedAt: Date.now()
    });

    const admin = activeAdmins[userId];
    pushAuditLog(serverCode, {
        type: 'api_key_regenerated',
        actorId: userId,
        actorUsername: admin?.username || 'Owner'
    });

    res.json({ success: true, cooldownUntil: apiKeyRegenCooldowns[serverCode] });
});

/** POST — Roblox module rotates its own key (e.g. dev changed it manually in Studio,
 *  or this is the server's first-ever run and it's registering its generated key).
 *  body: { oldKey, newKey } — oldKey may equal newKey (no-op confirmation), and may
 *  be omitted only on first-ever registration for a serverCode. */
router.post('/:serverCode/rotate-key', (req, res) => {
    const { serverCode } = req.params;
    const { oldKey, newKey } = req.body;
    if (!newKey) return res.status(400).json({ error: 'newKey required' });

    const stored = serverApiKeys[serverCode];
    if (!stored) {
        serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
        return res.json({ success: true, registered: true });
    }

    if (stored.key !== oldKey) {
        return res.status(401).json({ error: 'oldKey does not match the current stored key' });
    }

    if (oldKey !== newKey) {
        apiKeyGrace[serverCode] = { previousKey: stored.key, expiresAt: Date.now() + ROTATION_GRACE_MS };
        serverApiKeys[serverCode] = { key: newKey, generatedAt: Date.now() };
        pushAuditLog(serverCode, { type: 'api_key_rotated', source: 'roblox' });
    }

    res.json({ success: true });
});

module.exports = router;
