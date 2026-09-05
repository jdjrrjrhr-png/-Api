'use strict';
/* ================================================================
   Emergency Hamburg Dashboard — app.js
   Single-file SPA: routing, state, all UI logic
================================================================ */

const BASE_URL = window.location.origin;

// ── Config
const CFG = {
    serversRefreshCooldown: 10000,
    playersPollInterval:    2000,
    staffPollInterval:      3000,
    auditPollInterval:      4000,
    chatPollInterval:       2500,
    mapPollInterval:        5000,
    maxToastDuration:       3500,
};

// ── Session (sessionStorage — persists for tab lifetime)
const Session = {
    get() {
        try { return JSON.parse(sessionStorage.getItem('ehUser')); } catch { return null; }
    },
    set(u) { sessionStorage.setItem('ehUser', JSON.stringify(u)); },
    clear() { sessionStorage.removeItem('ehUser'); }
};

// ── App state
const State = {
    user:          null,
    serverCode:    null,    // current server being managed
    serverData:    null,
    players:       [],
    staff:         [],
    auditLogs:     [],
    chatMessages:  [],
    positions:     [],
    locations:     [],
    warnsByPlayer: {},
    mapFilters:    JSON.parse(localStorage.getItem('mapFilters') || 'null') || {
        BusCompany: true, Citizen: true, FireDepartment: true,
        HARS: true, Police: true, Prisoner: true, TruckCompany: true
    },
    dutyStatus:    'Online',    // Online | on_duty | break
    selectedPlayer: null,
    polls:         {},          // named intervals
    lastServersRefresh: 0,
    scheduledShutdown: null,
    pendingModals: [],
    chatSpamTracker: {},
};

/* ================================================================
   UTILITIES
================================================================ */
const UI = {
    icon(name) {
        const icons = {
            users:      `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
            shield:     `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
            ban:        `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
            warn:       `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
            refresh:    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
            search:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
            send:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
            close:      `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
            filter:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
            key:        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
            magnify:    `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
            eye:        `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
            eyeOff:     `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`,
            copy:       `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
            person:     `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
        };
        return icons[name] || '';
    },

    avatar(userId) {
        return `${BASE_URL}/api/auth/avatar/${userId}`;
    },

    timeAgo(ts) {
        const d = Math.floor((Date.now() - ts) / 1000);
        if (d < 60)   return d + 's ago';
        if (d < 3600) return Math.floor(d/60) + 'm ago';
        if (d < 86400)return Math.floor(d/3600) + 'h ago';
        return Math.floor(d/86400) + 'd ago';
    },

    formatTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    formatDateTime(ts) {
        return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    formatDuration(s) {
        if (!s) return '0s';
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        return `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m ' : ''}${sec}s`;
    },

    el(tag, cls, html = '') {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html) e.innerHTML = html;
        return e;
    },

    toggleTheme() {
        const html = document.documentElement;
        const isDark = html.dataset.theme === 'dark';
        html.dataset.theme = isDark ? 'light' : 'dark';
        localStorage.setItem('ehTheme', html.dataset.theme);
    },

    stars(count, total = 5) {
        let s = '';
        for (let i = 1; i <= total; i++) {
            s += `<span class="star-icon ${i <= count ? 'filled' : 'empty'}">★</span>`;
        }
        return s;
    }
};

// ── Toast
function toast(msg, type = 'info', duration = CFG.maxToastDuration) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => {
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 300);
    }, duration);
}

// ── API helper
async function api(method, path, body, silent = false) {
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(BASE_URL + path, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok && !silent) {
            toast(data.error || 'Request failed', 'error');
        }
        return { ok: res.ok, data, status: res.status };
    } catch (e) {
        if (!silent) toast('Network error', 'error');
        return { ok: false, data: {}, status: 0 };
    }
}

// ── Poll manager
function startPoll(name, fn, interval) {
    stopPoll(name);
    fn();
    State.polls[name] = setInterval(fn, interval);
}
function stopPoll(name) {
    if (State.polls[name]) { clearInterval(State.polls[name]); delete State.polls[name]; }
}
function stopAllPolls() {
    Object.keys(State.polls).forEach(stopPoll);
}

/* ================================================================
   AUTH GUARD
================================================================ */
function requireAuth() {
    State.user = Session.get();
    if (!State.user) {
        // Redirect to landing page with login intent
        window.location.href = '/Api?login=1';
        return false;
    }
    renderNavUser();
    // Register presence
    api('POST', '/api/auth/register', { userId: State.user.userId, username: State.user.username }, true);
    return true;
}

function renderNavUser() {
    const u = State.user;
    if (!u) return;
    document.getElementById('nav-avatar').src    = UI.avatar(u.userId);
    document.getElementById('nav-username').textContent = u.username;
    const badge = document.getElementById('nav-role-badge');
    badge.textContent = u.role || 'user';
    badge.className   = `user-pill-role role-${u.role || 'mod'}`;
}

/* ================================================================
   ROUTER
================================================================ */
const App = {
    navigate(page, params = {}) {
        stopAllPolls();
        State.serverCode = params.serverCode || null;
        State.selectedPlayer = null;

        const app = document.getElementById('app');
        app.innerHTML = '';
        app.className = 'fade';

        // Update nav active state
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const navBtn = document.getElementById(`nav-${page}`);
        if (navBtn) navBtn.classList.add('active');

        // Update browser URL
        const url = page === 'servers' ? '/Api/Dashboard'
            : page === 'server' ? `/Api/Dashboard/${params.serverCode}`
            : `/Api/Dashboard/${page}`;
        history.pushState({ page, params }, '', url);

        if (page === 'servers') Pages.servers();
        else if (page === 'server') Pages.server(params.serverCode);
    }
};

// Handle browser back/forward
window.addEventListener('popstate', e => {
    const state = e.state || { page: 'servers', params: {} };
    App.navigate(state.page, state.params);
});

/* ================================================================
   PAGE: SERVERS LIST
================================================================ */
const Pages = {
    servers() {
        const app = document.getElementById('app');
        app.innerHTML = `
        <div id="page-servers">
            <div class="servers-header">
                <h1 class="servers-title">Online servers you can moderate</h1>
                <button class="icon-btn" id="refresh-btn" onclick="Pages.refreshServers()" title="Refresh">
                    ${UI.icon('refresh')}
                </button>
            </div>
            <div class="warning-notice">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                Only servers where you have admin or owner access are displayed. Servers disappear when they go offline (no heartbeat for 7 seconds)
            </div>
            <div class="search-bar-wrap">
                ${UI.icon('search')}
                <input class="search-bar" id="server-search" placeholder="Search by server name or join code"
                    oninput="Pages.filterServers(this.value)">
            </div>
            <div class="server-list" id="server-list">
                <div class="empty-state">
                    ${UI.icon('refresh')}
                    <div style="margin-top:8px">Loading servers</div>
                </div>
            </div>
        </div>`;

        Pages.loadServers();

        // Auto-refresh every 8 seconds
        State.polls.serversList = setInterval(Pages.loadServers, 8000);
    },

    _allServers: [],

    async loadServers() {
        const u = State.user;
        const { ok, data } = await api('GET', `/api/servers/list?userId=${u.userId}&senderId=${u.userId}`, null, true);
        if (!ok) return;
        Pages._allServers = data.servers || [];
        Pages.renderServerList(Pages._allServers);
    },

    async refreshServers() {
        const btn = document.getElementById('refresh-btn');
        const now = Date.now();
        if (now - State.lastServersRefresh < CFG.serversRefreshCooldown) {
            const remaining = Math.ceil((CFG.serversRefreshCooldown - (now - State.lastServersRefresh)) / 1000);
            toast(`Wait ${remaining}s before refreshing`, 'warn');
            return;
        }
        State.lastServersRefresh = now;
        if (btn) { btn.classList.add('spinning'); }
        await Pages.loadServers();
        if (btn) { btn.classList.remove('spinning'); }
    },

    filterServers(q) {
        const lower = q.toLowerCase();
        const filtered = Pages._allServers.filter(s =>
            s.serverName.toLowerCase().startsWith(lower) ||
            (s.joinCode || '').toLowerCase().startsWith(lower)
        );
        Pages.renderServerList(filtered);
    },

    renderServerList(servers) {
        const list = document.getElementById('server-list');
        if (!list) return;
        if (!servers.length) {
            list.innerHTML = `<div class="empty-state">
                ${UI.icon('shield')}
                <div style="margin-top:8px">No online servers found</div>
                <div style="font-size:0.75rem;margin-top:4px">Servers appear when a Roblox server connects with your API key</div>
            </div>`;
            return;
        }
        list.innerHTML = servers.map(s => `
            <div class="server-card" onclick="App.navigate('server', { serverCode: '${s.serverCode}' })">
                <div class="server-card-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
                </div>
                <div class="server-card-body">
                    <div class="server-name">${s.serverName}</div>
                    <div class="server-meta">
                        <span>${s.joinCode ? `Code: ${s.joinCode}` : 'No join code'}</span>
                        <span class="server-divider">|</span>
                        <span>Up ${UI.formatDuration(s.uptime)}</span>
                    </div>
                </div>
                <div class="server-player-count">
                    <span class="dot"></span>
                    ${s.totalPlayers}
                </div>
            </div>
        `).join('');
    },

    /* ── SERVER DASHBOARD ── */
    async server(serverCode) {
        if (!serverCode) { App.navigate('servers'); return; }
        State.serverCode = serverCode;
        State.dutyStatus = 'Online';
        State.chatMessages = [];
        State.auditLogs = [];

        const app = document.getElementById('app');
        app.innerHTML = ServerView.html(serverCode);

        // Start all polls
        startPoll('players', ServerView.fetchPlayers, CFG.playersPollInterval);
        startPoll('staff',   ServerView.fetchStaff,   CFG.staffPollInterval);
        startPoll('audit',   AuditLog.fetch,           CFG.auditPollInterval);
        startPoll('chat',    Chat.fetch,               CFG.chatPollInterval);
        startPoll('map',     MapView.fetchPositions,   CFG.mapPollInterval);

        // Monitor for server going offline / permissions revoked
        startPoll('serverCheck', ServerView.checkServerStatus, 3000);
    }
};

/* ================================================================
   SERVER VIEW
================================================================ */
const ServerView = {
    html(serverCode) {
        return `
        <div id="page-server">
            <!-- TOP BAR -->
            <div class="server-topbar">
                <div class="server-topbar-left">
                    <button class="action-btn" onclick="App.navigate('servers')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                        Servers
                    </button>
                    <div>
                        <div class="server-topbar-name" id="sv-name">Connecting</div>
                        <div class="server-topbar-code" id="sv-code">${serverCode}</div>
                    </div>
                    <div class="server-topbar-badge">
                        <span class="dot" style="width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 1.5s infinite"></span>
                        Live
                    </div>
                    <div id="shutdown-banner" style="display:none"></div>
                </div>
                <div class="server-topbar-right">
                    <button class="action-btn" onclick="Modals.commands()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                        Commands
                    </button>
                    <button class="action-btn" onclick="Modals.punishedUsers()">
                        ${UI.icon('ban')}
                        Punished
                    </button>
                    <button class="action-btn" onclick="Modals.serverModal()">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
                        Server
                    </button>
                    ${State.user?.role === 'owner' ? `<button class="action-btn red" onclick="Modals.apiKey()">
                        ${UI.icon('key')} API Key
                    </button>` : ''}
                </div>
            </div>

            <!-- 3-COLUMN BODY -->
            <div class="server-body">
                <!-- LEFT: Duty + Staff -->
                <div class="server-col">
                    <!-- Duty Control -->
                    <div class="panel">
                        <div class="panel-header">
                            Duty Control
                            <span id="duty-badge" class="tag" style="background:var(--surface2);color:var(--muted)">Offline</span>
                        </div>
                        <div class="panel-body">
                            <div class="duty-grid">
                                <button class="duty-btn start" id="btn-start" onclick="Duty.action('start')">Start Shift</button>
                                <button class="duty-btn break dimmed" id="btn-break" onclick="Duty.action('break')">Break</button>
                                <button class="duty-btn end dimmed" id="btn-end" onclick="Duty.action('stop')">End Shift</button>
                            </div>
                        </div>
                    </div>

                    <!-- Staff Status -->
                    <div class="panel" style="flex:1">
                        <div class="panel-header">Staff Status</div>
                        <div class="panel-body" id="staff-list" style="display:flex;flex-direction:column;gap:5px">
                            <div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1rem">Loading</div>
                        </div>
                    </div>

                    <!-- Teams Summary -->
                    <div class="panel">
                        <div class="panel-header">Teams</div>
                        <div class="panel-body" id="teams-summary">
                            <div style="color:var(--muted);font-size:0.78rem;text-align:center">Waiting</div>
                        </div>
                    </div>
                </div>

                <!-- CENTER: Members + Map + Audit -->
                <div class="server-col" id="center-col">
                    <!-- Member List -->
                    <div class="panel" style="flex:1;min-height:280px;display:flex;flex-direction:column">
                        <div class="panel-header">
                            Members (<span id="player-count">0</span>)
                        </div>
                        <div style="padding:8px 10px;border-bottom:1px solid var(--border2)">
                            <div class="member-search-wrap" style="margin:0">
                                ${UI.icon('search')}
                                <input class="member-search" id="member-search" placeholder="Search by username or display name" oninput="MemberList.filter(this.value)">
                            </div>
                        </div>
                        <div id="member-list" style="flex:1;overflow-y:auto;padding:6px 8px">
                            <div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1.5rem">Connecting</div>
                        </div>
                    </div>

                    <!-- Map -->
                    <div class="panel" id="map-panel">
                        <div class="panel-header">
                            Top-Down Map
                            <div style="display:flex;gap:5px">
                                <span id="map-status-badge" style="font-size:0.68rem;color:var(--muted)">Inactive</span>
                            </div>
                        </div>
                        <div class="map-container" id="map-container" style="height:240px">
                            <img src="/img/TopdownMap.png" id="map-image" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.display='none'">
                            <div id="map-players-layer" style="position:absolute;inset:0"></div>
                            <div id="map-locations-layer" style="position:absolute;inset:0"></div>
                            <div class="map-overlay-msg" id="map-overlay">
                                At least 10 players needed for map streaming
                            </div>
                        </div>
                        <div class="map-filters" id="map-filters"></div>
                    </div>

                    <!-- Audit Log -->
                    <div class="panel" style="flex:1;min-height:200px;display:flex;flex-direction:column">
                        <div class="panel-header">
                            Audit Logs
                            <button class="icon-btn" style="width:26px;height:26px" onclick="AuditLog.showFilter()" title="Filter">
                                ${UI.icon('filter')}
                            </button>
                        </div>
                        <div id="audit-list" style="flex:1;overflow-y:auto;padding:0 10px">
                            <div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1.5rem">Loading</div>
                        </div>
                    </div>
                </div>

                <!-- RIGHT: Chat -->
                <div class="server-col" style="display:flex;flex-direction:column;padding:0">
                    <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:0.78rem;font-weight:600;color:var(--text2)">
                        Session Chat
                    </div>
                    <div class="chat-messages" id="chat-messages"></div>
                    <div class="chat-input-wrap">
                        <input class="chat-input" id="chat-input" placeholder="Send a message" maxlength="300"
                            onkeydown="if(event.key==='Enter')Chat.send()">
                        <button class="chat-send-btn" onclick="Chat.send()">${UI.icon('send')}</button>
                    </div>
                </div>
            </div>
        </div>`;
    },

    async fetchPlayers() {
        const u = State.user;
        const sc = State.serverCode;
        if (!sc) return;

        const { ok, data } = await api('GET', `/api/servers/${sc}/players?userId=${u.userId}&senderId=${u.userId}`, null, true);
        if (!ok) return;

        State.players = data.players || [];
        State.serverData = data;

        // Update top bar
        const nameEl = document.getElementById('sv-name');
        const codeEl = document.getElementById('sv-code');
        if (nameEl) nameEl.textContent = data.serverName || 'Server';
        if (codeEl) codeEl.textContent = data.joinCode ? `Code: ${data.joinCode} | ${sc}` : sc;

        // Player count
        const countEl = document.getElementById('player-count');
        if (countEl) countEl.textContent = State.players.length;

        // Teams summary
        ServerView.renderTeams(data.teamsSummary || {});

        // Member list
        MemberList.render(State.players);

        // Scheduled shutdown
        if (data.scheduledShutdown) {
            State.scheduledShutdown = data.scheduledShutdown;
            ServerView.showShutdownBanner(data.scheduledShutdown);
        }

        // Map overlay
        MapView.updateOverlay(State.players.length);
    },

    renderTeams(summary) {
        const el = document.getElementById('teams-summary');
        if (!el) return;
        if (!Object.keys(summary).length) {
            el.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center">No data</div>`;
            return;
        }
        el.innerHTML = Object.entries(summary).sort((a,b) => b[1]-a[1]).map(([team, count]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:0.78rem">
                <span style="color:var(--text2)">${team}</span>
                <span style="font-family:var(--font-mono);font-weight:600;color:var(--text)">${count}</span>
            </div>
        `).join('');
    },

    async fetchStaff() {
        const u = State.user;
        const sc = State.serverCode;
        if (!sc) return;

        const { ok, data } = await api('GET', `/api/admin/staff?userId=${u.userId}&username=${encodeURIComponent(u.username)}&senderId=${u.userId}`, null, true);
        if (!ok) return;
        State.staff = data.staff || [];
        ServerView.renderStaff(State.staff);

        // Check if our admin got revoked
        const me = State.staff.find(s => s.userId === u.userId);
        if (me?.permissionsRevoked && !State._revokedHandled) {
            State._revokedHandled = true;
            toast('Your permissions have been revoked', 'error');
            App.navigate('servers');
        }
        // Check server went offline
        if (me?.serverWentOffline && me.serverCode === null && State.serverCode) {
            toast('The server went offline', 'warn');
            App.navigate('servers');
        }
    },

    renderStaff(staff) {
        const el = document.getElementById('staff-list');
        if (!el) return;
        if (!staff.length) {
            el.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1rem">No staff online</div>`;
            return;
        }
        const statusLabel = { on_duty: 'On Duty', break: 'On Break', Online: 'Online', Offline: 'Offline' };
        el.innerHTML = staff.map(m => {
            const since = m.updatedAt ? UI.timeAgo(new Date(m.updatedAt).getTime()) : '';
            return `<div class="staff-item">
                <img class="staff-avatar" src="${UI.avatar(m.userId)}" alt="">
                <div style="flex:1;min-width:0">
                    <div class="staff-name">${m.username}</div>
                    <div class="staff-duration">${since}</div>
                </div>
                <div style="display:flex;align-items:center;gap:5px">
                    <span class="status-dot ${m.status}"></span>
                    <span class="staff-status">${statusLabel[m.status] || m.status}</span>
                </div>
            </div>`;
        }).join('');
    },

    showShutdownBanner(sched) {
        const banner = document.getElementById('shutdown-banner');
        if (!banner) return;
        const d = new Date(sched.timestamp);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        banner.style.display = 'flex';
        banner.className = 'shutdown-banner';
        banner.innerHTML = `
            ${UI.icon('warn')}
            <span>Shutdown scheduled at ${timeStr}</span>
            <button class="action-btn" style="margin-left:8px;padding:3px 8px;font-size:0.7rem" onclick="ServerView.cancelShutdown()">Cancel</button>`;
    },

    async cancelShutdown() {
        const u = State.user;
        const { ok } = await api('DELETE', `/api/servers/${State.serverCode}/schedule-shutdown`, { userId: u.userId, senderId: u.userId });
        if (ok) {
            toast('Scheduled shutdown cancelled', 'success');
            const banner = document.getElementById('shutdown-banner');
            if (banner) banner.style.display = 'none';
            State.scheduledShutdown = null;
        }
    },

    async checkServerStatus() {
        // Check if we got kicked out of a server (permissions revoked or server offline)
        const u = State.user;
        if (!u) return;
        const me = State.staff.find(s => s.userId === u.userId);
        if (!me) return;
        if (me.serverWentOfflineAt && Date.now() - me.serverWentOfflineAt < 5000 && !State._offlineHandled) {
            State._offlineHandled = true;
            toast('Server went offline', 'warn');
            App.navigate('servers');
        }
    }
};

/* ================================================================
   DUTY CONTROL
================================================================ */
const Duty = {
    async action(action) {
        const u = State.user;
        const sc = State.serverCode;

        if (action === 'start') {
            // Verify player is in server
            const inServer = State.players.some(p => p.userId === u.userId);
            if (!inServer) {
                toast('You must be inside the server to start a shift', 'error');
                return;
            }
        }

        if (action === 'break' && State.dutyStatus !== 'on_duty') {
            toast('You must be on duty to take a break', 'error');
            return;
        }

        const { ok, data } = await api('POST', '/api/admin/duty', {
            userId: u.userId, username: u.username, action, serverCode: sc, senderId: u.userId
        });
        if (!ok) return;

        State.dutyStatus = data.status;
        Duty.updateUI(data.status);
        toast({
            on_duty: 'Shift started',
            break:   'On break',
            Online:  'Shift ended'
        }[data.status] || 'Updated', 'success');
    },

    updateUI(status) {
        const badge = document.getElementById('duty-badge');
        const btnStart = document.getElementById('btn-start');
        const btnBreak = document.getElementById('btn-break');
        const btnEnd   = document.getElementById('btn-end');
        if (!badge) return;

        if (status === 'on_duty') {
            badge.textContent = 'On Duty';
            badge.style.cssText = 'background:var(--green-bg);color:var(--green)';
            btnStart?.classList.add('dimmed');
            btnBreak?.classList.remove('dimmed');
            btnEnd?.classList.remove('dimmed');
        } else if (status === 'break') {
            badge.textContent = 'On Break';
            badge.style.cssText = 'background:var(--amber-bg);color:var(--amber)';
            btnStart?.classList.add('dimmed');
            btnBreak?.classList.add('dimmed');
            btnEnd?.classList.remove('dimmed');
        } else {
            badge.textContent = 'Offline';
            badge.style.cssText = 'background:var(--surface2);color:var(--muted)';
            btnStart?.classList.remove('dimmed');
            btnBreak?.classList.add('dimmed');
            btnEnd?.classList.add('dimmed');
        }
    }
};

/* ================================================================
   MEMBER LIST
================================================================ */
const MemberList = {
    _filtered: [],

    render(players) {
        MemberList._filtered = players;
        const q = document.getElementById('member-search')?.value || '';
        if (q) MemberList.filter(q, players);
        else MemberList._doRender(players);
    },

    filter(q, src) {
        const players = src || State.players;
        const lower = q.toLowerCase();
        const filtered = lower
            ? players.filter(p =>
                p.name.toLowerCase().startsWith(lower) ||
                (p.displayName || '').toLowerCase().startsWith(lower))
            : players;
        MemberList._doRender(filtered);
    },

    _doRender(players) {
        const el = document.getElementById('member-list');
        if (!el) return;
        if (!players.length) {
            el.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1.5rem">No players found</div>`;
            return;
        }

        el.innerHTML = players.map(p => {
            const isAdmin = MemberList.isAdmin(p.userId);
            const isOwner = MemberList.isOwner(p.userId);
            const warns   = (State.warnsByPlayer[p.userId] || []).length;
            const tags = [
                isOwner ? `<span class="tag tag-owner">Owner</span>` : '',
                isAdmin ? `<span class="tag tag-admin">Admin</span>` : '',
                p.isWanted ? `<span class="tag tag-wanted">${UI.stars(p.stars || 1, 5)} Wanted</span>` : '',
                warns > 0  ? `<span class="tag tag-warn">${UI.icon('warn')} ${warns}</span>` : ''
            ].filter(Boolean).join('');

            return `<div class="member-item" onclick="MemberList.openPlayer(${p.userId})">
                <img class="member-avatar" src="${UI.avatar(p.userId)}" alt="">
                <div class="member-name-wrap">
                    <div class="member-name">${p.name}${p.displayName && p.displayName !== p.name ? ` <span style="color:var(--muted);font-size:0.7rem">(${p.displayName})</span>` : ''}</div>
                    <div class="member-team">${p.team}</div>
                    ${tags ? `<div class="member-tags">${tags}</div>` : ''}
                </div>
                ${p.isFrozen ? `<span style="font-size:0.65rem;color:var(--accent2)">Frozen</span>` : ''}
            </div>`;
        }).join('');
    },

    isAdmin(userId) {
        return State.staff.some(s => s.userId === userId && (s.role === 'admin' || s.role === 'owner'));
    },
    isOwner(userId) {
        return State.staff.some(s => s.userId === userId && s.role === 'owner');
    },

    getRank(userId) {
        const s = State.staff.find(s => s.userId === userId);
        return s?.role || 'user';
    },

    canActOn(targetUserId) {
        const myRank = State.user?.role;
        const theirRank = MemberList.getRank(targetUserId);
        const order = { owner: 3, admin: 2, mod: 1, user: 0 };
        return (order[myRank] || 0) > (order[theirRank] || 0);
    },

    async openPlayer(userId) {
        if (State.dutyStatus !== 'on_duty') {
            toast('You must be on duty to take actions', 'error');
            return;
        }
        const player = State.players.find(p => p.userId === userId);
        if (!player) return;

        // Load warns for player
        const { data: warnData } = await api('GET', `/api/punishments/warns/${userId}?userId=${State.user.userId}&senderId=${State.user.userId}`, null, true);
        State.warnsByPlayer[userId] = warnData.warns || [];

        State.selectedPlayer = { ...player, warns: warnData.warns || [] };
        Modals.playerModal(State.selectedPlayer);
    }
};

/* ================================================================
   AUDIT LOG
================================================================ */
const AuditLog = {
    _filter: JSON.parse(localStorage.getItem('auditFilter') || 'null'),
    _logRefs: {},

    async fetch() {
        const sc = State.serverCode;
        const u  = State.user;
        if (!sc) return;

        let url = `/api/audit/${sc}?userId=${u.userId}&senderId=${u.userId}`;
        if (AuditLog._filter) url += `&types=${AuditLog._filter.join(',')}`;

        const { ok, data } = await api('GET', url, null, true);
        if (!ok) return;
        State.auditLogs = data.logs || [];
        AuditLog.render(State.auditLogs);
    },

    render(logs) {
        const el = document.getElementById('audit-list');
        if (!el) return;
        if (!logs.length) {
            el.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:1.5rem">No events yet</div>`;
            return;
        }
        el.innerHTML = logs.map(log => AuditLog.renderEntry(log)).join('');
    },

    renderEntry(log) {
        const icon = AuditLog.icon(log.type);
        const title = AuditLog.title(log);
        const cls = log.revoked ? 'audit-revoked' : '';
        return `<div class="audit-item ${cls}" onclick="AuditLog.expand('${log.id}')" data-log-id="${log.id}">
            <div class="audit-icon" style="${icon.style}">${icon.svg}</div>
            <div class="audit-body">
                <div class="audit-title">${title}</div>
                ${log.type === 'robbery' || log.type === 'punishment' || log.type === 'player_down' ? `<div class="audit-sub">Click for more info</div>` : ''}
            </div>
            <div class="audit-time">${UI.timeAgo(log.timestamp)}</div>
        </div>`;
    },

    icon(type) {
        const map = {
            player_added:  { style:'background:rgba(34,197,94,0.1)', svg: UI.icon('person') },
            player_left:   { style:'background:rgba(107,114,128,0.1)', svg: UI.icon('person') },
            punishment:    { style:'background:rgba(239,68,68,0.1)', svg: UI.icon('ban') },
            robbery:       { style:'background:rgba(245,158,11,0.1)', svg: UI.icon('warn') },
            shots_fired:   { style:'background:rgba(168,85,247,0.1)', svg: UI.icon('shield') },
            player_down:   { style:'background:rgba(239,68,68,0.08)', svg: UI.icon('person') },
            team_changed:  { style:'background:rgba(56,189,248,0.1)', svg: UI.icon('users') },
            phone_call:    { style:'background:rgba(79,110,247,0.1)', svg: UI.icon('send') },
            set_wanted:    { style:'background:rgba(239,68,68,0.12)', svg: UI.icon('warn') },
        };
        return map[type] || { style:'background:var(--surface2)', svg: '' };
    },

    title(log) {
        switch (log.type) {
            case 'player_added': return `${log.username} joined the server`;
            case 'player_left':  return `${log.username} left ${log.duration ? `(${UI.formatDuration(log.duration)})` : ''}`;
            case 'punishment':   return `${log.actorUsername} ${log.punishmentType} → ${log.targetUsername}`;
            case 'robbery':      return `Robbery: ${log.robberyName}`;
            case 'shots_fired':  return `${log.shooterName} fired at ${log.targetName || 'unknown'}`;
            case 'player_down':  return `${log.playerName} was downed${log.killerName ? ` by ${log.killerName}` : ''}`;
            case 'team_changed': return `${log.playerName}: ${log.oldTeam} → ${log.newTeam}`;
            case 'phone_call':   return `${log.playerName} called ${log.forTeam}`;
            case 'set_wanted':   return `${log.playerName} is wanted (${log.stars}★)`;
            default: return log.type?.replace(/_/g, ' ') || 'Event';
        }
    },

    expand(logId) {
        const log = State.auditLogs.find(l => l.id === logId);
        if (!log) return;
        Modals.auditDetail(log);
    },

    showFilter() {
        const ALL_TYPES = ['player_added','player_left','punishment','robbery','shots_fired','player_down','team_changed','phone_call','set_wanted'];
        const active = AuditLog._filter || ALL_TYPES;

        const body = `<h3 style="margin-bottom:12px;font-family:var(--font-h);font-size:0.95rem">Filter audit logs</h3>
        ${ALL_TYPES.map(t => `
            <label style="display:flex;align-items:center;gap:8px;padding:5px 0;font-size:0.82rem;cursor:pointer">
                <input type="checkbox" value="${t}" ${active.includes(t) ? 'checked' : ''}>
                ${t.replace(/_/g, ' ')}
            </label>
        `).join('')}
        <div style="display:flex;gap:8px;margin-top:12px">
            <button class="modal-btn green" style="flex:1" onclick="AuditLog.applyFilter()">Apply</button>
            <button class="modal-btn" style="flex:1" onclick="AuditLog.clearFilter()">Show All</button>
        </div>`;

        Modals.show(body);
    },

    applyFilter() {
        const checks = document.querySelectorAll('#modal-root input[type=checkbox]');
        const selected = [...checks].filter(c => c.checked).map(c => c.value);
        AuditLog._filter = selected.length === 8 ? null : selected;
        localStorage.setItem('auditFilter', JSON.stringify(AuditLog._filter));
        Modals.close();
        AuditLog.fetch();
    },

    clearFilter() {
        AuditLog._filter = null;
        localStorage.removeItem('auditFilter');
        Modals.close();
        AuditLog.fetch();
    }
};

/* ================================================================
   CHAT
================================================================ */
const Chat = {
    _lastCount: 0,

    async fetch() {
        const sc = State.serverCode;
        const u  = State.user;
        if (!sc) return;

        const { ok, data } = await api('GET', `/api/servers/${sc}/chat?userId=${u.userId}&senderId=${u.userId}`, null, true);
        if (!ok) return;

        if (data.messages.length !== Chat._lastCount) {
            Chat._lastCount = data.messages.length;
            State.chatMessages = data.messages;
            Chat.render(data.messages);
        }
    },

    render(messages) {
        const el = document.getElementById('chat-messages');
        if (!el) return;
        const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 40;

        el.innerHTML = messages.map(m => {
            const isOwn = m.senderId === State.user?.userId;
            const isSys = m.type === 'system';

            if (isSys) return `<div class="chat-msg system">
                <div class="chat-bubble">${m.text}</div>
            </div>`;

            return `<div class="chat-msg ${isOwn ? 'own' : ''}">
                <img class="chat-avatar" src="${UI.avatar(m.senderId)}" alt="">
                <div>
                    ${!isOwn ? `<div class="chat-sender">${m.senderName}</div>` : ''}
                    <div class="chat-bubble">${m.text}</div>
                    <div class="chat-time">${UI.formatTime(m.timestamp)}</div>
                </div>
            </div>`;
        }).join('');

        if (isAtBottom) el.scrollTop = el.scrollHeight;
    },

    async send() {
        const input = document.getElementById('chat-input');
        const msg   = input?.value.trim();
        if (!msg) return;

        // Spam check
        const now = Date.now();
        const tracker = State.chatSpamTracker;
        tracker.msgs = (tracker.msgs || []).filter(t => now - t < 5000);
        if (tracker.msgs.length >= 4) { toast('Sending too fast', 'warn'); return; }
        tracker.msgs.push(now);

        input.value = '';

        const { ok } = await api('POST', `/api/servers/${State.serverCode}/chat`, {
            message: msg, senderId: State.user.userId, userId: State.user.userId
        });
        if (ok) await Chat.fetch();
    }
};

/* ================================================================
   MAP VIEW
================================================================ */
const MapView = {
    async fetchPositions() {
        const sc = State.serverCode;
        const u  = State.user;
        if (!sc) return;

        const { ok, data } = await api('GET', `/api/servers/${sc}?userId=${u.userId}&senderId=${u.userId}`, null, true);
        if (!ok) return;

        State.positions  = data.players || [];
        State.locations  = data.locations || [];
        MapView.renderPlayers(data.players || []);
        MapView.renderLocations(data.locations || []);
        MapView.updateOverlay(data.totalPlayers || 0);
    },

    worldToMap(x, z) {
        // Read bounds from config.json (hardcoded here, matching config.json)
       const X_min = 558, X_max = -74, Z_min = 442, Z_max = 730;
        const left = ((x - X_min) / (X_max - X_min)) * 100;
        const top  = ((z - Z_min) / (Z_max - Z_min)) * 100;
        return { left: Math.min(100, Math.max(0, left)), top: Math.min(100, Math.max(0, top)) };
    },



    
    updateOverlay(playerCount) {
        const overlay = document.getElementById('map-overlay');
        const badge   = document.getElementById('map-status-badge');
        if (!overlay) return;

        if (playerCount < 0) {
            overlay.style.display = 'flex';
            overlay.textContent = `At least 10 players needed (${playerCount} online)`;
            if (badge) badge.textContent = 'Inactive';
        } else {
            overlay.style.display = 'none';
            if (badge) { badge.textContent = 'Live'; badge.style.color = 'var(--green)'; }
        }
    },

    renderPlayers(players) {
        const layer = document.getElementById('map-players-layer');
        if (!layer) return;

        const filtered = players.filter(p => {
            const team = p.team;
            return State.mapFilters[team] !== false;
        });

        // Group clustered players
        const clusters = MapView.clusterPlayers(filtered);

        layer.innerHTML = clusters.map(group => {
            if (group.length === 1) {
                const p = group[0];
                if (!p.pos) return '';
                const { left, top } = MapView.worldToMap(p.pos.x, p.pos.z);
                const color = p.teamColor || '#ffffff';
                return `<div class="map-player-marker" style="left:${left}%;top:${top}%" onclick="MemberList.openPlayer(${p.userId})">
                    <img src="${UI.avatar(p.userId)}" style="width:22px;height:22px;border-color:${color}" alt="">
                    <div class="map-player-label" style="color:${color}">${p.name}</div>
                </div>`;
            } else {
                // Clustered — show first player smaller
                const p = group[0];
                if (!p.pos) return '';
                const { left, top } = MapView.worldToMap(p.pos.x, p.pos.z);
                return `<div class="map-player-marker" style="left:${left}%;top:${top}%">
                    <div style="display:flex;gap:1px">
                        ${group.slice(0,3).map(pl => `<img src="${UI.avatar(pl.userId)}" style="width:14px;height:14px;border-radius:50%;border:1px solid ${pl.teamColor||'#fff'}" alt="">`).join('')}
                    </div>
                    <div class="map-player-label" style="color:var(--muted)">+${group.length}</div>
                </div>`;
            }
        }).join('');
    },

    clusterPlayers(players) {
        const THRESHOLD = 3; // % distance
        const clusters = [];
        const assigned = new Set();

        players.forEach((p, i) => {
            if (assigned.has(i) || !p.pos) return;
            const group = [p];
            assigned.add(i);
            const { left: l1, top: t1 } = MapView.worldToMap(p.pos.x, p.pos.z);

            players.forEach((q, j) => {
                if (assigned.has(j) || !q.pos || i === j) return;
                const { left: l2, top: t2 } = MapView.worldToMap(q.pos.x, q.pos.z);
                if (Math.abs(l1-l2) < THRESHOLD && Math.abs(t1-t2) < THRESHOLD) {
                    group.push(q);
                    assigned.add(j);
                }
            });
            clusters.push(group);
        });
        return clusters;
    },

    renderLocations(locations) {
        const layer = document.getElementById('map-locations-layer');
        if (!layer) return;

        layer.innerHTML = (locations || []).flatMap(loc => {
            return (loc.positions || []).map(pos => {
                const { left, top } = MapView.worldToMap(pos.x || pos.x, pos.z || pos.y);
                return `<div class="map-location-marker" style="left:${left}%;top:${top}%">
                    <div class="map-location-dot">${loc.name.slice(0,2)}</div>
                    <div class="map-location-label">${loc.text || loc.name}</div>
                </div>`;
            });
        }).join('');
    },

    renderFilters() {
        const el = document.getElementById('map-filters');
        if (!el) return;
        const teams = ['BusCompany','Citizen','FireDepartment','HARS','Police','Prisoner','TruckCompany'];
        el.innerHTML = teams.map(t => `
            <button class="map-filter-btn ${State.mapFilters[t] !== false ? 'active' : ''}"
                onclick="MapView.toggleFilter('${t}')">
                ${State.mapFilters[t] !== false ? '✓ ' : ''}${t}
            </button>
        `).join('');
    },

    toggleFilter(team) {
        State.mapFilters[team] = State.mapFilters[team] === false ? true : false;
        localStorage.setItem('mapFilters', JSON.stringify(State.mapFilters));
        MapView.renderFilters();
        MapView.renderPlayers(State.positions);
    }
};

/* ================================================================
   MODALS
================================================================ */
const Modals = {
    show(html, cls = '') {
        const root = document.getElementById('modal-root');
        root.innerHTML = `
        <div class="modal-backdrop" onclick="if(event.target===this)Modals.close()">
            <div class="modal ${cls}">${html}</div>
        </div>`;
    },

    close() {
        document.getElementById('modal-root').innerHTML = '';
    },

    /* ── PLAYER MODAL ── */
    playerModal(player) {
        if (!MemberList.canActOn(player.userId)) {
            Modals.show(`
                <div class="modal-header">
                    <img class="modal-avatar" src="${UI.avatar(player.userId)}" alt="">
                    <span class="modal-title">${player.name}</span>
                    <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
                </div>
                <p style="color:var(--muted);font-size:0.84rem;text-align:center;padding:1rem">
                    You cannot perform actions on this person
                </p>`);
            return;
        }

        const warns    = player.warns || [];
        const isFrozen = player.isFrozen;

        Modals.show(`
        <div class="modal-header">
            <img class="modal-avatar" src="${UI.avatar(player.userId)}" alt="">
            <div style="flex:1">
                <div class="modal-title">${player.name}</div>
                ${player.displayName && player.displayName !== player.name ? `<div style="font-size:0.75rem;color:var(--muted)">${player.displayName}</div>` : ''}
            </div>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>

        <div class="modal-stat-grid">
            <div class="modal-stat"><div class="modal-stat-label">Team</div><div class="modal-stat-value">${player.team}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Time in server</div><div class="modal-stat-value">${UI.formatDuration(player.timeInGame)}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">In vehicle</div><div class="modal-stat-value">${player.inVehicle ? 'Yes' : 'No'}</div></div>
            <div class="modal-stat"><div class="modal-stat-label">Status</div><div class="modal-stat-value">${isFrozen ? '❄ Frozen' : 'Active'}</div></div>
        </div>

        <!-- Mini map -->
        <div class="mini-map-player" id="player-mini-map">
            <img src="/img/TopdownMap.png" style="width:100%;height:100%;object-fit:cover;opacity:0.6">
            ${player.pos ? `<img class="player-dot" id="mini-dot"
                src="${UI.avatar(player.userId)}"
                style="left:${MapView.worldToMap(player.pos.x, player.pos.z).left}%;top:${MapView.worldToMap(player.pos.x, player.pos.z).top}%;border-color:${player.teamColor||'#fff'}">` : ''}
        </div>

        <div class="modal-actions" style="margin-top:10px">
            <button class="modal-btn" onclick="Actions.bring(${player.userId}, '${player.name}')">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                Bring
            </button>
            <button class="modal-btn" onclick="Actions.to(${player.userId}, '${player.name}')">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                Go to
            </button>
            <button class="modal-btn ${isFrozen ? 'green' : 'amber'}" onclick="Actions.freeze(${player.userId}, '${player.name}')">
                ${isFrozen ? 'Unfreeze' : 'Freeze'}
            </button>
            <button class="modal-btn red" onclick="Actions.kick(${player.userId}, '${player.name}')">Kick</button>
            ${player.hasInventory ? `<button class="modal-btn" onclick="Modals.inventory(${player.userId})">
                Inventory
            </button>` : ''}
            ${warns.length > 0 ? `<button class="modal-btn amber" onclick="Modals.warnsLog(${player.userId}, '${player.name}')">
                ${UI.icon('warn')} Warns (${warns.length})
            </button>` : ''}
            <button class="modal-btn" onclick="Modals.messagePlayer('${player.name}')">Message</button>
            <button class="modal-btn full red" onclick="Modals.banPlayer(${player.userId}, '${player.name}')">
                ${UI.icon('ban')} Ban
            </button>
        </div>`, 'wide');

        // Live update mini dot
        const dotInterval = setInterval(() => {
            const p = State.players.find(p => p.userId === player.userId);
            const dot = document.getElementById('mini-dot');
            if (!p || !dot || !p.pos) { clearInterval(dotInterval); return; }
            const { left, top } = MapView.worldToMap(p.pos.x, p.pos.z);
            dot.style.left = left + '%';
            dot.style.top  = top + '%';
        }, 2000);
    },

    /* ── BAN PLAYER ── */
    banPlayer(userId, username) {
        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">${UI.icon('ban')} Ban ${username}</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div class="form-group">
            <label class="form-label">Reason</label>
            <input class="form-input" id="ban-reason" placeholder="Reason for ban">
        </div>
        <div class="form-group">
            <label class="form-label">Duration (seconds, -1 for permanent)</label>
            <input class="form-input" id="ban-duration" type="number" placeholder="-1" value="-1" oninput="Modals.updateBanCalc(this.value)">
            <div id="ban-calc" style="font-size:0.75rem;color:var(--amber);margin-top:4px">Permanent</div>
        </div>
        <button class="hold-btn red-hold full" style="width:100%;margin-top:8px"
            id="ban-hold-btn"
            onmousedown="HoldBtn.start(this, 500, () => Actions.confirmBan(${userId}, '${username}'))"
            onmouseup="HoldBtn.stop(this)"
            onmouseleave="HoldBtn.stop(this)">
            <div class="hold-fill" id="ban-hold-fill"></div>
            <span>Hold to confirm ban</span>
        </button>`);
    },

    updateBanCalc(val) {
        const v = parseInt(val);
        const el = document.getElementById('ban-calc');
        if (!el) return;
        if (isNaN(v) || v === -1) { el.textContent = 'Permanent'; return; }
        if (v < 60)   el.textContent = v + ' seconds';
        else if (v < 3600)  el.textContent = (v/60).toFixed(1) + ' minutes';
        else if (v < 86400) el.textContent = (v/3600).toFixed(1) + ' hours';
        else el.textContent = (v/86400).toFixed(1) + ' days';
    },

    /* ── WARNS LOG ── */
    async warnsLog(userId, username) {
        const warns = State.warnsByPlayer[userId] || [];
        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">${UI.icon('warn')} Warns — ${username}</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        ${warns.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:1rem">No warns</p>' :
            warns.map((w, i) => `
            <div class="warn-entry">
                <div class="warn-index">#${i+1}</div>
                <div class="warn-body">
                    <div class="warn-reason">${w.reason}</div>
                    <div class="warn-meta">${UI.timeAgo(w.warnedAt)} · by ${w.responsibleUsername}</div>
                    <div class="warn-caseid">Case: ${w.caseId}</div>
                </div>
                <button class="hold-btn red-hold" style="font-size:0.7rem;padding:5px 8px"
                    onmousedown="HoldBtn.start(this, 300, () => Actions.removeWarn(${userId}, '${username}', '${w.caseId}', ${i}))"
                    onmouseup="HoldBtn.stop(this)"
                    onmouseleave="HoldBtn.stop(this)">
                    <div class="hold-fill"></div>
                    <span>Remove</span>
                </button>
            </div>`).join('')}`, 'wide');
    },

    /* ── AUDIT DETAIL ── */
    auditDetail(log) {
        const title = AuditLog.title(log);
        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">${title}</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div style="font-size:0.8rem;color:var(--muted);margin-bottom:12px">${UI.formatDateTime(log.timestamp)}</div>
        ${Modals._auditDetailBody(log)}
        ${log.revocable && !log.revoked ? `
        <button class="hold-btn red-hold" style="width:100%;margin-top:12px"
            onmousedown="HoldBtn.start(this, 500, () => Actions.revokeAudit('${log.id}'))"
            onmouseup="HoldBtn.stop(this)"
            onmouseleave="HoldBtn.stop(this)">
            <div class="hold-fill"></div>
            <span>Hold to revoke</span>
        </button>` : ''}
        ${log.revoked ? `<div style="color:var(--muted);font-size:0.78rem;text-align:center;margin-top:8px">Revoked by ${log.revokedByUsername} · ${UI.timeAgo(log.revokedAt)}</div>` : ''}`);
    },

    _auditDetailBody(log) {
        if (log.type === 'punishment') {
            return `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
                <div>
                    <div style="font-size:0.68rem;color:var(--muted);margin-bottom:4px">Actor</div>
                    <div style="display:flex;align-items:center;gap:6px">
                        <img src="${UI.avatar(log.actorId)}" style="width:24px;height:24px;border-radius:50%">
                        <span style="font-size:0.8rem;font-weight:500">${log.actorUsername}</span>
                    </div>
                </div>
                <div>
                    <div style="font-size:0.68rem;color:var(--muted);margin-bottom:4px">Target</div>
                    <div style="display:flex;align-items:center;gap:6px">
                        <img src="${UI.avatar(log.targetId)}" style="width:24px;height:24px;border-radius:50%">
                        <span style="font-size:0.8rem;font-weight:500">${log.targetUsername}</span>
                    </div>
                </div>
            </div>
            <div style="font-size:0.8rem;color:var(--text2)"><strong>Reason:</strong> ${log.reason || 'No reason provided'}</div>
            ${log.duration ? `<div style="font-size:0.78rem;color:var(--muted);margin-top:4px">Duration: ${UI.formatDuration(log.duration)}</div>` : ''}
            ${log.caseId ? `<div style="font-size:0.73rem;color:var(--muted);margin-top:4px;font-family:var(--font-mono)">Case ID: ${log.caseId}</div>` : ''}`;
        }
        return `<pre style="font-size:0.75rem;color:var(--muted);white-space:pre-wrap">${JSON.stringify(log, null, 2)}</pre>`;
    },

    /* ── SERVER MODAL (shutdown + schedule) ── */
    serverModal() {
        const uptime = State.serverData?.startTime
            ? UI.formatDuration(Math.floor((Date.now() - State.serverData.startTime) / 1000))
            : 'Unknown';

        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">Server Controls</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;font-size:0.82rem">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px">
                <span style="color:var(--muted)">Uptime</span>
                <span style="font-family:var(--font-mono)">${uptime}</span>
            </div>
            <div style="display:flex;justify-content:space-between">
                <span style="color:var(--muted)">Players</span>
                <span>${State.players.length}</span>
            </div>
        </div>
        ${State.scheduledShutdown ? `
            <div class="shutdown-banner" style="margin-bottom:10px">
                Shutdown at ${new Date(State.scheduledShutdown.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                <button class="action-btn" style="margin-left:auto;font-size:0.7rem" onclick="ServerView.cancelShutdown();Modals.close()">Cancel</button>
            </div>` : ''}
        <button class="hold-btn red-hold" style="width:100%;margin-bottom:12px"
            onmousedown="HoldBtn.start(this, 500, Actions.immediateShutdown)"
            onmouseup="HoldBtn.stop(this)"
            onmouseleave="HoldBtn.stop(this)">
            <div class="hold-fill"></div>
            <span>Hold to shut down now</span>
        </button>
        <div style="border-top:1px solid var(--border);padding-top:12px">
            <div class="form-label" style="margin-bottom:8px">Schedule shutdown</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px">
                <div>
                    <div class="form-label">Date</div>
                    <input class="form-input" type="date" id="sched-date">
                </div>
                <div>
                    <div class="form-label">Hour</div>
                    <select class="form-input" id="sched-hour">${Array.from({length:12},(_,i)=>`<option>${String(i+1).padStart(2,'0')}</option>`).join('')}</select>
                </div>
                <div>
                    <div class="form-label">Min</div>
                    <select class="form-input" id="sched-min">${Array.from({length:60},(_,i)=>`<option>${String(i).padStart(2,'0')}</option>`).join('')}</select>
                </div>
            </div>
            <select class="form-input" id="sched-ampm" style="width:100%;margin-bottom:8px">
                <option>AM</option><option>PM</option>
            </select>
            <button class="modal-btn green full" onclick="Actions.scheduleShutdown()">Confirm Schedule</button>
        </div>`);

        // Set today's date as default
        const dateInput = document.getElementById('sched-date');
        if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    },

    /* ── COMMANDS ── */
    commands() {
        const players = State.players.map(p => p.name);

        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">Broadcast Message</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div class="form-group" style="position:relative">
            <div class="form-label">Target</div>
            <input class="form-input" id="cmd-target" placeholder="@everyone / @me / username"
                oninput="Modals.autocomplete(this.value)">
            <div id="autocomplete-list" class="autocomplete-list" style="display:none"></div>
        </div>
        <div class="form-group">
            <div class="form-label">Message</div>
            <textarea class="form-input" id="cmd-message" rows="3" placeholder="Your message"></textarea>
        </div>
        <button class="modal-btn green full" onclick="Actions.sendMessage()">Send</button>`);
    },

    autocomplete(val) {
        const list = document.getElementById('autocomplete-list');
        if (!list) return;
        const lower = val.toLowerCase();
        const suggestions = ['@everyone', '@me', ...State.players.map(p => p.name)]
            .filter(s => s.toLowerCase().startsWith(lower))
            .slice(0, 4);

        if (!suggestions.length || !val) { list.style.display = 'none'; return; }
        list.style.display = 'block';
        list.innerHTML = suggestions.map((s, i) => `
            <div class="autocomplete-item ${i===0?'highlighted':''}"
                onclick="document.getElementById('cmd-target').value='${s}';document.getElementById('autocomplete-list').style.display='none'">
                ${s}
            </div>`).join('');
    },

    /* ── MESSAGE PLAYER ── */
    messagePlayer(username) {
        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">Send message to ${username}</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div class="form-group">
            <textarea class="form-input" id="msg-text" rows="3" placeholder="Your message"></textarea>
        </div>
        <button class="modal-btn green full" onclick="Actions.sendMessageTo('${username}')">Send</button>`);
    },

    /* ── PUNISHED USERS ── */
    async punishedUsers() {
        const u = State.user;
        let activeTab = 'ban';
        const renderTab = async (type) => {
            activeTab = type;
            const { data } = await api('GET', `/api/punishments/list?type=${type}&userId=${u.userId}&senderId=${u.userId}`, null, true);
            const items = data.items || [];
            const container = document.getElementById('punished-list');
            if (!container) return;
            container.innerHTML = `
            <div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">${items.length} ${type === 'ban' ? 'Banned' : type === 'warn' ? 'Warned' : 'Frozen'} users</div>
            ${items.map(item => {
                const onlinePlayer = State.players.find(p => p.userId === item.userId || p.userId === item.targetId);
                return `<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--surface2);border-radius:8px;margin-bottom:6px">
                    <img src="${UI.avatar(item.userId || item.targetId)}" style="width:32px;height:32px;border-radius:50%">
                    <div style="flex:1;min-width:0">
                        <div style="font-size:0.82rem;font-weight:500">${item.username || item.targetUsername || 'Unknown'}</div>
                        <div style="font-size:0.7rem;color:var(--muted)">${item.reason || 'No reason'}</div>
                        ${onlinePlayer ? `<span style="font-size:0.65rem;color:var(--green);background:var(--green-bg);border-radius:4px;padding:1px 5px">Playing</span>` : ''}
                    </div>
                    ${type !== 'kick' ? `
                    <button class="hold-btn red-hold" style="font-size:0.68rem;padding:4px 8px"
                        onmousedown="HoldBtn.start(this, 500, () => Actions.revokePunishment('${type}', ${item.userId || item.targetId}, '${item.caseId || ''}'))"
                        onmouseup="HoldBtn.stop(this)"
                        onmouseleave="HoldBtn.stop(this)">
                        <div class="hold-fill"></div>
                        <span>${type === 'ban' ? 'Unban' : type === 'freeze' ? 'Unfreeze' : 'Unwarn'}</span>
                    </button>` : ''}
                </div>`;
            }).join('')}`;
        };

        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">Punished Users</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div class="tab-bar">
            <button class="tab-btn active" id="tab-ban"   onclick="Modals._switchPunishedTab('ban',this)">Ban</button>
            <button class="tab-btn"        id="tab-warn"  onclick="Modals._switchPunishedTab('warn',this)">Warn</button>
            <button class="tab-btn"        id="tab-freeze"onclick="Modals._switchPunishedTab('freeze',this)">Freeze</button>
        </div>
        <div id="punished-list" style="max-height:360px;overflow-y:auto"></div>`, 'wide');

        await renderTab('ban');
        Modals._punishedRenderTab = renderTab;
    },

    _switchPunishedTab(type, btn) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Modals._punishedRenderTab?.(type);
    },

    /* ── API KEY ── */
    async apiKey() {
        const u = State.user;
        const sc = State.serverCode;
        const { ok, data } = await api('GET', `/api/serverkeys/${sc}?userId=${u.userId}&senderId=${u.userId}`);
        if (!ok) return;

        let revealed = false;

        Modals.show(`
        <div class="modal-header">
            <span class="modal-title" style="color:var(--red)">${UI.icon('key')} Server API Key</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        <div style="background:var(--red-bg);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:10px 12px;font-size:0.8rem;color:var(--red);margin-bottom:12px">
            Do not share this key. If compromised, regenerate it immediately
        </div>
        <div class="api-key-display">
            <span class="api-key-val" id="key-val">${data.maskedKey}</span>
            <button class="key-action-btn" id="eye-btn" onclick="Modals.toggleKeyVisibility('${data.fullKey}', '${data.maskedKey}')">${UI.icon('eye')}</button>
            <button class="key-action-btn" onclick="Modals.copyKey('${data.fullKey}')">${UI.icon('copy')}</button>
        </div>
        ${data.cooldownUntil ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:8px">Regeneration cooldown: ${Math.ceil((data.cooldownUntil - Date.now())/60000)}m remaining</div>` : ''}
        <button class="hold-btn red-hold" style="width:100%;margin-top:12px"
            onmousedown="HoldBtn.start(this, 2000, Actions.regenerateApiKey)"
            onmouseup="HoldBtn.stop(this)"
            onmouseleave="HoldBtn.stop(this)"
            ${data.cooldownUntil && data.cooldownUntil > Date.now() ? 'disabled style="opacity:0.4;pointer-events:none"' : ''}>
            <div class="hold-fill"></div>
            <span>Hold 2s to regenerate</span>
        </button>`);
    },

    toggleKeyVisibility(full, masked) {
        const el  = document.getElementById('key-val');
        const btn = document.getElementById('eye-btn');
        if (!el) return;
        const showing = el.textContent === full;
        el.textContent = showing ? masked : full;
        btn.innerHTML  = showing ? UI.icon('eye') : UI.icon('eyeOff');
    },

    copyKey(key) {
        navigator.clipboard.writeText(key).then(() => toast('Key copied', 'success'));
    },

    /* ── INVENTORY ── */
    async inventory(userId) {
        const u = State.user;
        const { ok, data } = await api('GET', `/api/tracking/inventory/${State.serverCode}/${userId}?userId=${u.userId}&senderId=${u.userId}`);
        if (!ok) return;

        Modals.show(`
        <div class="modal-header">
            <span class="modal-title">Inventory — ${data.playerName}</span>
            <button class="modal-close" onclick="Modals.close()">${UI.icon('close')}</button>
        </div>
        ${data.inventory.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:1rem">Empty inventory</p>' :
            `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px">
            ${data.inventory.map(item => `
                <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center;font-size:0.78rem">
                    <div style="font-weight:500">${typeof item === 'string' ? item : item.name || 'Item'}</div>
                    ${item.quantity ? `<div style="color:var(--muted);font-size:0.7rem">x${item.quantity}</div>` : ''}
                </div>`).join('')}
            </div>`}`);
    }
};

/* ================================================================
   ACTIONS
================================================================ */
const Actions = {
    async command(action, target, targetId, extra = {}) {
        const u = State.user;
        const sc = State.serverCode;
        if (State.dutyStatus !== 'on_duty') { toast('You must be on duty', 'error'); return; }

        const { ok } = await api('POST', `/api/servers/${sc}/commands`, {
            action, target, targetId,
            senderId: u.userId, userId: u.userId,
            ...extra
        });
        if (ok) toast(`${action} executed`, 'success');
        Modals.close();
    },

    bring(userId, name)  { Actions.command('bring', name, userId); },
    to(userId, name)     { Actions.command('to', name, userId); },
    kick(userId, name)   { Actions.command('kick', name, userId); },
    freeze(userId, name) { Actions.command('freeze', name, userId); },

    async confirmBan(userId, username) {
        const reason   = document.getElementById('ban-reason')?.value || 'No reason provided';
        const duration = parseInt(document.getElementById('ban-duration')?.value || '-1');
        const u = State.user;

        const { ok } = await api('POST', '/api/punishments/ban', {
            serverCode: State.serverCode,
            bannedUserName: username, bannedUserId: userId,
            responsibleId: u.userId, responsibleUsername: u.username,
            duration, reason, userId: u.userId, senderId: u.userId
        });
        if (ok) { toast(`${username} banned`, 'success'); Modals.close(); }
    },

    async removeWarn(userId, username, caseId, index) {
        const u = State.user;
        const { ok } = await api('POST', '/api/punishments/unwarn', {
            whoId: userId, who: username, caseId,
            serverCode: State.serverCode, userId: u.userId, senderId: u.userId
        });
        if (ok) {
            toast('Warning removed', 'success');
            // Refresh warns
            const { data } = await api('GET', `/api/punishments/warns/${userId}?userId=${u.userId}&senderId=${u.userId}`, null, true);
            State.warnsByPlayer[userId] = data.warns || [];
            Modals.warnsLog(userId, username);
        }
    },

    async revokeAudit(logId) {
        const u = State.user;
        const { ok } = await api('PATCH', `/api/audit/${State.serverCode}/${logId}`, {
            revokedBy: u.userId, revokedByUsername: u.username,
            userId: u.userId, senderId: u.userId
        });
        if (ok) { toast('Entry revoked', 'success'); Modals.close(); AuditLog.fetch(); }
    },

    immediateShutdown() {
        const u = State.user;
        api('POST', `/api/servers/${State.serverCode}/commands`, {
            action: 'shutdown', senderId: u.userId, userId: u.userId
        }).then(({ ok }) => {
            if (ok) { toast('Shutdown initiated', 'warn'); Modals.close(); }
        });
    },

    async scheduleShutdown() {
        const dateVal = document.getElementById('sched-date')?.value;
        const hour    = parseInt(document.getElementById('sched-hour')?.value || '12');
        const min     = parseInt(document.getElementById('sched-min')?.value  || '0');
        const ampm    = document.getElementById('sched-ampm')?.value;

        if (!dateVal) { toast('Select a date', 'error'); return; }

        const d  = new Date(dateVal);
        let   hr = hour % 12;
        if (ampm === 'PM') hr += 12;
        d.setHours(hr, min, 0, 0);

        const ts = d.getTime();
        if (ts <= Date.now()) { toast('Select a future time', 'error'); return; }

        const u = State.user;
        const { ok, data } = await api('POST', `/api/servers/${State.serverCode}/schedule-shutdown`, {
            targetTimestamp: ts, senderId: u.userId, userId: u.userId
        });
        if (ok) {
            State.scheduledShutdown = { timestamp: data.executeAt };
            toast(`Shutdown scheduled at ${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`, 'success');
            Modals.close();
        }
    },

    async sendMessage() {
        const target  = document.getElementById('cmd-target')?.value.trim();
        const message = document.getElementById('cmd-message')?.value.trim();
        if (!target || !message) { toast('Fill in target and message', 'error'); return; }

        Actions.command('message', target, null, { reason: message });
    },

    async sendMessageTo(username) {
        const msg = document.getElementById('msg-text')?.value.trim();
        if (!msg) { toast('Enter a message', 'error'); return; }
        Actions.command('message', username, null, { reason: msg });
    },

    async revokePunishment(type, userId, caseId) {
        const u = State.user;
        let endpoint, body;

        if (type === 'ban') {
            endpoint = '/api/punishments/unban';
            body = { userId, responsibleUsername: u.username, reason: 'Revoked via dashboard', userId: u.userId, senderId: u.userId };
        } else if (type === 'freeze') {
            endpoint = '/api/punishments/freeze';
            body = { serverCode: State.serverCode, targetId: userId, userId: u.userId, senderId: u.userId };
        } else if (type === 'warn') {
            endpoint = '/api/punishments/unwarn';
            body = { whoId: userId, caseId, userId: u.userId, senderId: u.userId };
        }

        const { ok } = await api('POST', endpoint, body);
        if (ok) { toast('Punishment revoked', 'success'); Modals.punishedUsers(); }
    },

    async regenerateApiKey() {
        const u = State.user;
        const { ok } = await api('POST', `/api/serverkeys/${State.serverCode}/regenerate`, {
            userId: u.userId, senderId: u.userId
        });
        if (ok) {
            toast('API key regenerated — all admins kicked from server view', 'warn');
            Modals.close();
            App.navigate('servers');
        }
    }
};

/* ================================================================
   HOLD BUTTON
================================================================ */
const HoldBtn = {
    _timer: null,
    _interval: null,
    _duration: 500,

    start(btn, duration, callback) {
        HoldBtn._duration = duration;
        HoldBtn._startTime = Date.now();

        const fill = btn.querySelector('.hold-fill');
        if (fill) {
            fill.style.transition = `width ${duration}ms linear`;
            fill.style.width = '100%';
        }

        HoldBtn._timer = setTimeout(() => {
            HoldBtn.stop(btn);
            callback();
        }, duration);
    },

    stop(btn) {
        clearTimeout(HoldBtn._timer);
        const fill = btn?.querySelector('.hold-fill');
        if (fill) {
            fill.style.transition = 'width 0.15s ease';
            fill.style.width = '0%';
        }
    }
};

/* ================================================================
   INIT
================================================================ */
(function init() {
    // Load theme
    const savedTheme = localStorage.getItem('ehTheme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;

    // Auth guard
    if (!requireAuth()) return;

    // Route based on URL
    const path = window.location.pathname;
    if (path.match(/^\/Api\/Dashboard\/([a-z0-9-]{10,})$/)) {
        const serverCode = path.split('/').pop();
        App.navigate('server', { serverCode });
    } else {
        App.navigate('servers');
        // Render map filters
        setTimeout(() => MapView.renderFilters(), 500);
    }

    // Heartbeat presence
    setInterval(() => {
        if (State.user) {
            api('POST', '/api/auth/register', { userId: State.user.userId, username: State.user.username }, true);
        }
    }, 10000);

    // Beacon on close
    window.addEventListener('beforeunload', () => {
        if (State.user) {
            navigator.sendBeacon(`${BASE_URL}/api/auth/disconnect`,
                JSON.stringify({ userId: State.user.userId }));
        }
    });
})();
