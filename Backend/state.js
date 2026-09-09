'use strict';

/**
 * Central in-memory state store.
 * All routes import from here to share state without circular deps.
 */

// --- ADMIN ROSTER (dynamic — no more hardcoded lists) ---
// This used to be 3 hardcoded arrays that were completely disconnected from the
// UpdateAdmins / SetOwner commands sent by the Roblox module. Editing those arrays
// (or removing an ID from them) never matched what UpdateAdmins actually did, which
// is how an owner could get locked out of their own dashboard. Now everything is
// driven by two live commands from the Roblox module:
//   - POST /:serverCode/admins   (UpdateAdmins)  -> sets global admins + this server's mods
//   - POST /:serverCode/owner    (SetOwner)      -> sets this server's owner
const adminRoster = {
    globalAdmins: new Set()   // userIds with admin access across every server
};
const serverStaff = {};       // serverCode -> { mods: Set<userId>, ownerId: number|null }

function getServerStaff(serverCode) {
    if (!serverStaff[serverCode]) {
        serverStaff[serverCode] = { mods: new Set(), ownerId: null };
    }
    return serverStaff[serverCode];
}

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
const serverApiKeys   = {};  // serverCode -> { key, generatedAt }
const apiKeyGrace     = {};  // serverCode -> { previousKey, expiresAt } (rotation grace window)
const serverMeta      = {};  // serverCode -> { name, joinCode, ownerId }
const serverLocations = {};  // serverCode -> Array of location markers
const apiKeyRegenCooldowns = {}; // serverCode -> timestamp
const dutyCooldowns   = {};  // userId -> timestamp of last duty action (anti-spam)

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

// Stronger, more complex API key: 5 segments, each char randomly upper/lower/digit/symbol,
// and guaranteed not to collide with any key currently in use.
const API_KEY_SYMBOLS = '!@#$';
function generateServerApiKeyRaw() {
    const pools = [
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ', // capital
        'abcdefghijklmnopqrstuvwxyz', // small
        '0123456789',                 // digit
        API_KEY_SYMBOLS               // symbol
    ];
    const randChar = () => {
        const pool = pools[Math.floor(Math.random() * pools.length)];
        return pool[Math.floor(Math.random() * pool.length)];
    };
    const seg = () => Array.from({ length: 5 }, randChar).join('');
    return `${seg()}-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function generateServerApiKey() {
    const inUse = new Set(Object.values(serverApiKeys).map(k => k.key));
    let key;
    do {
        key = generateServerApiKeyRaw();
    } while (inUse.has(key));
    return key;
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
    adminRoster,
    serverStaff,
    getServerStaff,
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
    apiKeyGrace,
    serverMeta,
    serverLocations,
    apiKeyRegenCooldowns,
    dutyCooldowns,
    getOrInitServer,
    pushAuditLog,
    pushSessionChat,
    generateCaseId,
    generateServerApiKey,
    formatDuration
};
