'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const router  = express.Router();
const {
    liveServers, commandsQueue, scheduledShutdowns,
    activeAdmins, serverMeta, auditLogs, sessionChat,
    serverLocations, getOrInitServer, pushAuditLog,
    adminRoster, serverStaff, getServerStaff, dutyCooldowns
} = require('../state');
const { verifyRobloxToken, verifyServerApiKey, verifyAdminAccess, verifyOnDuty, smartRateLimiter, getUserRole } = require('../middleware/auth');

const DUTY_COOLDOWN_MS = 2000; // anti-spam on start/break/stop shift buttons

/** ─── HEARTBEAT (from Roblox server) ─── */
router.post('/:serverCode/heartbeat', verifyServerApiKey, (req, res) => {
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

    const playerCount = Array.isArray(playersList) ? playersList.length : 0;

    // Empty-server grace tracking: don't nuke the dashboard entry / tell Roblox to
    // shut down the instant the last player leaves — wait a few seconds in case
    // someone rejoins, then finalize (see the setInterval loop below).
    let emptySince = server.emptySince || null;
    if (playerCount === 0) {
        if (!emptySince) emptySince = Date.now();
    } else {
        emptySince = null;
    }

    liveServers[serverCode] = {
        ...server,
        totalPlayers: playerCount,
        teamsSummary: teamsCounter,
        players: playersList || [],
        lastUpdated: Date.now(),
        emptySince,
        autoShutdownQueued: playerCount === 0 ? server.autoShutdownQueued : false
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
router.post('/:serverCode/positions', verifyServerApiKey, (req, res) => {
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
                player.posUpdatedAt = Date.now();
            }
        });
    }

    // Broadcast to any dashboard clients watching this server's map over WebSocket
    // (falls back gracefully if the WS layer isn't attached yet).
    if (typeof global.broadcastPositions === 'function') {
        global.broadcastPositions(serverCode, liveServers[serverCode].players);
    }

    res.json({ success: true });
});

/** ─── ADD LOCATION MARKER (from Roblox) ─── */
router.post('/:serverCode/addlocation', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { locationName, LocationPosition, Text } = req.body;

    if (!locationName) return res.status(400).json({ error: 'locationName required' });

    // Look for img/<locationName>.png (no extension in the name) so the frontend
    // knows whether to render an icon or fall back to a text label on the marker.
    const imgDir = path.join(__dirname, '..', '..', 'img');
    const iconFile = `${locationName}.png`;
    const hasIcon = fs.existsSync(path.join(imgDir, iconFile));

    if (!serverLocations[serverCode]) serverLocations[serverCode] = [];
    serverLocations[serverCode].push({
        name: locationName,
        positions: LocationPosition,
        text: Text || null,
        hasIcon,
        iconUrl: hasIcon ? `/img/${iconFile}` : null,
        addedAt: Date.now()
    });

    res.json({ success: true, hasIcon });
});

/** ─── GET LOCATIONS ─── */
router.get('/:serverCode/locations', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    res.json({ locations: serverLocations[serverCode] || [] });
});

/** ─── SERVER LIST (dashboard: online servers I can moderate) ─── */
router.get('/list', verifyAdminAccess, (req, res) => {
    const userId = req.adminId;
    const now = Date.now();

    const list = Object.values(liveServers)
        .filter(s => {
            const role = getUserRole(userId, s.serverCode);
            // Global admins see every server. Owners/mods see servers they're assigned to
            // (regardless of whether they're currently on duty there).
            if (adminRoster.globalAdmins.has(userId)) return true;
            if (role === 'owner' || role === 'mod') return true;
            return false;
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
        uptime: Math.floor((Date.now() - server.startTime) / 1000),
        scheduledShutdown: sched ? { timestamp: sched.executeAt, formattedTime: sched.formattedTime } : null
    });
});

/** ─── PLAYER LIST ─── */
router.get('/:serverCode/players', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const playersWithRole = server.players.map(p => ({
        ...p,
        role: getUserRole(p.userId, serverCode)
    }));

    res.json({
        players: playersWithRole,
        totalPlayers: server.totalPlayers,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        startTime: server.startTime,
        uptime: Math.floor((Date.now() - server.startTime) / 1000),
        teamsSummary: server.teamsSummary,
        scheduledShutdown: scheduledShutdowns[serverCode]
            ? { timestamp: scheduledShutdowns[serverCode].executeAt } : null,
        locations: serverLocations[serverCode] || []
    });
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
    const { targetTimestamp } = req.body;

    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    const ts = parseInt(targetTimestamp);
    if (!ts || ts <= Date.now()) {
        return res.status(400).json({ error: 'Please select a valid future time' });
    }

    const d = new Date(ts);
    const formattedTime = d.toISOString();

    scheduledShutdowns[serverCode] = {
        executeAt: ts,
        formattedTime,
        senderId: req.adminId,
        senderName: admin.username
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

/** ─── LOCK / UNLOCK SERVER ───
 * Just relays the request down to the Roblox server with who asked for it —
 * actual lock/unlock game logic lives in the Roblox module. */
router.post('/:serverCode/lock', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'lock_request',
        senderId: req.adminId,
        senderName: admin.username,
        issuedAt: Date.now()
    });

    pushAuditLog(serverCode, {
        type: 'server_lock',
        actorId: req.adminId,
        actorUsername: admin.username
    });

    res.json({ success: true });
});

router.post('/:serverCode/unlock', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const admin = activeAdmins[req.adminId];
    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'unlock_request',
        senderId: req.adminId,
        senderName: admin.username,
        issuedAt: Date.now()
    });

    pushAuditLog(serverCode, {
        type: 'server_unlock',
        actorId: req.adminId,
        actorUsername: admin.username
    });

    res.json({ success: true });
});

/** ─── DELETE SERVER (server shutdown signal from Roblox) ─── */
router.delete('/:serverCode', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
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
        }
    });

    res.json({ success: true });
});

/** ─── DUTY MANAGEMENT ─── */
router.post('/duty', verifyAdminAccess, (req, res) => {
    const { username, action, serverCode } = req.body;
    const userId = req.adminId;
    const now    = Date.now();

    // Anti-spam cooldown on shift buttons
    const lastAction = dutyCooldowns[userId] || 0;
    if (now - lastAction < DUTY_COOLDOWN_MS) {
        return res.status(429).json({
            error: 'Please wait before doing that again',
            remainingMs: DUTY_COOLDOWN_MS - (now - lastAction)
        });
    }

    const role = getUserRole(userId, serverCode);

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
    admin.role = role;

    if (action === 'start') {
        if (!serverCode) return res.status(400).json({ error: 'Server code required' });
        if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server is offline' });

        // Verify the player is actually in the server
        const server = liveServers[serverCode];
        const isInServer = server.players.some(p => p.userId === userId);
        if (!isInServer) {
            return res.status(403).json({ error: 'You must be inside the server to start a shift' });
        }

        // Works the same whether coming from Online or from a Break — the frontend
        // is responsible for labeling this "Continue Shift" while status === 'break'.
        dutyCooldowns[userId] = now;
        admin.status     = 'on_duty';
        admin.serverCode = serverCode;
        admin.updatedAt  = new Date().toISOString();
        if (!admin.shiftStart) admin.shiftStart = now;
        return res.json({ success: true, status: 'on_duty' });
    }

    if (action === 'break') {
        if (admin.status !== 'on_duty') {
            return res.status(400).json({ error: 'You must be on duty to take a break' });
        }
        dutyCooldowns[userId] = now;
        admin.status    = 'break';
        admin.updatedAt = new Date().toISOString();
        admin.breakStart = now;
        return res.json({ success: true, status: 'break' });
    }

    if (action === 'stop') {
        const shiftDuration = admin.shiftStart ? Math.floor((now - admin.shiftStart) / 1000) : 0;
        dutyCooldowns[userId] = now;
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
    const now      = Date.now();

    if (activeAdmins[userId]) {
        activeAdmins[userId].lastSeen = now;
    }

    Object.values(activeAdmins).forEach(a => {
        if (now - a.lastSeen > 15000 && a.status !== 'Offline') {
            a.status    = 'Offline';
            a.updatedAt = new Date().toISOString();
        }
    });

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
router.post('/:serverCode/meta', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { name, joinCode, ownerId } = req.body;
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    if (name)     serverMeta[serverCode].name     = name;
    if (joinCode) serverMeta[serverCode].joinCode  = joinCode;
    if (ownerId) {
        serverMeta[serverCode].ownerId = ownerId;
        getServerStaff(serverCode).ownerId = parseInt(ownerId);
    }
    if (liveServers[serverCode]) {
        if (name)     liveServers[serverCode].serverName = name;
        if (joinCode) liveServers[serverCode].joinCode   = joinCode;
    }
    res.json({ success: true });
});

/** ─── SEND COMMAND (from dashboard) ─── */
router.post('/:serverCode/commands', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    let { action, target, targetId, targetUsername, reason, duration, newHealth, maxHealth } = req.body;
    const admin = activeAdmins[req.adminId];

    if (!action) return res.status(400).json({ error: 'Action required' });

    const dutyOnly = ['kick', 'ban', 'freeze', 'unfreeze', 'bring', 'to', 'shutdown', 'warn', 'message', 'health', 'lock', 'unlock'];
    if (dutyOnly.includes(action) && (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode)) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    // Normalize the "who is this for" arg for broadcast-style commands so Roblox
    // always gets an explicit target: '@everyone' | '@me' | a specific username.
    if (action === 'message' || action === 'health') {
        if (!target) target = '@everyone';
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    const cmd = {
        action, target, targetId, targetUsername,
        reason, duration,
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        issuedAt: Date.now()
    };

    // Health command: explicit newHealth/maxHealth args, nil-safe for Roblox (null -> nil on decode)
    if (action === 'health') {
        cmd.newHealth = (newHealth === undefined || newHealth === null || newHealth === '') ? null : Number(newHealth);
        cmd.maxHealth = (maxHealth === undefined || maxHealth === null || maxHealth === '') ? null : Number(maxHealth);
    }

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
    const { message } = req.body;
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
        senderRole: getUserRole(req.adminId, serverCode),
        timestamp: Date.now()
    };
    pushSessionChat(serverCode, msg);
    res.json({ success: true, message: msg });
});

/** ─── UPDATE ADMINS (UpdateAdmins — from Roblox module) ───
 * This is now the single source of truth for who can access the dashboard.
 * body: { admins: [userId,...], mods: [userId,...] }
 *   admins -> global admin access (any server)
 *   mods   -> access scoped to THIS serverCode only
 * Both arrays fully REPLACE the previous roster for their scope each call — same
 * "sync the whole list" semantics as before, just actually wired to auth now. */
router.post('/:serverCode/admins', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { admins, mods, adminIds } = req.body;

    // Back-compat: if only the old `adminIds` shape is sent, treat it as the mods list
    // for this server (safer default than granting global admin).
    const newAdmins = Array.isArray(admins) ? admins.map(Number) : null;
    const newMods   = Array.isArray(mods) ? mods.map(Number)
                     : Array.isArray(adminIds) ? adminIds.map(Number)
                     : null;

    if (newAdmins) adminRoster.globalAdmins = new Set(newAdmins);
    if (newMods)   getServerStaff(serverCode).mods = new Set(newMods);

    // Kick any active admin/mod session for this server that's no longer authorized
    const staff = getServerStaff(serverCode);
    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode !== serverCode) return;
        const stillAuthorized = adminRoster.globalAdmins.has(admin.userId)
            || staff.mods.has(admin.userId)
            || staff.ownerId === admin.userId;
        if (!stillAuthorized) {
            admin.status     = 'Online';
            admin.serverCode = null;
            admin.updatedAt  = new Date().toISOString();
            admin.permissionsRevoked = true;
            admin.permissionsRevokedAt = Date.now();
        }
    });

    res.json({ success: true });
});

/** ─── SET OWNER (SetOwner — from Roblox module) ─── */
router.post('/:serverCode/owner', verifyServerApiKey, (req, res) => {
    const { serverCode } = req.params;
    const { ownerId } = req.body;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    getServerStaff(serverCode).ownerId = parseInt(ownerId);
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    serverMeta[serverCode].ownerId = parseInt(ownerId);

    res.json({ success: true });
});

// ─── CLEANUP: remove stale servers, finalize empty-server auto-shutdown, fire scheduled shutdowns ───
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
            return;
        }

        // Empty-server auto-shutdown: wait 5s after the last player leaves before
        // telling Roblox to actually shut the instance down (cancels itself if
        // someone rejoins in the meantime — emptySince gets cleared on heartbeat).
        if (server.totalPlayers === 0 && server.emptySince && !server.autoShutdownQueued
            && (now - server.emptySince >= 5000)) {
            if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
            commandsQueue[serverCode].push({
                action: 'shutdown',
                reason: 'Empty server auto-shutdown',
                senderId: null,
                senderName: 'System',
                issuedAt: now
            });
            server.autoShutdownQueued = true;
        }

        // Fire scheduled shutdown
        if (scheduledShutdowns[serverCode] && now >= scheduledShutdowns[serverCode].executeAt) {
            if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
            commandsQueue[serverCode].push({
                action: 'shutdown',
                reason: 'Scheduled shutdown',
                senderId: scheduledShutdowns[serverCode].senderId,
                senderName: activeAdmins[scheduledShutdowns[serverCode].senderId]?.username || scheduledShutdowns[serverCode].senderName || 'System',
                issuedAt: now
            });
            delete scheduledShutdowns[serverCode];
        }
    });
}, 3000);

module.exports = router;
