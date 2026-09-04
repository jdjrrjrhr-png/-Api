'use strict';

const express = require('express');
const router  = express.Router();
const {
    warnStore, banStore, freezeStore,
    commandsQueue, activeAdmins, liveServers,
    generateCaseId, formatDuration, pushAuditLog, pushSessionChat
} = require('../state');
const { verifyAdminAccess, verifyRobloxToken, smartRateLimiter, getUserRole } = require('../middleware/auth');

const discordWebhook = process.env.DiscordWebhookUrl;

async function sendDiscordWebhook(embed) {
    if (!discordWebhook) return;
    try {
        await fetch(discordWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch {}
}

// ─── BAN ───
router.post('/ban', smartRateLimiter, verifyAdminAccess, async (req, res) => {
    const {
        serverCode, bannedUserName, bannedUserId,
        responsibleId, responsibleUsername,
        duration, reason
    } = req.body;

    if (!bannedUserId) return res.status(400).json({ error: 'bannedUserId required' });

    const caseId    = generateCaseId();
    const unbanTime = duration === -1 ? -1 : Date.now() + parseInt(duration) * 1000;
    const admin     = activeAdmins[req.adminId];

    const banEntry = {
        caseId,
        userId: parseInt(bannedUserId),
        username: bannedUserName || String(bannedUserId),
        responsibleId: responsibleId || req.adminId,
        responsibleUsername: responsibleUsername || admin?.username || 'Unknown',
        duration: parseInt(duration) || -1,
        reason: reason || 'No reason provided',
        bannedAt: Date.now(),
        unbanTime
    };

    banStore[bannedUserId] = banEntry;

    // Queue kick command for live server
    if (serverCode && commandsQueue[serverCode] !== undefined) {
        if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
        commandsQueue[serverCode].push({
            action: 'ban',
            target: bannedUserName,
            targetId: bannedUserId,
            reason,
            duration: parseInt(duration) || -1,
            senderId: req.adminId,
            senderName: admin?.username || 'Unknown',
            issuedAt: Date.now()
        });
    }

    pushAuditLog(serverCode || 'global', {
        type: 'punishment',
        punishmentType: 'ban',
        caseId,
        actorId: req.adminId,
        actorUsername: admin?.username || responsibleUsername || 'Unknown',
        targetId: parseInt(bannedUserId),
        targetUsername: bannedUserName,
        reason: reason || 'No reason provided',
        duration: parseInt(duration) || -1,
        unbanTime,
        revocable: true
    });

    // System chat message
    if (serverCode) {
        pushSessionChat(serverCode, {
            type: 'system',
            text: `${admin?.username || 'Admin'} banned ${bannedUserName || bannedUserId}${reason ? ` — ${reason}` : ''}`,
            timestamp: Date.now()
        });
    }

    await sendDiscordWebhook({
        title: 'Player Banned',
        color: 0xff0000,
        fields: [
            { name: 'Player',      value: `${bannedUserName} (${bannedUserId})`, inline: true },
            { name: 'By',          value: `${admin?.username || responsibleUsername} (${responsibleId || req.adminId})`, inline: true },
            { name: 'Duration',    value: formatDuration(parseInt(duration) || -1),  inline: true },
            { name: 'Reason',      value: reason || 'No reason provided', inline: false },
            { name: 'Case ID',     value: caseId, inline: true }
        ],
        timestamp: new Date().toISOString()
    });

    res.json({ success: true, caseId });
});

// ─── UNBAN ───
router.post('/unban', smartRateLimiter, verifyAdminAccess, async (req, res) => {
    const { userId, responsibleUsername, reason } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const admin = activeAdmins[req.adminId];
    const prevBan = banStore[userId];
    delete banStore[userId];

    pushAuditLog('global', {
        type: 'punishment',
        punishmentType: 'unban',
        actorId: req.adminId,
        actorUsername: admin?.username || responsibleUsername || 'Unknown',
        targetId: parseInt(userId),
        targetUsername: prevBan?.username || String(userId),
        reason: reason || 'No reason provided',
        revocable: false
    });

    await sendDiscordWebhook({
        title: 'Player Unbanned',
        color: 0x00ff99,
        fields: [
            { name: 'Player', value: `${prevBan?.username || userId} (${userId})`, inline: true },
            { name: 'By',     value: admin?.username || responsibleUsername || 'Unknown',    inline: true },
            { name: 'Reason', value: reason || 'No reason provided', inline: false }
        ],
        timestamp: new Date().toISOString()
    });

    res.json({ success: true });
});

// ─── GET BAN ───
router.get('/ban/:userId', verifyAdminAccess, (req, res) => {
    const ban = banStore[req.params.userId];
    if (!ban) return res.status(404).json({ error: 'No active ban' });
    res.json(ban);
});

// ─── KICK ───
router.post('/kick', smartRateLimiter, verifyAdminAccess, async (req, res) => {
    const { serverCode, target, targetId, targetUsername, reason } = req.body;
    if (!serverCode || !target) return res.status(400).json({ error: 'serverCode and target required' });

    const admin = activeAdmins[req.adminId];

    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
    commandsQueue[serverCode].push({
        action: 'kick', target, targetId,
        reason: reason || 'No reason provided',
        senderId: req.adminId,
        senderName: admin?.username || 'Unknown',
        issuedAt: Date.now()
    });

    pushAuditLog(serverCode, {
        type: 'punishment',
        punishmentType: 'kick',
        actorId: req.adminId,
        actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(targetId) || null,
        targetUsername: target,
        reason: reason || 'No reason provided',
        revocable: false
    });

    await sendDiscordWebhook({
        title: 'Player Kicked',
        color: 0xff9900,
        fields: [
            { name: 'Player', value: `${target} (${targetId})`, inline: true },
            { name: 'By',     value: admin?.username || 'Unknown',  inline: true },
            { name: 'Reason', value: reason || 'No reason provided', inline: false }
        ],
        timestamp: new Date().toISOString()
    });

    res.json({ success: true });
});

// ─── WARN ───
router.post('/warn', smartRateLimiter, verifyAdminAccess, async (req, res) => {
    const { serverCode, toWho, toWhoId, responsibleId, responsibleUsername, reason, time } = req.body;
    if (!toWhoId) return res.status(400).json({ error: 'toWhoId required' });

    const admin  = activeAdmins[req.adminId];
    const caseId = generateCaseId();

    if (!warnStore[toWhoId]) warnStore[toWhoId] = [];
    warnStore[toWhoId].push({
        caseId,
        targetId: parseInt(toWhoId),
        targetUsername: toWho,
        responsibleId: responsibleId || req.adminId,
        responsibleUsername: responsibleUsername || admin?.username || 'Unknown',
        reason: reason || 'No reason provided',
        warnedAt: Date.now(),
        expiresAt: time && time !== -1 ? Date.now() + parseInt(time) * 1000 : -1
    });

    // Queue warn command to notify in-game
    if (serverCode) {
        if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
        commandsQueue[serverCode].push({
            action: 'warn',
            target: toWho,
            targetId: toWhoId,
            reason,
            caseId,
            senderId: req.adminId,
            senderName: admin?.username || 'Unknown',
            issuedAt: Date.now()
        });
    }

    pushAuditLog(serverCode || 'global', {
        type: 'punishment',
        punishmentType: 'warn',
        caseId,
        actorId: req.adminId,
        actorUsername: admin?.username || responsibleUsername || 'Unknown',
        targetId: parseInt(toWhoId),
        targetUsername: toWho,
        reason: reason || 'No reason provided',
        revocable: true
    });

    await sendDiscordWebhook({
        title: 'Player Warned',
        color: 0xffcc00,
        fields: [
            { name: 'Player',  value: `${toWho} (${toWhoId})`,                   inline: true },
            { name: 'By',      value: admin?.username || responsibleUsername || 'Unknown', inline: true },
            { name: 'Reason',  value: reason || 'No reason provided',             inline: false },
            { name: 'Case ID', value: caseId,                                     inline: true }
        ],
        timestamp: new Date().toISOString()
    });

    res.json({ success: true, caseId });
});

// ─── UNWARN ───
router.post('/unwarn', smartRateLimiter, verifyAdminAccess, async (req, res) => {
    const { serverCode, who, whoId, caseId } = req.body;
    if (!whoId || !caseId) return res.status(400).json({ error: 'whoId and caseId required' });

    const admin = activeAdmins[req.adminId];
    if (!warnStore[whoId]) return res.status(404).json({ error: 'No warns found' });

    const idx = warnStore[whoId].findIndex(w => w.caseId === caseId);
    if (idx === -1) return res.status(404).json({ error: 'Case ID not found' });

    const removed = warnStore[whoId].splice(idx, 1)[0];

    pushAuditLog(serverCode || 'global', {
        type: 'punishment',
        punishmentType: 'unwarn',
        caseId,
        actorId: req.adminId,
        actorUsername: admin?.username || 'Unknown',
        targetId: parseInt(whoId),
        targetUsername: who || removed.targetUsername,
        reason: `Removed warn: ${removed.reason}`,
        revocable: false
    });

    res.json({ success: true, removed });
});

// ─── GET WARNS ───
router.get('/warns/:userId', verifyAdminAccess, (req, res) => {
    const warns = (warnStore[req.params.userId] || []).map((w, i) => ({
        ...w,
        index: i + 1
    }));
    res.json({ warns, total: warns.length });
});

// ─── FREEZE / UNFREEZE ───
router.post('/freeze', smartRateLimiter, verifyAdminAccess, (req, res) => {
    const { serverCode, targetUsername, targetId, responsibleId, responsibleUsername } = req.body;
    if (!serverCode || !targetId) return res.status(400).json({ error: 'serverCode and targetId required' });

    const admin = activeAdmins[req.adminId];
    const isFrozen = !!freezeStore[targetId];

    if (isFrozen) {
        delete freezeStore[targetId];
        if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
        commandsQueue[serverCode].push({
            action: 'unfreeze',
            target: targetUsername,
            targetId,
            senderId: req.adminId,
            senderName: admin?.username || 'Unknown',
            issuedAt: Date.now()
        });
        pushAuditLog(serverCode, {
            type: 'punishment', punishmentType: 'unfreeze',
            actorId: req.adminId, actorUsername: admin?.username || 'Unknown',
            targetId: parseInt(targetId), targetUsername, revocable: false
        });
        return res.json({ success: true, action: 'unfrozen' });
    } else {
        freezeStore[targetId] = { targetId, targetUsername, frozenAt: Date.now(), responsibleId: req.adminId };
        if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];
        commandsQueue[serverCode].push({
            action: 'freeze',
            target: targetUsername,
            targetId,
            senderId: req.adminId,
            senderName: admin?.username || 'Unknown',
            issuedAt: Date.now()
        });
        pushAuditLog(serverCode, {
            type: 'punishment', punishmentType: 'freeze',
            actorId: req.adminId, actorUsername: admin?.username || 'Unknown',
            targetId: parseInt(targetId), targetUsername, revocable: true
        });
        return res.json({ success: true, action: 'frozen' });
    }
});

// ─── GET ALL PUNISHED USERS ───
router.get('/list', verifyAdminAccess, (req, res) => {
    const type = req.query.type; // 'ban' | 'warn' | 'freeze' | 'kick'

    if (type === 'ban') {
        return res.json({ items: Object.values(banStore) });
    }
    if (type === 'warn') {
        const allWarns = [];
        Object.values(warnStore).forEach(warns => {
            warns.forEach(w => allWarns.push(w));
        });
        return res.json({ items: allWarns });
    }
    if (type === 'freeze') {
        return res.json({ items: Object.values(freezeStore) });
    }

    res.json({
        bans: Object.values(banStore).length,
        warns: Object.values(warnStore).reduce((a, b) => a + b.length, 0),
        freezes: Object.values(freezeStore).length
    });
});

// ─── ROBLOX MODULE: Accept punishment log (from server script) ───
// These endpoints let the Roblox server tell the API "I executed this punishment"
// so it appears in logs — they don't command the server back.
router.post('/log', verifyRobloxToken, (req, res) => {
    const { serverCode, type, ...rest } = req.body;
    pushAuditLog(serverCode || 'global', {
        type: 'punishment',
        punishmentType: type,
        ...rest,
        source: 'roblox',
        timestamp: Date.now()
    });
    res.json({ success: true });
});

module.exports = router;
