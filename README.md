# Emergency Hamburg API — v2.0

A complete real-time moderation and management platform for Emergency Hamburg Roblox servers.

---

## Project Structure

```
EmergencyHamburg/
├── Backend/
│   ├── server.js              # Express entry point
│   ├── state.js               # Shared in-memory state
│   ├── package.json
│   ├── .env.example           # Copy to .env and fill in values
│   ├── middleware/
│   │   └── auth.js            # Token + session verification
│   └── routes/
│       ├── auth.js            # OAuth + session management
│       ├── servers.js         # Heartbeat, commands, duty, chat
│       ├── punishments.js     # Ban, kick, warn, freeze
│       ├── tracking.js        # Player events, game logs
│       ├── audit.js           # Audit log endpoints
│       └── serverkeys.js      # Server API key management
│
├── Frontend/
│   └── Api/
│       ├── index.html         # Landing page  (/Api)
│       ├── Document/
│       │   └── index.html     # Documentation (/Api/Document)
│       └── Dashboard/
│           ├── index.html     # Dashboard SPA (/Api/Dashboard)
│           ├── app.js         # All dashboard JavaScript
│           └── style.css      # Design system
│
├── RobloxModule/
│   └── ShieldModule.lua       # Roblox server module
│
├── img/
│   └── TopdownMap.png         # Place your map image here
│
└── config.json                # Map bounds and settings
```

---

## Quick Start

### 1. Set up the backend

```bash
cd Backend
npm install
cp .env.example .env
# Edit .env with your values (see below)
npm start
```

### 2. Environment variables (`.env`)

```env
PORT=3000
ApiToken=your-secret-api-token-here
ClientId=your-roblox-oauth-client-id
ClientSecret=your-roblox-oauth-client-secret
RedirectURI=https://yourdomain.com/oauth/callback
SessionSecret=a-random-64-char-secret
DiscordWebhookUrl=https://discord.com/api/webhooks/...
```

- **ApiToken**: A secret string you choose. Put the same value in `ShieldModule.lua` → `CONFIG.API_TOKEN`.
- **ClientId / ClientSecret**: Create an OAuth app at https://create.roblox.com/dashboard/credentials.
- **RedirectURI**: Must exactly match the URI registered in your Roblox OAuth app. Set it to `https://yourdomain.com/oauth/callback`.

### 3. Admin user IDs

Open `Backend/state.js` and edit:

```js
const ALLOWED_ADMINS = [YOUR_USER_ID, ...];   // Can use dashboard
const SERVER_OWNERS  = [YOUR_USER_ID];         // Full access + API key management
```

### 4. Map image

Place your top-down map image at `img/TopdownMap.png`.

Update map boundaries in `config.json` to match your game world:

```json
{
  "mapBounds": {
    "X_min": -800,
    "X_max": 800,
    "Z_min": -800,
    "Z_max": 800
  }
}
```

### 5. Roblox Module

1. In Roblox Studio, create a `ModuleScript` in **ServerScriptService** named `ShieldModule`.
2. Paste the contents of `RobloxModule/ShieldModule.lua`.
3. Update `CONFIG.BASE_URL` to your deployed API URL.
4. Update `CONFIG.API_TOKEN` to match the `ApiToken` in your `.env`.

**Usage in a server Script:**

```lua
local Shield = require(game.ServerScriptService.ShieldModule)

-- Log a shots fired event
Shield.ShotsFired("PlayerA", 123, "PlayerB", 456, "Pistol", 120, -80)

-- Warn a player
Shield.Warn("BadPlayer", 789, "AdminName", 111, "RDM", -1)

-- Set server name + join code
Shield.ServerSetName("Server Alpha")
Shield.ServerSetJoinCode("ALPHA1")
```

---

## Routes

| URL | Description |
|-----|-------------|
| `/Api` | Landing page |
| `/Api/Document` | API documentation |
| `/Api/Dashboard` | Server list (requires login) |
| `/Api/Dashboard/:serverCode` | Server management view |

---

## API Endpoints Summary

### Roblox Server → API (Bearer token)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/servers/:code/heartbeat` | Send player list, receive commands |
| POST | `/api/servers/:code/positions` | Stream player positions for map |
| POST | `/api/servers/:code/addlocation` | Add location marker to map |
| POST | `/api/servers/:code/meta` | Update server name / join code |
| POST | `/api/servers/:code/admins` | Update admin list |
| DELETE | `/api/servers/:code` | Signal server shutdown |
| POST | `/api/tracking/join` | Player joined |
| POST | `/api/tracking/leave` | Player left |
| POST | `/api/tracking/shots` | Shots fired event |
| POST | `/api/tracking/robbery` | Robbery started |
| POST | `/api/tracking/teamchange` | Team changed |
| POST | `/api/tracking/phonecall` | Phone call event |
| POST | `/api/tracking/playerdown` | Player downed |
| POST | `/api/tracking/inventory` | Update player inventory |
| POST | `/api/punishments/ban` | Ban a player |
| POST | `/api/punishments/unban` | Unban a player |
| POST | `/api/punishments/kick` | Kick a player |
| POST | `/api/punishments/warn` | Warn a player |
| POST | `/api/punishments/unwarn` | Remove a warning |
| POST | `/api/punishments/freeze` | Toggle freeze |
| POST | `/api/punishments/log` | Log a punishment (no command) |

### Dashboard → API (session-based)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/servers/list` | List online servers I can moderate |
| GET | `/api/servers/:code` | Server details |
| GET | `/api/servers/:code/players` | Player list |
| POST | `/api/servers/:code/commands` | Issue command (kick, ban, etc.) |
| POST | `/api/servers/:code/schedule-shutdown` | Schedule shutdown |
| DELETE | `/api/servers/:code/schedule-shutdown` | Cancel shutdown |
| GET/POST | `/api/servers/:code/chat` | Session admin chat |
| POST | `/api/admin/duty` | Start/break/stop shift |
| GET | `/api/admin/staff` | Get staff list |
| GET | `/api/punishments/warns/:userId` | Get all warns |
| GET | `/api/punishments/list?type=ban` | Get punished users |
| GET | `/api/audit/:code` | Get audit logs |
| PATCH | `/api/audit/:code/:logId` | Revoke audit entry |
| GET/POST | `/api/serverkeys/:code` | API key management |
| POST | `/api/serverkeys/:code/regenerate` | Regenerate API key |

---

## Map Normalization

To convert in-game coordinates to map image percentages:

```js
function worldToMap(x, z, bounds) {
  const left = ((x - bounds.X_min) / (bounds.X_max - bounds.X_min)) * 100;
  const top  = ((z - bounds.Z_min) / (bounds.Z_max - bounds.Z_min)) * 100;
  return { left, top }; // use as CSS left% and top%
}
```

---

## Discord Integration

Set `DiscordWebhookUrl` in `.env`. The following events auto-forward as embeds:
- Player join / leave
- Ban / unban
- Kick  
- Warn
- Team changed

---

## Session Persistence

Sessions are stored in `sessionStorage` — they persist across page refreshes within the same tab but are cleared when the tab/browser is closed. This is intentional for security.

---

## Security Notes

- All Roblox server requests require the `Authorization: Bearer <ApiToken>` header.
- Dashboard actions require an active OAuth session (Roblox login).
- Admin access is controlled by the `ALLOWED_ADMINS` / `SERVER_OWNERS` arrays in `state.js`.
- The server API key (for per-server auth) can be regenerated by the owner with a 15-minute cooldown.
- Rate limiting: 45 requests per 10 seconds per IP on moderation endpoints.

---

## Extending

**Add a new game event:**
1. Add a route in `Backend/routes/tracking.js`
2. Call `pushAuditLog(serverCode, { type: 'my_event', ... })`
3. Add the icon + title handler in `Frontend/Api/Dashboard/app.js` → `AuditLog.icon()` and `AuditLog.title()`
4. Add the Shield function in `RobloxModule/ShieldModule.lua`

**Add a new punishment type:**
1. Add the endpoint in `Backend/routes/punishments.js`
2. Add the action in `Frontend/Api/Dashboard/app.js` → `Actions`
3. Add a button in `Modals.playerModal()`
