# Emergency Hamburg API — v2.1 (Backend Pass)

This is **Part 1 of 3** — the Backend has been fully rewritten to fix the
architectural problems found in v2.0. Frontend and the Roblox module are
next; the copies of them in this package still reflect the *old* backend
contract in a few places (noted below) and will be updated in the next
two passes.

---

## What changed in this pass, and why

### 1. No more static admin arrays
`ALLOWED_ADMINS`, `INGAME_MODS`, `SERVER_OWNERS` are **gone**. Permission
is now 100% dynamic and per-server, driven entirely by two Roblox module
calls:

```lua
Shield.SetServerOwner(yourRobloxUserId)
Shield.UpdateAdmins({ 123456, 789012 })
```

A user's role for a given server is resolved live — there's nothing to
edit in this codebase to grant access. This is also why removing your own
ID from a hardcoded array used to break your own login: that array was
the *only* thing granting access, and this pass removes it entirely.

### 2. Token vs. API key are now cleanly separate concepts
- **`ApiToken`** (`.env`) — one shared secret for every Roblox→API call
  (heartbeat, `SetServerOwner`, `UpdateAdmins`, all game events). Never
  appears in any dashboard response.
- **Server API key** — this **is** the `serverCode` used throughout the
  URLs. It's generated **by the Roblox server itself**, not by the API,
  and the API just registers/validates it via the new
  `POST /api/servers/setkey` endpoint. It is never rendered in plaintext
  anywhere except the owner-only key panel (masked by default).

New key format: 5 segments, `-`-separated, each a random mix of
upper/lower/digit/`!@#$`, checked for global uniqueness on issue.

### 3. Root cause of "Staff Status stuck loading forever"
The old `server.js` mounted `/api/admin/duty` and `/api/admin/staff` by
passing an entire sub-router directly into `app.post()`/`app.get()`
instead of `app.use()`. That never actually matched — both endpoints were
silently 404ing the whole time. They're properly registered now under
`/api/servers/duty` and `/api/servers/:serverCode/staff`.

### 4. Root cause of freeze/unfreeze never working
The dashboard was calling the generic `/api/servers/:code/commands`
endpoint for freeze actions, which always queued `freeze` and had no
concept of toggling. The dedicated toggle-aware logic existed but was
never reached. Both endpoints now share one `toggleFreezeState()`
function in `state.js` — they can't diverge again. This also fixes
"Punished Users → Freeze" always being empty (it was reading a store
that nothing was ever writing to).

### 5. Root cause of wrong map positions
The frontend had `X_min/X_max/Z_min/Z_max` hardcoded, completely
disconnected from `config.json`. `config.json` is now the actual source
of truth — the backend loads it once (`Backend/config.js`) and serves it
at `GET /api/config`. The frontend and the Roblox module (next passes)
both fetch this instead of hardcoding values.

### 6. Root cause of the garbled code shown to everyone
The dashboard topbar was rendering the raw `serverCode` — which is now
your API key — to every viewer, not just the owner. Every server-scoped
response now includes a `maskedServerCode` field for general display;
the full key is only ever returned from the owner-gated
`GET /api/serverkeys/:serverCode` endpoint.

### 7. Empty-server dashboard eviction (5s grace)
When a server's player count hits 0, a grace timer starts. If nobody
rejoins within `config.json`'s `emptyServerGraceSeconds` (default 5),
every admin currently viewing that server's dashboard is evicted back to
the server list — **without** tearing down the live server or sending a
real shutdown command to Roblox, since the server process is still
running and heartbeating normally, just empty. If someone rejoins in
time, the timer is cancelled.

### 8. Position streaming — WebSocket + strict gating
- Position packets are now pushed over WebSocket (`/ws`) instead of only
  being polled, and the interval dropped to `1.3s` (config-driven).
- The backend now computes `dashboardWatching` (nobody was tracking this
  before, so Lua's own "don't send if not watched" check was comparing
  against `nil` and behaving unpredictably) and enforces it **and** the
  minimum player count server-side too, so a stray packet is dropped
  rather than displayed even if Lua's own gating logic is behind.

### 9. Discord webhook system removed
You said you're building your own bot — every `sendDiscordWebhook` call
and `DiscordWebhookUrl` reference has been removed from the punishment
and tracking routes, and from `.env.example`.

### 10. Everything else addressed this pass
- `Start Shift` while on break now resumes directly to on-duty instead
  of being rejected (frontend will label this "Continue Shift").
- Duty actions now have a server-side cooldown (`dutyActionCooldownSeconds`)
  so the buttons can't be spammed.
- Ban/warn/freeze entries are now tagged with `serverCode`, so
  "Punished Users" is properly scoped per server, with a new default
  `all` tab merging all three types.
- `Uptime: Unknown` — the players/detail endpoints now always include
  `startTime` and `teamsSummary`.
- Owner tag vs. Admin tag — `getServerRole()` returns exactly one role,
  never both, so the double-tag bug can't happen at the data layer.
- Location markers resolve their image at **read time** (checking `/img`
  for `<locationName>.png`), so dropping in a new image just works
  without re-sending the location.
- `message`/`health`/`lock`/`unlock` commands are now first-class,
  audit-logged, and carry full requester identity (username + userId)
  through to Roblox.
- A friendly `404.html` replaces Express's bare "Cannot GET /" for any
  route outside `/Api`.

---

## Project Structure

```
EmergencyHamburg/
├── Backend/
│   ├── server.js              # Express + WebSocket entry point
│   ├── state.js                # All in-memory state + the new permission model
│   ├── config.js               # Loads config.json once, exposes getConfig()
│   ├── ws.js                   # WebSocket server (position streaming)
│   ├── package.json
│   ├── .env.example
│   ├── middleware/
│   │   └── auth.js             # verifyServerAdmin / verifyServerOwner / verifyRobloxToken
│   └── routes/
│       ├── auth.js             # OAuth + session (no global role)
│       ├── servers.js          # Heartbeat, commands, duty, staff, stats, chat, positions
│       ├── punishments.js      # Ban, kick, warn, freeze (server-scoped)
│       ├── tracking.js         # Player + game events
│       ├── audit.js            # Audit log read/write/revoke
│       ├── serverkeys.js       # Owner-only API key view/rotate
│       └── config.js           # GET /api/config
│
├── Frontend/
│   ├── 404.html                 # NEW — friendly not-found page
│   └── Api/                     # Unchanged this pass — next pass rewrites this
│
├── RobloxModule/                # Unchanged this pass — next pass rewrites this
│                                 # (still uses the OLD key-exchange flow for now)
│
├── img/
└── config.json                  # Now the actual source of truth (see above)
```

---

## Quick Start

```bash
cd Backend
npm install
cp .env.example .env
# fill in ApiToken / ClientId / ClientSecret / RedirectURI
npm start
```

No admin IDs to edit anywhere. Access is granted from Roblox:

```lua
local Shield = require(game.ServerScriptService.ShieldModule)
Shield.SetServerOwner(YOUR_ROBLOX_USER_ID)
Shield.UpdateAdmins({ 123456789, 987654321 })
```

---

## New / changed endpoints this pass

| Method | Endpoint | Notes |
|---|---|---|
| POST | `/api/servers/setkey` | Roblox registers/rotates its own key. `{ oldKey, newKey }`, `oldKey === newKey` on first boot. |
| POST | `/api/servers/:code/setowner` | `Shield.SetServerOwner` lands here |
| GET | `/api/servers/:code/staff` | Server-scoped staff list (replaces the broken `/api/admin/staff`) |
| POST | `/api/servers/duty` | Replaces the broken `/api/admin/duty` |
| GET | `/api/servers/:code/stats?range=week\|3days\|24h` | Hourly player-count series + busiest day/hour insights |
| GET | `/api/servers/:code/staff-activity?range=...` | Full shift-history table, sorted by most active |
| GET | `/api/config` | The real `config.json`, for frontend + Roblox to consume |
| GET | `/api/punishments/list?type=all\|ban\|warn\|freeze&serverCode=X` | Now server-scoped, `all` is the new default |
| WS | `/ws` — `{"type":"subscribe","serverCode":"..."}` | Live position pushes |

Every server-scoped GET/POST now expects `senderId` (or `userId`) as a
query or body param — this hasn't changed from before, just enforced
correctly now.

---

## Known limitation (by design, not a bug)

The empty-server grace timer is driven by heartbeat data (arriving every
`heartbeatInterval` seconds), not a dedicated "last player left" event
from Lua. With the default 2s heartbeat interval this is a close
approximation of your described behavior but isn't perfectly event-driven
down to the millisecond. A truly instant version would need Lua to push a
one-off "server is now empty" ping the moment `PlayerRemoving` fires —
happy to add that in the Roblox-module pass if you want it tighter.

---

## Next steps

**Part 2 — Frontend:** side menu (Main / Staff Status / Punished Users /
Stats / Staff Activity / API Key as full standalone panels), collapsible
panels, toggleable session chat with unread badge, hold-button restyle,
light mode fix, member list tags + search, Punishment/Commands submenus
(Health + Message), map pan/zoom + WebSocket client + tween
interpolation, audit log map-preview on click, Lock/Unlock UI, docs
content pruning + side menu fix, and removing the raw `serverCode` from
any visible UI text in favor of `maskedServerCode`.

**Part 3 — Roblox module:** `Init`/`Deinit`, self-generated key +
`SetApiKey(old, new)` handshake with `/api/servers/setkey`, fetch
`/api/config` instead of hardcoding values, health/lock/unlock command
handling, and send `health`/`maxHealth` in the heartbeat payload.

Reply whenever you're ready and I'll move on to Part 2.
