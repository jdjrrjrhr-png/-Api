'use strict';

const express = require('express');
const router  = express.Router();
const {
    warnStore, banStore, freezeStore, commandsQueue, activeAdmins,
    generateCaseId, pushAuditLog, pushSessionChat, toggleFreezeState, trackShiftPunishment
} = require('../state');
const { verifyServerAdmin, verifyRobloxToken, smartRateLimiter } = require('../middleware/auth');

// ─── BAN ───
router.post('/ban', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, bannedUserName, bannedUserId, duration, reason } = req.body;
    if (!bannedUserId) return res.status(400).json({ error: 'bannedUserId required' });

    const caseId    = generateCaseId();
    const unbanTime = duration === -1 ? -1 : Date.now() + parseInt(duration) * 1000;
    const admin     = activeAdmins[req.callerId];

    banStore[bannedUserId] = {
        caseId,
        userId: parseInt(bannedUserId),
        username: bannedUserName || String(bannedUserId),
        serverCode,
        responsibleId: req.callerId,
        responsibleUsername: admin?.username || 'Unknown',
        duration: parseInt(duration) || -1,
        reason: reason || 'No reason provided',
        bannedAt: Date.now(),
        unbanTime
    };

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'ban', target: bannedUserName, targetId: bannedUserId,
        reason, duration: parseInt(duration) || -1,
        senderId: req.callerId, senderName: admin?.username || 'Unknown', issuedAt: Date.now()
    });

    trackShiftPunishment(req.callerId);

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: 'ban', caseId,
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(bannedUserId), targetUsername: bannedUserName,
        reason: reason || 'No reason provided', duration: parseInt(duration) || -1,
        unbanTime, revocable: true
    });

    pushSessionChat(serverCode, {
        type: 'system',
        text: `${admin?.username || 'Admin'} banned ${bannedUserName || bannedUserId}${reason ? ` — ${reason}` : ''}`,
        timestamp: Date.now()
    });

    res.json({ success: true, caseId });
});

// ─── UNBAN ───
router.post('/unban', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, userId, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const admin = activeAdmins[req.callerId];
    const prevBan = banStore[userId];
    delete banStore[userId];

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: 'unban',
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(userId), targetUsername: prevBan?.username || String(userId),
        reason: reason || 'No reason provided', revocable: false
    });

    res.json({ success: true });
});

router.get('/ban/:userId', verifyServerAdmin, (req, res) => {
    const ban = banStore[req.params.userId];
    if (!ban) return res.status(404).json({ error: 'No active ban' });
    res.json(ban);
});

// ─── KICK ─── (reason optional; hold-to-confirm is enforced client-side)
router.post('/kick', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, target, targetId, reason } = req.body;
    if (!target) return res.status(400).json({ error: 'target required' });

    const admin = activeAdmins[req.callerId];

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'kick', target, targetId,
        reason: reason || 'No reason provided',
        senderId: req.callerId, senderName: admin?.username || 'Unknown', issuedAt: Date.now()
    });

    trackShiftPunishment(req.callerId);

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: 'kick',
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(targetId) || null, targetUsername: target,
        reason: reason || 'No reason provided', revocable: false
    });

    res.json({ success: true });
});

// ─── WARN ───
router.post('/warn', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, toWho, toWhoId, reason, time } = req.body;
    if (!toWhoId) return res.status(400).json({ error: 'toWhoId required' });

    const admin  = activeAdmins[req.callerId];
    const caseId = generateCaseId();

    if (!warnStore[toWhoId]) warnStore[toWhoId] = [];
    warnStore[toWhoId].push({
        caseId,
        targetId: parseInt(toWhoId),
        targetUsername: toWho,
        serverCode,
        responsibleId: req.callerId,
        responsibleUsername: admin?.username || 'Unknown',
        reason: reason || 'No reason provided',
        warnedAt: Date.now(),
        expiresAt: time && time !== -1 ? Date.now() + parseInt(time) * 1000 : -1
    });

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'warn', target: toWho, targetId: toWhoId, reason, caseId,
        senderId: req.callerId, senderName: admin?.username || 'Unknown', issuedAt: Date.now()
    });

    trackShiftPunishment(req.callerId);

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: 'warn', caseId,
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(toWhoId), targetUsername: toWho,
        reason: reason || 'No reason provided', revocable: true
    });

    res.json({ success: true, caseId });
});

// ─── UNWARN ───
router.post('/unwarn', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, who, whoId, caseId } = req.body;
    if (!whoId || !caseId) return res.status(400).json({ error: 'whoId and caseId required' });

    const admin = activeAdmins[req.callerId];
    if (!warnStore[whoId]) return res.status(404).json({ error: 'No warns found' });

    const idx = warnStore[whoId].findIndex(w => w.caseId === caseId);
    if (idx === -1) return res.status(404).json({ error: 'Case ID not found' });

    const removed = warnStore[whoId].splice(idx, 1)[0];

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: 'unwarn', caseId,
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(whoId), targetUsername: who || removed.targetUsername,
        reason: `Removed warn: ${removed.reason}`, revocable: false
    });

    res.json({ success: true, removed });
});

router.get('/warns/:userId', verifyServerAdmin, (req, res) => {
    const warns = (warnStore[req.params.userId] || []).map((w, i) => ({ ...w, index: i + 1 }));
    res.json({ warns, total: warns.length });
});

// ─── FREEZE / UNFREEZE ─── (delegates to the SAME toggle used by the
// generic /commands endpoint — this endpoint and that one can never
// disagree about a player's frozen state again)
router.post('/freeze', smartRateLimiter, verifyServerAdmin, (req, res) => {
    const { serverCode, targetUsername, targetId } = req.body;
    if (!targetId) return res.status(400).json({ error: 'targetId required' });

    const admin  = activeAdmins[req.callerId];
    const result = toggleFreezeState(serverCode, targetId, targetUsername, req.callerId, admin?.username);
    trackShiftPunishment(req.callerId);

    pushAuditLog(serverCode, {
        type: 'punishment', punishmentType: result.action,
        actorId: req.callerId, actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(targetId), targetUsername, revocable: result.action === 'freeze'
    });

    res.json({ success: true, action: result.action });
});

// ─── PUNISHED USERS LIST — server-scoped, with an "all" default tab ───
router.get('/list', verifyServerAdmin, (req, res) => {
    const code = req.query.serverCode;
    const type = req.query.type || 'all';

    const bans = Object.values(banStore)
        .filter(b => b.serverCode === code)
        .map(b => ({ ...b, itemType: 'ban', timestamp: b.bannedAt }));

    const warns = [];
    Object.values(warnStore).forEach(arr => arr.forEach(w => {
        if (w.serverCode === code) warns.push({ ...w, itemType: 'warn', timestamp: w.warnedAt });
    }));

    const freezes = Object.values(freezeStore)
        .filter(f => f.serverCode === code)
        .map(f => ({ ...f, itemType: 'freeze', timestamp: f.frozenAt }));

    if (type === 'ban')    return res.json({ items: bans });
    if (type === 'warn')   return res.json({ items: warns });
    if (type === 'freeze') return res.json({ items: freezes });

    const all = [...bans, ...warns, ...freezes].sort((a, b) => b.timestamp - a.timestamp);
    res.json({ items: all });
});

// ─── ROBLOX: accept a punishment log entry (no command sent back) ───
router.post('/log', verifyRobloxToken, (req, res) => {
    const { serverCode, type, ...rest } = req.body;
    pushAuditLog(serverCode || 'global', {
        type: 'punishment', punishmentType: type, ...rest,
        source: 'roblox', timestamp: Date.now()
    });
    res.json({ success: true });
});

module.exports = router;
