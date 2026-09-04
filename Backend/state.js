'use strict';

/**
 * Central in-memory state store.
 * All routes import from here to share state without circular deps.
 */

// --- ADMIN LISTS (edit these) ---
const ALLOWED_ADMINS = [2748615471, 9801416277];
const INGAME_MODS   = [2748615471, 9801416277];
const SERVER_OWNERS = [2748615471];

// --- LIVE STATE ---
const liveServers     = {};  // serverCode -> server data
const commandsQueue   = {};  // serverCode -> pending command array
const oauthStates     = {};  // state -> { status, adminData, time }
const activeAdmins    = {};  // userId -> admin session object
const globalTracking  = {};  // userId -> { username, jobId, joinedAt }
const scheduledShutdowns = {}; // serverCode -> { executeAt, formattedTime, senderId }
const auditLogs       = {};  // serverCode -> Array (max 25)
const warnStore       = {};  // userId -> Array of warn objects
const banStore        = {};  // userId -> ban object
const freezeStore     = {};  // userId -> freeze object
const inventoryStore  = {};  // serverCode+userId -> inventory array
const sessionChat     = {};  // serverCode -> Array (max 30, ephemeral)
const serverApiKeys   = {};  // serverCode -> { key, generatedAt, cooldownUntil }
const serverMeta      = {};  // serverCode -> { name, joinCode, ownerId }
const serverLocations = {};  // serverCode -> Array of location markers
const apiKeyRegenCooldowns = {}; // serverCode -> timestamp

// --- HELPERS ---
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
    if (!auditLogs[serverCode]) auditLogs[serverCode] = [];
    entry.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    entry.timestamp = Date.now();
    auditLogs[serverCode].unshift(entry);
    if (auditLogs[serverCode].length > 25) {
        auditLogs[serverCode] = auditLogs[serverCode].slice(0, 25);
    }
}

function pushSessionChat(serverCode, message) {
    if (!sessionChat[serverCode]) sessionChat[serverCode] = [];
    sessionChat[serverCode].push(message);
    if (sessionChat[serverCode].length > 30) {
        sessionChat[serverCode] = sessionChat[serverCode].slice(-30);
    }
}

function generateCaseId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function generateServerApiKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function formatDuration(seconds) {
    if (seconds === -1) return 'Permanent';
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

module.exports = {
    ALLOWED_ADMINS,
    INGAME_MODS,
    SERVER_OWNERS,
    liveServers,
    commandsQueue,
    oauthStates,
    activeAdmins,
    globalTracking,
    scheduledShutdowns,
    auditLogs,
    warnStore,
    banStore,
    freezeStore,
    inventoryStore,
    sessionChat,
    serverApiKeys,
    serverMeta,
    serverLocations,
    apiKeyRegenCooldowns,
    getOrInitServer,
    pushAuditLog,
    pushSessionChat,
    generateCaseId,
    generateServerApiKey,
    formatDuration
};
