'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

const IMG_DIR = path.join(__dirname, '..', 'img');

/**
 * Central in-memory state store.
 *
 * IMPORTANT ARCHITECTURE NOTE:
 * There is no static admin/owner list anymore. Permissions are entirely
 * per-server and driven by two Roblox module commands:
 *   - Shield.UpdateAdmins(adminIdsArray)  -> setServerAdmins()
 *   - Shield.SetServerOwner(userId)       -> setServerOwner()
 * A user's role for a given server is resolved live via getServerRole().
 * This is intentional: editing a hardcoded array in this file is no longer
 * how you grant access — call the module functions from your Roblox server.
 */

// --- LIVE STATE ---
const liveServers        = {};  // serverCode -> server data
const commandsQueue      = {};  // serverCode -> pending command array
const oauthStates        = {};  // state -> { status, adminData, time }
const activeAdmins       = {};  // userId -> live dashboard session object
const globalTracking     = {};  // userId -> { username, jobId, serverCode, joinedAt }
const scheduledShutdowns = {};  // serverCode -> { executeAt, formattedTime, senderId, senderName }
const auditLogs          = {};  // serverCode -> Array (max config.maxAuditLogs)
const warnStore          = {};  // userId -> Array of warn objects
const banStore           = {};  // userId -> ban object
const freezeStore        = {};  // userId -> freeze object
const inventoryStore     = {};  // "serverCode:userId" -> inventory record
const sessionChat        = {};  // serverCode -> Array (max config.maxChatMessages, ephemeral)
const serverMeta         = {};  // serverCode -> { name, joinCode, keyGeneratedAt }
const serverLocations    = {};  // serverCode -> Array of location markers

// --- PER-SERVER PERMISSIONS (replaces static admin arrays) ---
const serverAdmins = {};  // serverCode -> Set<userId>
const serverOwners = {};  // serverCode -> userId
const usedApiKeys  = new Set(); // all currently-issued server codes/keys, for uniqueness

// --- PRESENCE / WATCHING ---
const dashboardWatchers = {}; // serverCode -> { lastSeen: timestamp }
const emptyServerTimers = {}; // serverCode -> { since: timestamp, evicted: bool }
const dutyActionCooldowns = {}; // userId -> last action timestamp
const apiKeyRegenCooldowns = {}; // serverCode -> timestamp cooldown expires

// --- STATS / HISTORY ---
const shiftHistory       = {}; // userId -> Array of past shift records
const serverStatsSamples = {}; // serverCode -> Array of { t, c } player-count samples
const knownUsers         = {}; // userId -> { username, updatedAt } — cache for users never seen live

// ============================================================
// HELPERS
// ============================================================

function getOrInitServer(serverCode) {
    if (!liveServers[serverCode]) {
        liveServers[serverCode] = {
            serverCode,
            startTime: Date.now(),
            totalPlayers: 0,
            players: [],
            teamsSummary: {},
            lastUpdated: Date.now()
        };
    }
    return liveServers[serverCode];
}

function pushAuditLog(serverCode, entry) {
    const cfg = getConfig();
    if (!auditLogs[serverCode]) auditLogs[serverCode] = [];
    entry.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    entry.timestamp = Date.now();
    auditLogs[serverCode].unshift(entry);
    if (auditLogs[serverCode].length > cfg.maxAuditLogs) {
        auditLogs[serverCode] = auditLogs[serverCode].slice(0, cfg.maxAuditLogs);
    }
}

function pushSessionChat(serverCode, message) {
    const cfg = getConfig();
    if (!sessionChat[serverCode]) sessionChat[serverCode] = [];
    sessionChat[serverCode].push(message);
    if (sessionChat[serverCode].length > cfg.maxChatMessages) {
        sessionChat[serverCode] = sessionChat[serverCode].slice(-cfg.maxChatMessages);
    }
}

function generateCaseId() {
    const cfg = getConfig();
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < (cfg.warnCaseIdLength || 6); i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

/**
 * New complex server API key format: N segments (default 5) joined by '-',
 * each segment a random mix of upper/lower/digit/symbol from !@#$.
 * Enforces global uniqueness against every key ever issued this run.
 */
function generateServerApiKey() {
    const cfg = getConfig();
    const segments = cfg.serverCodeSegments || 5;
    const segLen = cfg.serverCodeSegmentLength || 4;
    const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$';

    const seg = () => {
        let s = '';
        for (let i = 0; i < segLen; i++) s += pool[Math.floor(Math.random() * pool.length)];
        return s;
    };

    let key, attempts = 0;
    do {
        key = Array.from({ length: segments }, seg).join('-');
        attempts++;
    } while (usedApiKeys.has(key) && attempts < 25);

    usedApiKeys.add(key);
    return key;
}

/** Mask a key for display: keep first and last segment, mask the rest */
function maskApiKey(key) {
    if (!key) return '';
    const parts = key.split('-');
    if (parts.length < 2) return '*'.repeat(key.length);
    return parts.map((p, i) => (i === 0 || i === parts.length - 1) ? p : '*'.repeat(p.length)).join('-');
}

function formatDuration(seconds) {
    if (seconds === -1) return 'Permanent';
    if (!seconds || seconds < 0) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    let str = '';
    if (d > 0) str += `${d}d `;
    if (h > 0) str += `${h}h `;
    if (m > 0) str += `${m}m `;
    str += `${s}s`;
    return str.trim();
}

// ============================================================
// PER-SERVER PERMISSIONS
// ============================================================

/** Returns 'owner' | 'admin' | null — the ONLY source of truth for permissions */
function getServerRole(serverCode, userId) {
    const id = parseInt(userId);
    if (!serverCode || !id) return null;
    if (serverOwners[serverCode] === id) return 'owner';
    if (serverAdmins[serverCode] && serverAdmins[serverCode].has(id)) return 'admin';
    return null;
}

/** Replaces the admin set for a server. Returns userIds that were removed (for eviction). */
function setServerAdmins(serverCode, idsArray) {
    const newSet = new Set((idsArray || []).map(id => parseInt(id)).filter(Boolean));
    const prevSet = serverAdmins[serverCode] || new Set();
    const ownerId = serverOwners[serverCode];
    const removed = [...prevSet].filter(id => !newSet.has(id) && id !== ownerId);
    serverAdmins[serverCode] = newSet;
    return removed;
}

function setServerOwner(serverCode, userId) {
    const id = parseInt(userId);
    if (!id) return;
    serverOwners[serverCode] = id;
}

/** Move all per-server state from oldCode to newCode (used on API key rotation) */
function rekeyServer(oldCode, newCode) {
    if (!oldCode || oldCode === newCode) return;

    const objectMaps = [
        liveServers, commandsQueue, scheduledShutdowns, auditLogs, sessionChat,
        serverLocations, serverMeta, dashboardWatchers, emptyServerTimers, serverStatsSamples
    ];
    objectMaps.forEach(m => {
        if (m[oldCode] !== undefined) {
            m[newCode] = m[oldCode];
            delete m[oldCode];
        }
    });

    if (serverAdmins[oldCode]) { serverAdmins[newCode] = serverAdmins[oldCode]; delete serverAdmins[oldCode]; }
    if (serverOwners[oldCode] !== undefined) { serverOwners[newCode] = serverOwners[oldCode]; delete serverOwners[oldCode]; }
    if (liveServers[newCode]) liveServers[newCode].serverCode = newCode;

    usedApiKeys.delete(oldCode);
    usedApiKeys.add(newCode);
}

// ============================================================
// USERNAME RESOLUTION (for staff who've never opened the dashboard)
// ============================================================

function cacheUsername(userId, username) {
    const id = parseInt(userId);
    if (!id || !username) return;
    knownUsers[id] = { username, updatedAt: Date.now() };
}

async function resolveUsername(userId) {
    const id = parseInt(userId);
    const cached = knownUsers[id];
    if (cached && Date.now() - cached.updatedAt < 24 * 3600 * 1000) return cached.username;
    try {
        const r = await fetch(`https://users.roblox.com/v1/users/${id}`);
        const d = await r.json();
        const username = d.name || `User_${id}`;
        knownUsers[id] = { username, updatedAt: Date.now() };
        return username;
    } catch {
        return cached?.username || `User_${id}`;
    }
}

// ============================================================
// LOCATION IMAGE RESOLUTION
// ============================================================

function findLocationImage(locationName) {
    try {
        const safe = String(locationName).replace(/[^a-zA-Z0-9_-]/g, '');
        const candidate = path.join(IMG_DIR, `${safe}.png`);
        if (fs.existsSync(candidate)) return `/img/${safe}.png`;
    } catch { /* ignore */ }
    return null;
}

// ============================================================
// EMPTY-SERVER GRACE TIMER (point: evict dashboard when server empties)
// ============================================================

function markServerEmpty(serverCode) {
    if (emptyServerTimers[serverCode]) return;
    emptyServerTimers[serverCode] = { since: Date.now(), evicted: false };
}

function cancelServerEmpty(serverCode) {
    delete emptyServerTimers[serverCode];
}

// ============================================================
// DUTY COOLDOWN (anti-spam)
// ============================================================

function checkDutyCooldown(userId) {
    const cfg = getConfig();
    const cooldownMs = (cfg.dutyActionCooldownSeconds || 3) * 1000;
    const last = dutyActionCooldowns[userId] || 0;
    const now = Date.now();
    if (now - last < cooldownMs) return false;
    dutyActionCooldowns[userId] = now;
    return true;
}

// ============================================================
// FREEZE TOGGLE (shared — used by BOTH the generic command endpoint
// and the dedicated punishments endpoint so behavior can never diverge)
// ============================================================

function toggleFreezeState(serverCode, targetId, targetName, actorId, actorName) {
    const isFrozen = !!freezeStore[targetId];
    if (!commandsQueue[serverCode]) commandsQueue[serverCode] = [];

    if (isFrozen) {
        delete freezeStore[targetId];
        commandsQueue[serverCode].push({
            action: 'unfreeze', target: targetName, targetId,
            senderId: actorId, senderName: actorName, issuedAt: Date.now()
        });
        return { action: 'unfreeze' };
    } else {
        freezeStore[targetId] = {
            targetId, targetUsername: targetName, serverCode,
            frozenAt: Date.now(), responsibleId: actorId
        };
        commandsQueue[serverCode].push({
            action: 'freeze', target: targetName, targetId,
            senderId: actorId, senderName: actorName, issuedAt: Date.now()
        });
        return { action: 'freeze' };
    }
}

// ============================================================
// SHIFT PUNISHMENT TRACKING (for Staff Activity stats)
// ============================================================

function trackShiftPunishment(userId) {
    if (activeAdmins[userId] && activeAdmins[userId].status === 'on_duty') {
        activeAdmins[userId].shiftPunishments = (activeAdmins[userId].shiftPunishments || 0) + 1;
    }
}

// ============================================================
// STATS SAMPLING (for Server Stats charts)
// ============================================================

function pushStatsSample(serverCode, count) {
    if (!serverStatsSamples[serverCode]) serverStatsSamples[serverCode] = [];
    const arr = serverStatsSamples[serverCode];
    const last = arr[arr.length - 1];
    const now = Date.now();
    if (!last || now - last.t >= 60000 || last.c !== count) {
        arr.push({ t: now, c: count });
        if (arr.length > 20000) arr.splice(0, arr.length - 20000);
    }
}

module.exports = {
    liveServers, commandsQueue, oauthStates, activeAdmins, globalTracking,
    scheduledShutdowns, auditLogs, warnStore, banStore, freezeStore,
    inventoryStore, sessionChat, serverMeta, serverLocations,
    serverAdmins, serverOwners, usedApiKeys,
    dashboardWatchers, emptyServerTimers, dutyActionCooldowns, apiKeyRegenCooldowns,
    shiftHistory, serverStatsSamples, knownUsers,

    getOrInitServer, pushAuditLog, pushSessionChat, generateCaseId,
    generateServerApiKey, maskApiKey, formatDuration,
    getServerRole, setServerAdmins, setServerOwner, rekeyServer,
    cacheUsername, resolveUsername, findLocationImage,
    markServerEmpty, cancelServerEmpty, checkDutyCooldown,
    toggleFreezeState, trackShiftPunishment, pushStatsSample
};
