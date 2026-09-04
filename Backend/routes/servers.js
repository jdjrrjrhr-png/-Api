'use strict';

const express = require('express');
const router  = express.Router();
const {
    liveServers, commandsQueue, scheduledShutdowns,
    activeAdmins, serverMeta, auditLogs, sessionChat,
    serverLocations, getOrInitServer, pushAuditLog
} = require('../state');
const { verifyRobloxToken, verifyAdminAccess, verifyOnDuty, smartRateLimiter, getUserRole } = require('../middleware/auth');
const { ALLOWED_ADMINS, INGAME_MODS, SERVER_OWNERS } = require('../state');

/** ─── HEARTBEAT (from Roblox server) ─── */
router.post('/:serverCode/heartbeat', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { playersList, serverName, joinCode } = req.body;

    const server = getOrInitServer(serverCode);

    // Update metadata if provided
    if (serverName && serverName !== server.serverName) {
        server.serverName = serverName;
        if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
        serverMeta[serverCode].name = serverName;
    }
    if (joinCode && joinCode !== server.joinCode) {
        server.joinCode = joinCode;
        if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
        serverMeta[serverCode].joinCode = joinCode;
    }

    let teamsCounter = {};
    if (Array.isArray(playersList)) {
        playersList.forEach(p => {
            teamsCounter[p.team] = (teamsCounter[p.team] || 0) + 1;
        });
    }

    liveServers[serverCode] = {
        ...server,
        totalPlayers: Array.isArray(playersList) ? playersList.length : 0,
        teamsSummary: teamsCounter,
        players: playersList || [],
        lastUpdated: Date.now()
    };

    const pending = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = [];

    // Include scheduled shutdown info for Roblox to announce
    const sched = scheduledShutdowns[serverCode] || null;

    res.json({
        success: true,
        commands: pending,
        scheduledShutdown: sched ? {
            executeAt: sched.executeAt,
            formattedTime: sched.formattedTime
        } : null
    });
});

/** ─── MAP POSITION STREAMING (from Roblox) ─── */
router.post('/:serverCode/positions', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { positions } = req.body; // Array of { name, userId, team, teamColor, x, z }

    if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server not found' });

    // Merge into live players list
    if (Array.isArray(positions)) {
        positions.forEach(pos => {
            const player = liveServers[serverCode].players.find(p => p.userId === pos.userId);
            if (player) {
                player.pos = { x: pos.x, z: pos.z };
                player.teamColor = pos.teamColor;
            }
        });
    }

    res.json({ success: true });
});

/** ─── ADD LOCATION MARKER (from Roblox) ─── */
router.post('/:serverCode/addlocation', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { locationName, LocationPosition, Text } = req.body;

    if (!serverLocations[serverCode]) serverLocations[serverCode] = [];
    serverLocations[serverCode].push({
        name: locationName,
        positions: LocationPosition,
        text: Text || null,
        addedAt: Date.now()
    });

    res.json({ success: true });
});

/** ─── GET LOCATIONS ─── */
router.get('/:serverCode/locations', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    res.json({ locations: serverLocations[serverCode] || [] });
});

/** ─── SERVER LIST (dashboard: online servers I can moderate) ─── */
router.get('/list', verifyAdminAccess, (req, res) => {
    const userId = req.adminId;
    const role = getUserRole(userId);
    const now = Date.now();

    const list = Object.values(liveServers)
        .filter(s => {
            // Show all servers to owners/admins; mods see servers they're assigned to
            if (role === 'owner' || role === 'admin') return true;
            const admin = activeAdmins[userId];
            return admin && admin.serverCode === s.serverCode;
        })
        .map(s => ({
            serverCode: s.serverCode,
            serverName: serverMeta[s.serverCode]?.name || s.serverName || 'Unnamed Server',
            joinCode: serverMeta[s.serverCode]?.joinCode || s.joinCode || '',
            totalPlayers: s.totalPlayers,
            startTime: s.startTime,
            uptime: Math.floor((now - s.startTime) / 1000)
        }));

    res.json({ servers: list });
});

/** ─── SERVER DETAIL ─── */
router.get('/:serverCode', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found or offline' });

    const sched = scheduledShutdowns[serverCode] || null;
    res.json({
        ...server,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        scheduledShutdown: sched ? { timestamp: sched.executeAt, formattedTime: sched.formattedTime } : null
    });
});

/** ─── PLAYER LIST ─── */
router.get('/:serverCode/players', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({ players: server.players, totalPlayers: server.totalPlayers });
});

/** ─── SINGLE PLAYER ─── */
router.get('/:serverCode/players/:playerId', verifyAdminAccess, (req, res) => {
    const { serverCode, playerId } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const player = server.players.find(
        p => String(p.userId) === String(playerId) || p.name === playerId
    );
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json(player);
});

/** ─── SCHEDULE SHUTDOWN ─── */
router.post('/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { targetTimestamp, senderId } = req.body;

    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    const ts = parseInt(targetTimestamp);
    if (!ts || ts <= Date.now()) {
        return res.status(400).json({ error: 'Please select a valid future time' });
    }

    // Format time in server timezone (UTC), client will re-render in local tz
    const d = new Date(ts);
    const formattedTime = d.toISOString();

    scheduledShutdowns[serverCode] = {
        executeAt: ts,
        formattedTime,
        senderId: req.adminId
    };

    pushAuditLog(serverCode, {
        type: 'scheduled_shutdown',
        actorId: req.adminId,
        actorUsername: admin.username,
        executeAt: ts,
        formattedTime
    });

    res.json({ success: true, executeAt: ts, formattedTime });
});

/** ─── CANCEL SCHEDULED SHUTDOWN ─── */
router.delete('/:serverCode/schedule-shutdown', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    if (!scheduledShutdowns[serverCode]) {
        return res.status(404).json({ error: 'No scheduled shutdown found' });
    }
    delete scheduledShutdowns[serverCode];
    res.json({ success: true });
});

/** ─── DELETE SERVER (server shutdown signal from Roblox) ─── */
router.delete('/:serverCode', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    delete scheduledShutdowns[serverCode];
    delete sessionChat[serverCode];
    delete serverLocations[serverCode];

    // Reset any admins that were in this server
    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode) {
            admin.status = 'Online';
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
        }
    });

    res.json({ success: true });
});

/** ─── DUTY MANAGEMENT ─── */
router.post('/duty', verifyAdminAccess, (req, res) => {
    const { username, action, serverCode } = req.body;
    const userId = req.adminId;
    const role   = getUserRole(userId);
    const now    = Date.now();

    if (!activeAdmins[userId]) {
        activeAdmins[userId] = {
            userId, username, role,
            status: 'Online', serverCode: null,
            updatedAt: new Date().toISOString(),
            lastSeen: now
        };
    }
    const admin = activeAdmins[userId];
    admin.lastSeen = now;
    admin.username = username || admin.username;

    if (action === 'start') {
        if (!serverCode) return res.status(400).json({ error: 'Server code required' });
        if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server is offline' });

        // Verify the player is actually in the server
        const server = liveServers[serverCode];
        const isInServer = server.players.some(p => p.userId === userId);
        if (!isInServer) {
            return res.status(403).json({ error: 'You must be inside the server to start a shift' });
        }

        admin.status     = 'on_duty';
        admin.serverCode = serverCode;
        admin.updatedAt  = new Date().toISOString();
        admin.shiftStart = now;
        return res.json({ success: true, status: 'on_duty' });
    }

    if (action === 'break') {
        if (admin.status !== 'on_duty') {
            return res.status(400).json({ error: 'You must be on duty to take a break' });
        }
        admin.status    = 'break';
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: 'break' });
    }

    if (action === 'stop') {
        const shiftDuration = admin.shiftStart ? Math.floor((now - admin.shiftStart) / 1000) : 0;
        admin.status     = 'Online';
        admin.serverCode = null;
        admin.updatedAt  = new Date().toISOString();
        admin.shiftStart = null;
        admin.lastShiftEnd = now;
        return res.json({ success: true, status: 'Online', shiftDuration });
    }

    res.status(400).json({ error: 'Unknown action' });
});

/** ─── STAFF LIST ─── */
router.get('/staff', verifyAdminAccess, (req, res) => {
    const userId   = req.adminId;
    const username = req.query.username;
    const now      = Date.now();

    // Refresh presence
    if (activeAdmins[userId]) {
        activeAdmins[userId].lastSeen = now;
    }

    // Mark stale admins offline (not seen in 15s)
    Object.values(activeAdmins).forEach(a => {
        if (now - a.lastSeen > 15000 && a.status !== 'Offline') {
            a.status    = 'Offline';
            a.updatedAt = new Date().toISOString();
        }
    });

    // Sort: on_duty → break → Online → Offline (by updatedAt desc)
    const order = { on_duty: 0, break: 1, Online: 2, Offline: 3 };
    const staff = Object.values(activeAdmins).sort((a, b) => {
        const oa = order[a.status] ?? 4;
        const ob = order[b.status] ?? 4;
        if (oa !== ob) return oa - ob;
        return new Date(b.updatedAt) - new Date(a.updatedAt);
    });

    res.json({ staff });
});

/** ─── UPDATE SERVER NAME / JOIN CODE (from Roblox module) ─── */
router.post('/:serverCode/meta', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { name, joinCode, ownerId } = req.body;
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    if (name)     serverMeta[serverCode].name     = name;
    if (joinCode) serverMeta[serverCode].joinCode  = joinCode;
    if (ownerId)  serverMeta[serverCode].ownerId   = ownerId;
    if (liveServers[serverCode]) {
        if (name)     liveServers[serverCode].serverName = name;
        if (joinCode) liveServers[serverCode].joinCode   = joinCode;
    }
    res.json({ success: true });
});

/** ─── SEND COMMAND (from dashboard) ─── */
router.post('/:serverCode/commands', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { action, target, targetId, targetUsername, reason, duration, senderId } = req.body;
    const admin = activeAdmins[req.adminId];

    if (!action) return res.status(400).json({ error: 'Action required' });

    // Most commands require on-duty status
    const dutyOnly = ['kick', 'ban', 'freeze', 'unfreeze', 'bring', 'to', 'shutdown', 'warn', 'message'];
    if (dutyOnly.includes(action) && (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode)) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    const cmd = {
        action, target, targetId, targetUsername,
        reason, duration,
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        issuedAt: Date.now()
    };
    commandsQueue[serverCode].push(cmd);

    // Push chat system message for punishment commands
    const punishmentCmds = ['kick', 'ban', 'freeze', 'unfreeze', 'warn', 'unwarn'];
    if (punishmentCmds.includes(action) && admin) {
        const { pushSessionChat } = require('../state');
        pushSessionChat(serverCode, {
            type: 'system',
            text: `${admin.username} executed ${action} on ${target || targetUsername || 'target'}`,
            senderId: req.adminId,
            senderName: admin.username,
            timestamp: Date.now(),
            commandRef: action
        });
    }

    res.json({ success: true });
});

/** ─── SESSION CHAT ─── */
router.get('/:serverCode/chat', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    res.json({ messages: sessionChat[serverCode] || [] });
});

router.post('/:serverCode/chat', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const { message, senderId } = req.body;
    const admin = activeAdmins[req.adminId];

    if (!message || message.trim().length === 0) {
        return res.status(400).json({ error: 'Empty message' });
    }
    if (message.trim().length > 300) {
        return res.status(400).json({ error: 'Message too long' });
    }

    const { pushSessionChat } = require('../state');
    const msg = {
        type: 'message',
        text: message.trim(),
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        senderRole: getUserRole(req.adminId),
        timestamp: Date.now()
    };
    pushSessionChat(serverCode, msg);
    res.json({ success: true, message: msg });
});

/** ─── UPDATE ADMINS (from Roblox module) ─── */
router.post('/:serverCode/admins', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { adminIds } = req.body; // Array of user IDs

    if (!Array.isArray(adminIds)) return res.status(400).json({ error: 'adminIds must be array' });

    // Kick any active admin that is no longer in the list
    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode && !adminIds.includes(admin.userId)) {
            admin.status     = 'Online';
            admin.serverCode = null;
            admin.updatedAt  = new Date().toISOString();
            // Flag for frontend to pick up
            admin.permissionsRevoked = true;
            admin.permissionsRevokedAt = Date.now();
        }
    });

    res.json({ success: true });
});

// ─── CLEANUP: remove stale servers (no heartbeat in 7s) ───
setInterval(() => {
    const now = Date.now();
    Object.keys(liveServers).forEach(serverCode => {
        const server = liveServers[serverCode];
        if (now - server.lastUpdated > 7000) {
            delete liveServers[serverCode];
            delete commandsQueue[serverCode];
            delete scheduledShutdowns[serverCode];
            delete sessionChat[serverCode];
            delete serverLocations[serverCode];

            Object.values(activeAdmins).forEach(admin => {
                if (admin.serverCode === serverCode) {
                    admin.status = 'Online';
                    admin.serverCode = null;
                    admin.updatedAt = new Date().toISOString();
                    admin.serverWentOffline = true;
                    admin.serverWentOfflineAt = Date.now();
                }
            });
        } else {
            // Fire scheduled shutdown
            if (scheduledShutdowns[serverCode] && now >= scheduledShutdowns[serverCode].executeAt) {
                if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
                commandsQueue[serverCode].push({
                    action: 'shutdown',
                    reason: 'Scheduled shutdown',
                    senderId: scheduledShutdowns[serverCode].senderId,
                    senderName: activeAdmins[scheduledShutdowns[serverCode].senderId]?.username || 'System',
                    issuedAt: Date.now()
                });
                delete scheduledShutdowns[serverCode];
            }
        }
    });
}, 3000);

module.exports = router;
