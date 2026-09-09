'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
    mapBounds: { X_min: -800, X_max: 800, Z_min: -800, Z_max: 800 },
    mapImagePath: '/img/TopdownMap.png',
    teams: ['BusCompany', 'Citizen', 'FireDepartment', 'HARS', 'Police', 'Prisoner', 'TruckCompany'],
    heartbeatInterval: 2,
    mapStreamInterval: 1.3,
    mapMinPlayers: 10,
    maxAuditLogs: 25,
    maxChatMessages: 30,
    warnCaseIdLength: 6,
    emptyServerGraceSeconds: 5,
    dutyActionCooldownSeconds: 3,
    serverCodeSegments: 5,
    serverCodeSegmentLength: 4,
    serverCodeRegenerateCooldown: 900,
    scheduledShutdownMaxDays: 14,
    refreshCooldownSeconds: 10,
    dashboardWatchTimeoutMs: 8000,
    positionMinStuds: 7
};

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...parsed, mapBounds: { ...DEFAULTS.mapBounds, ...(parsed.mapBounds || {}) } };
    } catch (e) {
        console.error('[config] Failed to load config.json, using defaults:', e.message);
        return { ...DEFAULTS };
    }
}

let cached = loadConfig();

module.exports = {
    getConfig: () => cached,
    reloadConfig: () => { cached = loadConfig(); return cached; }
};
