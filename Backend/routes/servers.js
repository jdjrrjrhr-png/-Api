'use strict';

const express = require('express');
const router  = express.Router();
const { getConfig } = require('../config');
const { broadcastPositions, broadcastEvent } = require('../ws');
const {
    liveServers, commandsQueue, scheduledShutdowns,
    activeAdmins, serverMeta, sessionChat, serverLocations,
    serverAdmins, serverOwners, usedApiKeys,
    dashboardWatchers, emptyServerTimers, shiftHistory, serverStatsSamples,
    getOrInitServer, pushAuditLog, pushSessionChat,
    getServerRole, setServerAdmins, setServerOwner, rekeyServer,
    resolveUsername, findLocationImage, markServerEmpty, cancelServerEmpty,
    checkDutyCooldown, toggleFreezeState, trackShiftPunishment, pushStatsSample,
    maskApiKey
} = require('../state');
const {
    verifyRobloxToken, verifyLoggedIn, verifyServerAdmin, smartRateLimiter
} = require('../middleware/auth');

/* ============================================================
   ROBLOX-FACING (Bearer token)
============================================================ */

/** Init / re-registration. Called at startup with oldKey === newKey,
 *  and again whenever the Roblox server rotates its own key
 *  (oldKey !== newKey). This is the ONLY way a server's identity
 *  (serverCode / API key) is established — the API never invents it. */
router.post('/setkey', verifyRobloxToken, (req, res) => {
    const { oldKey, newKey, serverName, joinCode } = req.body;
    if (!newKey) return res.status(400).json({ error: 'newKey required' });

    if (usedApiKeys.has(newKey) && oldKey !== newKey) {
        return res.status(409).json({ error: 'Key collision — generate a different key' });
    }

    if (oldKey && oldKey !== newKey && (liveServers[oldKey] || serverAdmins[oldKey] || serverOwners[oldKey] !== undefined)) {
        rekeyServer(oldKey, newKey);
        broadcastEvent(oldKey, 'key_rotated', { newKey });
    } else {
        usedApiKeys.add(newKey);
    }

    if (!serverMeta[newKey]) serverMeta[newKey] = {};
    if (!serverMeta[newKey].keyGeneratedAt) serverMeta[newKey].keyGeneratedAt = Date.now();
    if (serverName) serverMeta[newKey].name = serverName;
    if (joinCode)   serverMeta[newKey].joinCode = joinCode;

    getOrInitServer(newKey);

    res.json({ success: true, key: newKey });
});

/** Heartbeat — the core loop. Computes dashboardWatching + runs the
 *  empty-server grace timer + samples player count for stats. */
router.post('/:serverCode/heartbeat', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { playersList, serverName, joinCode } = req.body;
    const cfg = getConfig();

    const server = getOrInitServer(serverCode);

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
        playersList.forEach(p => { teamsCounter[p.team] = (teamsCounter[p.team] || 0) + 1; });
    }
    const newCount = Array.isArray(playersList) ? playersList.length : 0;

    liveServers[serverCode] = {
        ...server,
        totalPlayers: newCount,
        teamsSummary: teamsCounter,
        players: playersList || [],
        lastUpdated: Date.now()
    };

    // Empty-server grace timer — only affects the dashboard, never deletes
    // the live server or sends a real shutdown to Roblox.
    if (newCount === 0) markServerEmpty(serverCode);
    else cancelServerEmpty(serverCode);

    pushStatsSample(serverCode, newCount);

    const pending = commandsQueue[serverCode] || [];
    commandsQueue[serverCode] = [];

    const sched = scheduledShutdowns[serverCode] || null;
    const watcher = dashboardWatchers[serverCode];
    const isWatched = watcher && (Date.now() - watcher.lastSeen < cfg.dashboardWatchTimeoutMs);
    // Only ever true if BOTH a dashboard is actively watching AND the
    // player count meets the configured minimum — never send data otherwise.
    const dashboardWatching = !!isWatched && newCount >= (cfg.mapMinPlayers || 10);

    res.json({
        success: true,
        commands: pending,
        dashboardWatching,
        scheduledShutdown: sched ? { executeAt: sched.executeAt, formattedTime: sched.formattedTime } : null
    });
});

/** Position streaming — defense in depth: server-side re-checks the exact
 *  same conditions Lua is supposed to check, and silently ignores the
 *  packet if they're not met (never renders stale/ineligible data). */
router.post('/:serverCode/positions', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { positions } = req.body;
    const cfg = getConfig();

    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (server.totalPlayers < (cfg.mapMinPlayers || 10)) {
        return res.json({ success: true, ignored: true, reason: 'below-min-players' });
    }
    const watcher = dashboardWatchers[serverCode];
    if (!watcher || Date.now() - watcher.lastSeen > cfg.dashboardWatchTimeoutMs) {
        return res.json({ success: true, ignored: true, reason: 'not-watched' });
    }

    if (Array.isArray(positions)) {
        positions.forEach(pos => {
            const player = server.players.find(p => p.userId === pos.userId);
            if (player) {
                player.pos = { x: pos.x, z: pos.z };
                player.teamColor = pos.teamColor;
                player.posUpdatedAt = Date.now();
            }
        });
    }

    broadcastPositions(serverCode, positions);
    res.json({ success: true });
});

/** Add a location marker. Image resolution happens at READ time
 *  (see GET /:serverCode and GET /:serverCode/locations) so newly
 *  added images in /img are picked up without re-sending the location. */
router.post('/:serverCode/addlocation', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { locationName, LocationPosition, Text } = req.body;

    if (!locationName || !LocationPosition) {
        return res.status(400).json({ error: 'locationName and LocationPosition required' });
    }

    if (!serverLocations[serverCode]) serverLocations[serverCode] = [];
    serverLocations[serverCode].push({
        name: locationName,
        positions: LocationPosition,
        text: Text || null,
        addedAt: Date.now()
    });

    res.json({ success: true });
});

router.post('/:serverCode/meta', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { name, joinCode } = req.body;
    if (!serverMeta[serverCode]) serverMeta[serverCode] = {};
    if (name)     serverMeta[serverCode].name     = name;
    if (joinCode) serverMeta[serverCode].joinCode  = joinCode;
    if (liveServers[serverCode]) {
        if (name)     liveServers[serverCode].serverName = name;
        if (joinCode) liveServers[serverCode].joinCode   = joinCode;
    }
    res.json({ success: true });
});

/** Shield.SetServerOwner(userId) lands here — the ONLY way ownership is set */
router.post('/:serverCode/setowner', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    setServerOwner(serverCode, userId);
    res.json({ success: true });
});

/** Shield.UpdateAdmins(adminIdsArray) lands here — the ONLY way the admin
 *  set is populated. Anyone dropped from the array is evicted from the
 *  dashboard immediately if they're currently viewing this server. */
router.post('/:serverCode/admins', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    const { adminIds } = req.body;
    if (!Array.isArray(adminIds)) return res.status(400).json({ error: 'adminIds must be array' });

    const removed = setServerAdmins(serverCode, adminIds);

    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode && removed.includes(admin.userId)) {
            admin.status = 'Online';
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
            admin.permissionsRevoked = true;
            admin.permissionsRevokedAt = Date.now();
        }
    });
    if (removed.length) broadcastEvent(serverCode, 'permissions_revoked', { userIds: removed });

    res.json({ success: true });
});

/** Server going fully offline (game:BindToClose / Deinit) */
router.delete('/:serverCode', verifyRobloxToken, (req, res) => {
    const { serverCode } = req.params;
    delete liveServers[serverCode];
    delete commandsQueue[serverCode];
    delete scheduledShutdowns[serverCode];
    delete sessionChat[serverCode];
    delete serverLocations[serverCode];
    delete dashboardWatchers[serverCode];
    delete emptyServerTimers[serverCode];

    Object.values(activeAdmins).forEach(admin => {
        if (admin.serverCode === serverCode) {
            admin.status = 'Online';
            admin.serverCode = null;
            admin.updatedAt = new Date().toISOString();
            admin.serverWentOffline = true;
            admin.serverWentOfflineAt = Date.now();
        }
    });
    broadcastEvent(serverCode, 'server_offline', {});

    res.json({ success: true });
});

/* ============================================================
   DASHBOARD-FACING (session-based, per-server role)
============================================================ */

/** List every server the caller has ANY role on — no more global role,
 *  filtered live via getServerRole() against every online server. */
router.get('/list', verifyLoggedIn, (req, res) => {
    const userId = req.callerId;
    const now = Date.now();

    const list = Object.values(liveServers)
        .filter(s => getServerRole(s.serverCode, userId) !== null)
        .map(s => ({
            serverCode: s.serverCode,          // needed for routing — never render this raw in UI text
            serverName: serverMeta[s.serverCode]?.name || s.serverName || 'Unnamed Server',
            joinCode: serverMeta[s.serverCode]?.joinCode || s.joinCode || '',
            totalPlayers: s.totalPlayers,
            startTime: s.startTime,
            uptime: Math.floor((now - s.startTime) / 1000),
            role: getServerRole(s.serverCode, userId)
        }));

    res.json({ servers: list });
});

/** Full server detail — also updates dashboardWatchers (so Lua knows
 *  someone is actively looking) and includes resolved location images. */
router.get('/:serverCode', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    dashboardWatchers[serverCode] = { lastSeen: Date.now() };

    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found or offline' });

    const sched = scheduledShutdowns[serverCode] || null;
    const locations = (serverLocations[serverCode] || []).map(loc => ({
        ...loc,
        imageUrl: findLocationImage(loc.name)
    }));
    const players = (server.players || []).map(p => ({ ...p, role: getServerRole(serverCode, p.userId) }));

    res.json({
        ...server,
        players,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        maskedServerCode: maskApiKey(serverCode),
        callerRole: req.serverRole,
        locations,
        scheduledShutdown: sched ? {
            timestamp: sched.executeAt, formattedTime: sched.formattedTime,
            senderId: sched.senderId, senderName: sched.senderName
        } : null
    });
});

router.get('/:serverCode/players', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    dashboardWatchers[serverCode] = { lastSeen: Date.now() };

    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const players = (server.players || []).map(p => ({ ...p, role: getServerRole(serverCode, p.userId) }));

    res.json({
        players,
        totalPlayers: server.totalPlayers,
        startTime: server.startTime,
        teamsSummary: server.teamsSummary,
        serverName: serverMeta[serverCode]?.name || server.serverName || 'Unnamed Server',
        joinCode: serverMeta[serverCode]?.joinCode || server.joinCode || '',
        maskedServerCode: maskApiKey(serverCode),
        callerRole: req.serverRole,
        scheduledShutdown: scheduledShutdowns[serverCode] ? {
            timestamp: scheduledShutdowns[serverCode].executeAt,
            formattedTime: scheduledShutdowns[serverCode].formattedTime
        } : null
    });
});

router.get('/:serverCode/players/:playerId', verifyServerAdmin, (req, res) => {
    const { serverCode, playerId } = req.params;
    const server = liveServers[serverCode];
    if (!server) return res.status(404).json({ error: 'Server not found' });
    const player = server.players.find(p => String(p.userId) === String(playerId) || p.name === playerId);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json({ ...player, role: getServerRole(serverCode, player.userId) });
});

router.get('/:serverCode/locations', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const locations = (serverLocations[serverCode] || []).map(loc => ({
        ...loc, imageUrl: findLocationImage(loc.name)
    }));
    res.json({ locations });
});

/** Schedule a shutdown — requester identity always carried through */
router.post('/:serverCode/schedule-shutdown', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const { targetTimestamp } = req.body;
    const admin = activeAdmins[req.callerId];

    if (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    const ts = parseInt(targetTimestamp);
    if (!ts || ts <= Date.now()) return res.status(400).json({ error: 'Please select a valid future time' });

    const formattedTime = new Date(ts).toISOString();
    scheduledShutdowns[serverCode] = { executeAt: ts, formattedTime, senderId: req.callerId, senderName: admin.username };

    pushAuditLog(serverCode, {
        type: 'scheduled_shutdown', actorId: req.callerId, actorUsername: admin.username,
        executeAt: ts, formattedTime
    });

    res.json({ success: true, executeAt: ts, formattedTime });
});

router.delete('/:serverCode/schedule-shutdown', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    if (!scheduledShutdowns[serverCode]) return res.status(404).json({ error: 'No scheduled shutdown found' });
    delete scheduledShutdowns[serverCode];
    res.json({ success: true });
});

/** Duty control — now with cooldown, per-server role check, and
 *  break -> resume directly to on_duty (frontend labels this "Continue Shift") */
router.post('/duty', verifyLoggedIn, (req, res) => {
    const { username, action, serverCode } = req.body;
    const userId = req.callerId;

    if (!checkDutyCooldown(userId)) {
        return res.status(429).json({ error: 'Please wait before changing duty status again' });
    }
    if (serverCode && !getServerRole(serverCode, userId)) {
        return res.status(403).json({ error: 'You are not staff on this server' });
    }

    const now = Date.now();
    if (!activeAdmins[userId]) {
        activeAdmins[userId] = {
            userId, username, status: 'Online', serverCode: null,
            updatedAt: new Date().toISOString(), lastSeen: now,
            totalBreakSeconds: 0, shiftPunishments: 0
        };
    }
    const admin = activeAdmins[userId];
    admin.lastSeen = now;
    admin.username = username || admin.username;

    if (action === 'start') {
        // Resuming from break — no re-check needed, they're already on duty conceptually
        if (admin.status === 'break') {
            if (admin.breakStart) {
                admin.totalBreakSeconds = (admin.totalBreakSeconds || 0) + Math.floor((now - admin.breakStart) / 1000);
                admin.breakStart = null;
            }
            admin.status = 'on_duty';
            admin.updatedAt = new Date().toISOString();
            return res.json({ success: true, status: 'on_duty' });
        }

        if (!serverCode) return res.status(400).json({ error: 'Server code required' });
        if (!liveServers[serverCode]) return res.status(404).json({ error: 'Server is offline' });

        const inServer = liveServers[serverCode].players.some(p => p.userId === userId);
        if (!inServer) return res.status(403).json({ error: 'You must be inside the server to start a shift' });

        admin.status = 'on_duty';
        admin.serverCode = serverCode;
        admin.shiftStart = now;
        admin.totalBreakSeconds = 0;
        admin.shiftPunishments = 0;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: 'on_duty' });
    }

    if (action === 'break') {
        if (admin.status !== 'on_duty') return res.status(400).json({ error: 'You must be on duty to take a break' });
        admin.status = 'break';
        admin.breakStart = now;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: 'break' });
    }

    if (action === 'stop') {
        if (admin.status === 'break' && admin.breakStart) {
            admin.totalBreakSeconds = (admin.totalBreakSeconds || 0) + Math.floor((now - admin.breakStart) / 1000);
            admin.breakStart = null;
        }
        const shiftDuration = admin.shiftStart ? Math.floor((now - admin.shiftStart) / 1000) : 0;

        if (admin.shiftStart && admin.serverCode) {
            if (!shiftHistory[userId]) shiftHistory[userId] = [];
            shiftHistory[userId].push({
                serverCode: admin.serverCode,
                start: admin.shiftStart, end: now, duration: shiftDuration,
                breakDuration: admin.totalBreakSeconds || 0,
                punishments: admin.shiftPunishments || 0
            });
            if (shiftHistory[userId].length > 200) shiftHistory[userId] = shiftHistory[userId].slice(-200);
        }

        admin.status = 'Online';
        admin.serverCode = null;
        admin.shiftStart = null;
        admin.lastShiftEnd = now;
        admin.updatedAt = new Date().toISOString();
        return res.json({ success: true, status: 'Online', shiftDuration });
    }

    res.status(400).json({ error: 'Unknown action' });
});

/** Server-scoped staff list — every admin/owner registered for THIS
 *  server via UpdateAdmins/SetServerOwner, enriched with live session
 *  info if they've ever connected, resolved via Roblox API otherwise. */
router.get('/:serverCode/staff', verifyServerAdmin, async (req, res) => {
    const { serverCode } = req.params;
    const ownerId  = serverOwners[serverCode];
    const adminIds = [...(serverAdmins[serverCode] || new Set())];
    const allIds   = [...new Set([ownerId, ...adminIds].filter(Boolean))];

    try {
        const list = await Promise.all(allIds.map(async id => {
            const live = activeAdmins[id];
            const username = live?.username || await resolveUsername(id);
            return {
                userId: id, username,
                role: id === ownerId ? 'owner' : 'admin',
                status: live?.status || 'Offline',
                updatedAt: live?.updatedAt || null,
                shiftStart: live?.shiftStart || null,
                totalBreakSeconds: live?.totalBreakSeconds || 0,
                shiftPunishments: live?.shiftPunishments || 0
            };
        }));

        const order = { on_duty: 0, break: 1, Online: 2, Offline: 3 };
        list.sort((a, b) => {
            const oa = order[a.status] ?? 4, ob = order[b.status] ?? 4;
            if (oa !== ob) return oa - ob;
            return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
        });

        res.json({ staff: list });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load staff list' });
    }
});

/** Server Stats — hourly-bucketed player-count series + text insights */
router.get('/:serverCode/stats', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const range = req.query.range || 'week'; // week | 3days | 24h
    const rangeMs = range === '24h' ? 86400000 : range === '3days' ? 3 * 86400000 : 7 * 86400000;
    const cutoff = Date.now() - rangeMs;

    const samples = (serverStatsSamples[serverCode] || []).filter(s => s.t >= cutoff);

    // Bucket by hour
    const buckets = {};
    samples.forEach(s => {
        const d = new Date(s.t);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
        if (!buckets[key]) buckets[key] = { t: new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime(), sum: 0, max: 0, n: 0 };
        buckets[key].sum += s.c;
        buckets[key].max = Math.max(buckets[key].max, s.c);
        buckets[key].n++;
    });

    const series = Object.values(buckets)
        .sort((a, b) => a.t - b.t)
        .map(b => ({ t: b.t, avgPlayers: +(b.sum / b.n).toFixed(1), maxPlayers: b.max }));

    // Busiest day (by average player count across its hours)
    const byDay = {};
    series.forEach(pt => {
        const d = new Date(pt.t);
        const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!byDay[dayKey]) byDay[dayKey] = { label: d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), sum: 0, n: 0, playerMinutes: 0 };
        byDay[dayKey].sum += pt.avgPlayers;
        byDay[dayKey].n++;
        byDay[dayKey].playerMinutes += pt.avgPlayers * 60;
    });
    const dayEntries = Object.values(byDay).map(d => ({ ...d, avg: d.sum / d.n }));
    const busiestDay = dayEntries.sort((a, b) => b.avg - a.avg)[0] || null;

    // Busiest hour-of-day (aggregated across the whole range)
    const byHour = {};
    series.forEach(pt => {
        const h = new Date(pt.t).getHours();
        if (!byHour[h]) byHour[h] = { sum: 0, n: 0 };
        byHour[h].sum += pt.avgPlayers;
        byHour[h].n++;
    });
    const hourEntries = Object.entries(byHour).map(([h, v]) => ({ hour: parseInt(h), avg: v.sum / v.n }));
    const busiestHour = hourEntries.sort((a, b) => b.avg - a.avg)[0] || null;

    const totalPlayerMinutes = dayEntries.reduce((a, d) => a + d.playerMinutes, 0);

    res.json({
        range, series,
        insights: {
            busiestDay: busiestDay ? { label: busiestDay.label, avgPlayers: +busiestDay.avg.toFixed(1) } : null,
            busiestHour: busiestHour ? { hour: busiestHour.hour, avgPlayers: +busiestHour.avg.toFixed(1) } : null,
            totalPlayerMinutes: Math.round(totalPlayerMinutes),
            daysCovered: dayEntries.length
        }
    });
});

/** Staff Activity — full shift history table for this server, sorted by
 *  most active first, filterable by time range. */
router.get('/:serverCode/staff-activity', verifyServerAdmin, async (req, res) => {
    const { serverCode } = req.params;
    const range = req.query.range || 'week';
    const rangeMs = range === '24h' ? 86400000 : range === '3days' ? 3 * 86400000 : 7 * 86400000;
    const cutoff = Date.now() - rangeMs;

    const ownerId  = serverOwners[serverCode];
    const adminIds = [...(serverAdmins[serverCode] || new Set())];
    const allIds   = [...new Set([ownerId, ...adminIds].filter(Boolean))];

    try {
        const rows = await Promise.all(allIds.map(async id => {
            const history = (shiftHistory[id] || []).filter(h => h.serverCode === serverCode && h.end >= cutoff);
            const totalDuty  = history.reduce((a, h) => a + h.duration, 0);
            const totalBreak = history.reduce((a, h) => a + h.breakDuration, 0);
            const totalPunishments = history.reduce((a, h) => a + h.punishments, 0);
            const live = activeAdmins[id];
            const username = live?.username || await resolveUsername(id);

            return {
                userId: id, username,
                role: id === ownerId ? 'owner' : 'admin',
                status: live?.status || 'Offline',
                updatedAt: live?.updatedAt || null,
                shiftStart: live?.status === 'on_duty' ? live.shiftStart : null,
                totalDutySeconds: totalDuty,
                totalBreakSeconds: totalBreak,
                totalPunishments,
                sessions: history.length
            };
        }));

        rows.sort((a, b) => (b.totalDutySeconds + b.totalPunishments * 60) - (a.totalDutySeconds + a.totalPunishments * 60));
        res.json({ range, staff: rows });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load staff activity' });
    }
});

/** Session chat */
router.get('/:serverCode/chat', verifyServerAdmin, (req, res) => {
    res.json({ messages: sessionChat[req.params.serverCode] || [] });
});

router.post('/:serverCode/chat', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const { message } = req.body;
    const admin = activeAdmins[req.callerId];

    if (!message || !message.trim()) return res.status(400).json({ error: 'Empty message' });
    if (message.trim().length > 300) return res.status(400).json({ error: 'Message too long' });

    const msg = {
        type: 'message', text: message.trim(),
        senderId: req.callerId, senderName: admin?.username || 'Unknown',
        senderRole: req.serverRole, timestamp: Date.now()
    };
    pushSessionChat(serverCode, msg);
    res.json({ success: true, message: msg });
});

/** Generic command dispatch — kick/ban/freeze/unfreeze/bring/to/warn/
 *  message/health/lock/unlock/shutdown. Freeze/unfreeze always routes
 *  through the shared toggle helper so this endpoint can never diverge
 *  from the dedicated /api/punishments/freeze behavior again. */
router.post('/:serverCode/commands', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const { action, target, targetId, targetUsername, reason, duration, newHealth } = req.body;
    const userId = req.callerId;
    const admin  = activeAdmins[userId];

    if (!action) return res.status(400).json({ error: 'Action required' });

    const dutyOnlyActions = ['kick', 'ban', 'freeze', 'unfreeze', 'bring', 'to', 'shutdown', 'warn', 'message', 'health', 'lock', 'unlock'];
    if (dutyOnlyActions.includes(action) && (!admin || admin.status !== 'on_duty' || admin.serverCode !== serverCode)) {
        return res.status(403).json({ error: 'You must be on duty in this server' });
    }

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];

    if (action === 'freeze' || action === 'unfreeze') {
        const result = toggleFreezeState(serverCode, targetId, target || targetUsername, userId, admin?.username);
        trackShiftPunishment(userId);
        pushAuditLog(serverCode, {
            type: 'punishment', punishmentType: result.action,
            actorId: userId, actorUsername: admin?.username || 'Unknown',
            targetId: parseInt(targetId) || null, targetUsername: target || targetUsername,
            revocable: result.action === 'freeze'
        });
        return res.json({ success: true, action: result.action });
    }

    const cmd = {
        action, target, targetId, targetUsername, reason, duration, newHealth: newHealth ?? null,
        senderId: userId, senderName: admin?.username || 'Unknown', issuedAt: Date.now()
    };
    commandsQueue[serverCode].push(cmd);

    if (['kick', 'ban', 'warn'].includes(action)) trackShiftPunishment(userId);

    if (['kick', 'ban', 'warn'].includes(action) && admin) {
        pushSessionChat(serverCode, {
            type: 'system',
            text: `${admin.username} executed ${action} on ${target || targetUsername || 'target'}`,
            senderId: userId, senderName: admin.username, timestamp: Date.now(), commandRef: action
        });
    }

    if (action === 'message') {
        pushAuditLog(serverCode, {
            type: 'broadcast', actorId: userId, actorUsername: admin?.username || 'Unknown',
            target, reason
        });
    }
    if (action === 'health') {
        pushAuditLog(serverCode, {
            type: 'command', commandType: 'health',
            actorId: userId, actorUsername: admin?.username || 'Unknown',
            targetUsername: target, newHealth: newHealth ?? null
        });
    }
    if (action === 'lock' || action === 'unlock') {
        pushAuditLog(serverCode, {
            type: 'command', commandType: action,
            actorId: userId, actorUsername: admin?.username || 'Unknown'
        });
    }
    if (action === 'shutdown') {
        pushAuditLog(serverCode, {
            type: 'command', commandType: 'shutdown',
            actorId: userId, actorUsername: admin?.username || 'Unknown'
        });
    }

    res.json({ success: true });
});

/* ============================================================
   BACKGROUND CLEANUP
   - Fully offline (no heartbeat 7s): full teardown of live state.
   - Empty of players but still heartbeating: after the configured
     grace period, evict any dashboard admins viewing it WITHOUT
     tearing down the live server (it's still running, just empty).
   - Fires scheduled shutdowns when their time arrives.
============================================================ */
setInterval(() => {
    const now = Date.now();
    const cfg = getConfig();

    Object.keys(liveServers).forEach(serverCode => {
        const server = liveServers[serverCode];

        if (now - server.lastUpdated > 7000) {
            delete liveServers[serverCode];
            delete commandsQueue[serverCode];
            delete scheduledShutdowns[serverCode];
            delete sessionChat[serverCode];
            delete serverLocations[serverCode];
            delete dashboardWatchers[serverCode];
            delete emptyServerTimers[serverCode];

            Object.values(activeAdmins).forEach(admin => {
                if (admin.serverCode === serverCode) {
                    admin.status = 'Online';
                    admin.serverCode = null;
                    admin.updatedAt = new Date().toISOString();
                    admin.serverWentOffline = true;
                    admin.serverWentOfflineAt = now;
                }
            });
            broadcastEvent(serverCode, 'server_offline', {});
            return;
        }

        // Empty-server grace eviction
        const timer = emptyServerTimers[serverCode];
        if (timer && !timer.evicted && server.totalPlayers === 0) {
            const graceMs = (cfg.emptyServerGraceSeconds || 5) * 1000;
            if (now - timer.since >= graceMs) {
                timer.evicted = true;
                let anyEvicted = false;
                Object.values(activeAdmins).forEach(admin => {
                    if (admin.serverCode === serverCode) {
                        admin.status = 'Online';
                        admin.serverCode = null;
                        admin.updatedAt = new Date().toISOString();
                        admin.emptyEviction = true;
                        admin.emptyEvictionAt = now;
                        anyEvicted = true;
                    }
                });
                if (anyEvicted) broadcastEvent(serverCode, 'server_empty', {});
            }
        }

        // Fire scheduled shutdown
        if (scheduledShutdowns[serverCode] && now >= scheduledShutdowns[serverCode].executeAt) {
            const sched = scheduledShutdowns[serverCode];
            if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
            commandsQueue[serverCode].push({
                action: 'shutdown', reason: 'Scheduled shutdown',
                senderId: sched.senderId, senderName: sched.senderName || 'System',
                issuedAt: now
            });
            delete scheduledShutdowns[serverCode];
        }
    });
}, 3000);

module.exports = router;
