'use strict';

const express = require('express');
const router  = express.Router();
const {
    globalTracking, liveServers, inventoryStore,
    pushAuditLog, warnStore, banStore, freezeStore
} = require('../state');
const { verifyServerApiKey, verifyAdminAccess } = require('../middleware/auth');


// ─── PLAYER JOIN ───
router.post('/join', verifyServerApiKey, (req, res) => {
    const { userId, username, jobId, serverCode } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    globalTracking[userId] = { username, jobId, serverCode, joinedAt: Date.now() };

    if (serverCode) {
        pushAuditLog(serverCode, {
            type: 'player_added',
            userId: parseInt(userId),
            username,
            jobId
        });
    }

    res.json({ success: true });
});

// ─── PLAYER LEAVE ───
router.post('/leave', verifyServerApiKey, (req, res) => {
    const { userId, username, serverCode } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const entry = globalTracking[userId];
    const duration = entry ? Math.floor((Date.now() - entry.joinedAt) / 1000) : 0;

    if (serverCode) {
        pushAuditLog(serverCode, {
            type: 'player_left',
            userId: parseInt(userId),
            username: username || entry?.username,
            duration
        });
    }

    delete globalTracking[userId];

    res.json({ success: true });
});

// ─── SHOTS FIRED ───
router.post('/shots', verifyServerApiKey, (req, res) => {
    const { serverCode, shooterName, shooterUserId, targetName, targetUserId, weapon, posX, posZ } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'shots_fired',
        shooterName, shooterUserId: parseInt(shooterUserId),
        targetName, targetUserId: parseInt(targetUserId),
        weapon, pos: { x: posX, z: posZ }
    });

    res.json({ success: true });
});

// ─── SET ROBBERY ───
router.post('/robbery', verifyServerApiKey, (req, res) => {
    const { serverCode, suspects, robberyName, robberyType, startedAt, posX, posZ } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'robbery',
        suspects, robberyName, robberyType,
        startedAt: startedAt || Date.now(),
        pos: { x: posX, z: posZ }
    });

    res.json({ success: true });
});

// ─── SET WANTED ───
router.post('/wanted', verifyServerApiKey, (req, res) => {
    const { serverCode, playerName, playerUserId, stars, reason, crimes } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'set_wanted',
        playerName, playerUserId: parseInt(playerUserId),
        stars, reason, crimes
    });

    res.json({ success: true });
});

// ─── PLAYER TEAM CHANGED ───
router.post('/teamchange', verifyServerApiKey, (req, res) => {
    const { serverCode, playerName, playerUserId, oldTeam, newTeam, xpGiven } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'team_changed',
        playerName, playerUserId: parseInt(playerUserId),
        oldTeam, newTeam, xpGiven
    });

    res.json({ success: true });
});

// ─── PHONE CALL ───
router.post('/phonecall', verifyServerApiKey, (req, res) => {
    const { serverCode, playerName, playerUserId, posX, posZ, forTeam, message } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'phone_call',
        playerName, playerUserId: parseInt(playerUserId),
        pos: { x: posX, z: posZ }, forTeam, message
    });

    res.json({ success: true });
});

// ─── PLAYER DOWN ───
router.post('/playerdown', verifyServerApiKey, (req, res) => {
    const { serverCode, playerName, playerUserId, playerTeam, killerName, killerId, weaponName, posX, posZ } = req.body;
    if (!serverCode) return res.status(400).json({ error: 'serverCode required' });

    pushAuditLog(serverCode, {
        type: 'player_down',
        playerName, playerUserId: parseInt(playerUserId), playerTeam,
        killerName, killerId: parseInt(killerId) || null,
        weaponName, pos: { x: posX, z: posZ }
    });

    res.json({ success: true });
});

// ─── SET INVENTORY ───
router.post('/inventory', verifyServerApiKey, (req, res) => {
    const { serverCode, playerName, playerUserId, inventory } = req.body;
    if (!serverCode || !playerUserId) return res.status(400).json({ error: 'serverCode and playerUserId required' });

    const key = `${serverCode}:${playerUserId}`;
    inventoryStore[key] = {
        playerName, playerUserId: parseInt(playerUserId),
        inventory: Array.isArray(inventory) ? inventory : [],
        updatedAt: Date.now()
    };

    res.json({ success: true });
});

// ─── GET INVENTORY ───
router.get('/inventory/:serverCode/:userId', verifyAdminAccess, (req, res) => {
    const { serverCode, userId } = req.params;
    const key  = `${serverCode}:${userId}`;
    const data = inventoryStore[key];
    if (!data) return res.status(404).json({ error: 'No inventory found' });
    res.json(data);
});

// ─── SEARCH USER ───
router.post('/search', verifyAdminAccess, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    try {
        const r    = await fetch('https://users.roblox.com/v1/usernames/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
        });
        const data = await r.json();
        if (!data.data?.length) return res.status(404).json({ error: 'User not found' });

        const user = data.data[0];
        const trackInfo = globalTracking[user.id];

        res.json({
            userId: user.id,
            username: user.name,
            displayName: user.displayName,
            isInGame: !!trackInfo,
            serverCode: trackInfo?.serverCode || null,
            jobId: trackInfo?.jobId || null,
            warns: (warnStore[user.id] || []).length,
            isBanned: !!banStore[user.id],
            isFrozen: !!freezeStore[user.id]
        });
    } catch {
        res.status(500).json({ error: 'Failed to search user' });
    }
});

function formatDuration(seconds) {
    if (!seconds) return '0s';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m ' : ''}${s}s`.trim();
}

module.exports = router;
