--[[
    ShieldModule.lua — Emergency Hamburg API
    Place in ServerScriptService as a ModuleScript named "ShieldModule"
    
    All functions are non-blocking (task.spawn wrapped).
    Batching: events are queued and flushed every CONFIG.BatchInterval seconds,
    except heartbeat which runs on its own loop.
--]]

local HttpService       = game:GetService("HttpService")
local Players           = game:GetService("Players")
local RunService        = game:GetService("RunService")
local DataStoreService  = game:GetService("DataStoreService")

-- ============================================================
-- CONFIG
-- ============================================================
local CONFIG = {
    BASE_URL            = "https://api-production-59e1.up.railway.app",
    API_TOKEN           = "!@!@!SSD!VDK@DSo1",  -- Replace with your real token

    HeartbeatInterval   = 2,    -- seconds between heartbeats
    BatchInterval       = 3,    -- seconds between event batch flushes
    PositionInterval    = 5,    -- seconds between position packets (map)
    PositionMinStuds    = 7,    -- minimum movement to include in position packet
    MapMinPlayers       = 10,   -- min players before sending positions

    MaxRetries          = 2,    -- retry failed HTTP requests this many times
    RetryDelay          = 1,    -- seconds between retries
}

-- ============================================================
-- STATE
-- ============================================================
local serverCode        = ""
local isShuttingDown    = false
local frozenPlayers     = {}
local playerJoinTimes   = {}
local playerLastPos     = {}   -- userId -> Vector3
local eventQueue        = {}   -- pending batched events
local banDS             = DataStoreService:GetDataStore("ServerBans_v2")
local isPublicServer    = (game.PrivateServerId == "")
local dashboardWatching = false  -- set via heartbeat response
local serverName        = "Unknown Server"
local serverJoinCode    = ""
local serverOwnerId     = nil
local inventoryCache    = {}   -- userId -> inventory

-- ============================================================
-- UTILITIES
-- ============================================================
local function log(msg)
    print("[Shield] " .. msg)
end

local function httpPost(endpoint, payload, retries)
    retries = retries or CONFIG.MaxRetries
    local url = CONFIG.BASE_URL .. endpoint
    local body = HttpService:JSONEncode(payload)
    local headers = {
        ["Content-Type"] = "application/json",
        ["Authorization"] = "Bearer " .. CONFIG.API_TOKEN
    }

    local success, result = pcall(function()
        return HttpService:PostAsync(url, body, Enum.HttpContentType.ApplicationJson, false, headers)
    end)

    if success then
        local ok, data = pcall(function() return HttpService:JSONDecode(result) end)
        return ok and data or {}
    elseif retries > 0 then
        task.wait(CONFIG.RetryDelay)
        return httpPost(endpoint, payload, retries - 1)
    end
    return {}
end

local function httpDelete(endpoint)
    pcall(function()
        HttpService:RequestAsync({
            Url     = CONFIG.BASE_URL .. endpoint,
            Method  = "DELETE",
            Headers = { ["Authorization"] = "Bearer " .. CONFIG.API_TOKEN }
        })
    end)
end

local function generateServerCode()
    -- Attempt to get a persistent code from DataStore
    local ds = DataStoreService:GetDataStore("ShieldServerCode_v1")
    local jobId = game.JobId
    local ok, stored = pcall(function() return ds:GetAsync("code_" .. game.PlaceId) end)
    if ok and stored and type(stored) == "string" and #stored > 10 then
        return stored
    end
    -- Generate new one
    local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    local rng = Random.new()
    local function seg()
        local s = ""
        for _ = 1, 4 do
            s = s .. string.sub(chars, rng:NextInteger(1, #chars), rng:NextInteger(1, #chars))
        end
        return s
    end
    local code = seg().."-"..seg().."-"..seg().."-"..seg()
    pcall(function() ds:SetAsync("code_" .. game.PlaceId, code) end)
    return code
end

local function getBanTimeRemaining(unbanTime)
    if unbanTime == -1 then return "Permanent" end
    local remaining = unbanTime - os.time()
    if remaining <= 0 then return "Expired" end
    local d = math.floor(remaining / 86400)
    local h = math.floor((remaining % 86400) / 3600)
    local m = math.floor((remaining % 3600) / 60)
    local s = remaining % 60
    local str = ""
    if d > 0 then str = str .. d .. "d " end
    if h > 0 then str = str .. h .. "h " end
    if m > 0 then str = str .. m .. "m " end
    str = str .. s .. "s"
    return str
end

local function isInVehicle(player)
    local char = player.Character
    if not char then return false end
    local hum = char:FindFirstChildOfClass("Humanoid")
    return hum and hum.Sit == true
end

local function getPlayerPos(player)
    local char = player.Character
    if char then
        local hrp = char:FindFirstChild("HumanoidRootPart")
        if hrp then
            return hrp.Position.X, hrp.Position.Z
        end
    end
    return 0, 0
end

-- ============================================================
-- SERVER CODE INIT
-- ============================================================
if not isPublicServer then
    serverCode = generateServerCode()
    log("==============================================")
    log("Shield System | Server Code: " .. serverCode)
    log("==============================================")

    -- Try reading server name from TeleportData
    Players.PlayerAdded:Connect(function(player)
        local ok, joinData = pcall(function() return player:GetJoinData() end)
        if ok and joinData and joinData.TeleportData then
            local td = joinData.TeleportData
            if td.ServerName and serverName == "Unknown Server" then
                serverName = td.ServerName
            end
            if td.CustomCode and serverJoinCode == "" then
                serverJoinCode = td.CustomCode
            end
        end
    end)
else
    log("Shield System | Public Server — tracking only")
end

-- ============================================================
-- EVENT QUEUE (BATCH FLUSH)
-- ============================================================
local function queueEvent(eventType, endpoint, payload)
    table.insert(eventQueue, { type = eventType, endpoint = endpoint, payload = payload })
end

local function flushEvents()
    if #eventQueue == 0 then return end
    local toSend = eventQueue
    eventQueue = {}
    for _, ev in ipairs(toSend) do
        task.spawn(function()
            httpPost(ev.endpoint, ev.payload)
        end)
    end
end

task.spawn(function()
    while not isShuttingDown do
        task.wait(CONFIG.BatchInterval)
        flushEvents()
    end
end)

-- ============================================================
-- HEARTBEAT LOOP
-- ============================================================
local function buildPlayersList()
    local list = {}
    for _, player in ipairs(Players:GetPlayers()) do
        local posX, posZ = getPlayerPos(player)
        local joinTime = playerJoinTimes[player.UserId] or os.time()
        local teamName = player.Team and player.Team.Name or "Civilian"
        table.insert(list, {
            name       = player.Name,
            displayName= player.DisplayName,
            userId     = player.UserId,
            team       = teamName,
            timeInGame = os.time() - joinTime,
            inVehicle  = isInVehicle(player),
            isFrozen   = frozenPlayers[player.Name] ~= nil,
            pos        = { x = math.floor(posX), z = math.floor(posZ) },
            hasInventory = inventoryCache[player.UserId] ~= nil
        })
    end
    return list
end

local function processCommands(commands)
    for _, cmd in ipairs(commands) do
        if cmd.action == "shutdown" then
            isShuttingDown = true
            for _, p in ipairs(Players:GetPlayers()) do
                p:Kick("\n[Remote Shutdown]\nInitiated by: " .. tostring(cmd.senderName or "Admin"))
            end
            break
        end

        -- Teleport / movement commands
        if cmd.action == "api_key_changed" then
            -- Server owner regenerated API key — update config
            CONFIG.API_TOKEN = cmd.newKey or CONFIG.API_TOKEN
            log("API key updated remotely")
        end

        local target = Players:FindFirstChild(cmd.target or "")
        if target and not target:IsA("Player") then target = nil end

        if cmd.action == "freeze" then
            frozenPlayers[cmd.target] = true
            if target and target.Character then
                local hrp = target.Character:FindFirstChild("HumanoidRootPart")
                if hrp then hrp.Anchored = true end
            end

        elseif cmd.action == "unfreeze" then
            frozenPlayers[cmd.target] = nil
            if target and target.Character then
                local hrp = target.Character:FindFirstChild("HumanoidRootPart")
                if hrp then hrp.Anchored = false end
            end

        elseif cmd.action == "kick" then
            if target then
                target:Kick("\n[Remote Kick]\nReason: " .. (cmd.reason or "Violations") .. "\nBy: " .. (cmd.senderName or "Admin"))
            end

        elseif cmd.action == "ban" then
            local dur = tonumber(cmd.duration) or -1
            local tId = tonumber(cmd.targetId)
            if not tId and target then tId = target.UserId end
            if tId then
                task.spawn(function()
                    pcall(function()
                        banDS:UpdateAsync(game.JobId, function(old)
                            old = old or {}
                            old[tostring(tId)] = {
                                reason    = cmd.reason or "Violations",
                                duration  = dur,
                                unbanTime = dur == -1 and -1 or (os.time() + dur)
                            }
                            return old
                        end)
                    end)
                end)
                if target then
                    local tm = dur == -1 and "Permanent" or getBanTimeRemaining(os.time() + dur)
                    target:Kick("\n[Server Ban]\nReason: " .. (cmd.reason or "Violations") .. "\nDuration: " .. tm)
                end
            end

        elseif cmd.action == "bring" then
            local adminId = tonumber(cmd.senderId)
            if adminId and target and target.Character then
                local adminPlayer = Players:GetPlayerByUserId(adminId)
                if adminPlayer and adminPlayer.Character and adminPlayer.Character:FindFirstChild("HumanoidRootPart") then
                    local hum = target.Character:FindFirstChildOfClass("Humanoid")
                    if hum then hum.Sit = false end
                    task.wait(0.1)
                    if target.Character and adminPlayer.Character:FindFirstChild("HumanoidRootPart") then
                        target.Character:PivotTo(adminPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0, 0, -4))
                    end
                end
            end

        elseif cmd.action == "to" then
            local adminId = tonumber(cmd.senderId)
            if adminId and target and target.Character and target.Character:FindFirstChild("HumanoidRootPart") then
                local adminPlayer = Players:GetPlayerByUserId(adminId)
                if adminPlayer and adminPlayer.Character then
                    local hum = adminPlayer.Character:FindFirstChildOfClass("Humanoid")
                    if hum then hum.Sit = false end
                    task.wait(0.1)
                    if adminPlayer.Character and target.Character:FindFirstChild("HumanoidRootPart") then
                        adminPlayer.Character:PivotTo(target.Character.HumanoidRootPart.CFrame * CFrame.new(0, 0, 4))
                    end
                end
            end

        elseif cmd.action == "warn" then
            if target then
                -- Notify player in-game (you can replace with a GUI notification)
                local msg = "[Warning] " .. (cmd.reason or "Misconduct") .. " | Case: " .. (cmd.caseId or "N/A")
                -- Example: send a hint or chat message
                log("WARN issued to " .. (cmd.target or "?") .. ": " .. msg)
            end

        elseif cmd.action == "message" then
            local msgText = cmd.reason or ""
            if cmd.target == "@everyone" then
                for _, p in ipairs(Players:GetPlayers()) do
                    log("[Broadcast → " .. p.Name .. "]: " .. msgText)
                    -- Implement your GUI broadcast here
                end
            elseif cmd.target == "@me" then
                local sender = Players:GetPlayerByUserId(tonumber(cmd.senderId) or 0)
                if sender then
                    log("[Message → " .. sender.Name .. "]: " .. msgText)
                end
            elseif target then
                log("[Message → " .. target.Name .. "]: " .. msgText)
            end
        end
    end
end

-- Heartbeat loop
if not isPublicServer then
    task.spawn(function()
        while not isShuttingDown do
            local players = buildPlayersList()
            local payload = {
                playersList = players,
                serverName  = serverName,
                joinCode    = serverJoinCode
            }

            local response = httpPost("/api/servers/" .. serverCode .. "/heartbeat", payload)

            if response and response.commands then
                processCommands(response.commands)
            end

            -- Check if dashboard is watching (for position streaming logic)
            if response and response.dashboardWatching ~= nil then
                dashboardWatching = response.dashboardWatching
            end

            task.wait(CONFIG.HeartbeatInterval)
        end
    end)
end

-- Keep frozen players anchored
RunService.Heartbeat:Connect(function()
    if isPublicServer then return end
    for userName in pairs(frozenPlayers) do
        local p = Players:FindFirstChild(userName)
        if p and p:IsA("Player") and p.Character then
            local hrp = p.Character:FindFirstChild("HumanoidRootPart")
            if hrp and not hrp.Anchored then
                hrp.Anchored = true
            end
        end
    end
end)

-- ============================================================
-- POSITION STREAMING (MAP)
-- ============================================================
local function shouldStreamPositions()
    if isPublicServer then return false end
    if #Players:GetPlayers() < CONFIG.MapMinPlayers then return false end
    return dashboardWatching
end

task.spawn(function()
    while not isShuttingDown do
        task.wait(CONFIG.PositionInterval)
        if not shouldStreamPositions() then continue end

        local positions = {}
        for _, player in ipairs(Players:GetPlayers()) do
            local posX, posZ = getPlayerPos(player)
            local lastPos = playerLastPos[player.UserId]

            local moved = true
            if lastPos then
                local dx = posX - lastPos.x
                local dz = posZ - lastPos.z
                moved = math.sqrt(dx*dx + dz*dz) >= CONFIG.PositionMinStuds
            end

            if moved then
                playerLastPos[player.UserId] = { x = posX, z = posZ }
                local teamColor = "#ffffff"
                if player.Team then
                    local c = player.Team.TeamColor.Color
                    teamColor = string.format("#%02X%02X%02X",
                        math.floor(c.R * 255), math.floor(c.G * 255), math.floor(c.B * 255))
                end
                table.insert(positions, {
                    name      = player.Name,
                    userId    = player.UserId,
                    team      = player.Team and player.Team.Name or "Civilian",
                    teamColor = teamColor,
                    x         = math.floor(posX),
                    z         = math.floor(posZ)
                })
            end
        end

        if #positions > 0 then
            task.spawn(function()
                httpPost("/api/servers/" .. serverCode .. "/positions", { positions = positions })
            end)
        end
    end
end)

-- ============================================================
-- PLAYER EVENTS
-- ============================================================
Players.PlayerAdded:Connect(function(player)
    log("Player joined: " .. player.Name .. " (" .. player.UserId .. ")")

    -- Check ban
    local banOk, bans = pcall(function() return banDS:GetAsync(game.JobId) end)
    if banOk and bans and bans[tostring(player.UserId)] then
        local b = bans[tostring(player.UserId)]
        if b.duration == -1 or os.time() < b.unbanTime then
            local tm = b.duration == -1 and "Permanent" or ("Unban in: " .. getBanTimeRemaining(b.unbanTime))
            player:Kick("Banned from this server\nReason: " .. (b.reason or "Violations") .. "\n" .. tm)
            return
        end
    end

    playerJoinTimes[player.UserId] = os.time()
    playerLastPos[player.UserId] = nil

    -- Queue join event (batched)
    queueEvent("player_added", "/api/tracking/join", {
        userId     = player.UserId,
        username   = player.Name,
        serverCode = serverCode,
        jobId      = game.JobId
    })

    -- Re-freeze if needed
    if frozenPlayers[player.Name] then
        player.CharacterAdded:Connect(function(char)
            local hrp = char:WaitForChild("HumanoidRootPart", 5)
            if hrp then hrp.Anchored = true end
        end)
    end

    -- Handle admin shift: if admin leaves server, end shift
    player.AncestryChanged:Connect(function()
        -- handled in PlayerRemoving
    end)
end)

Players.PlayerRemoving:Connect(function(player)
    local joinTime = playerJoinTimes[player.UserId]
    playerJoinTimes[player.UserId] = nil
    playerLastPos[player.UserId] = nil

    queueEvent("player_left", "/api/tracking/leave", {
        userId     = player.UserId,
        username   = player.Name,
        serverCode = serverCode,
        duration   = joinTime and (os.time() - joinTime) or 0
    })
end)

-- Shutdown cleanup
game:BindToClose(function()
    isShuttingDown = true
    flushEvents()
    httpDelete("/api/servers/" .. serverCode)
    task.wait(1)
end)

-- ============================================================
-- META: send server name/code on first player join
-- ============================================================
local metaSent = false
Players.PlayerAdded:Connect(function(player)
    if metaSent then return end
    metaSent = true
    task.wait(2) -- wait for TeleportData
    httpPost("/api/servers/" .. serverCode .. "/meta", {
        name     = serverName,
        joinCode = serverJoinCode,
        ownerId  = serverOwnerId
    })
end)

-- ============================================================
-- PUBLIC MODULE API
-- ============================================================
local Shield = {}

-- ── REPORTING (Roblox-only) ──────────────────────────────────

function Shield.ShotsFired(shooterName, shooterUserId, targetName, targetUserId, weapon, posX, posZ)
    queueEvent("shots_fired", "/api/tracking/shots", {
        serverCode   = serverCode,
        shooterName  = shooterName,
        shooterUserId= shooterUserId,
        targetName   = targetName,
        targetUserId = targetUserId,
        weapon       = weapon,
        posX         = posX,
        posZ         = posZ
    })
end

function Shield.SetRobbery(suspects, robberyName, robberyType, startedAt, posX, posZ)
    queueEvent("robbery", "/api/tracking/robbery", {
        serverCode  = serverCode,
        suspects    = suspects,
        robberyName = robberyName,
        robberyType = robberyType,
        startedAt   = startedAt or os.time(),
        posX        = posX,
        posZ        = posZ
    })
end

function Shield.SetWanted(playerName, playerUserId, stars, reason, crimes)
    queueEvent("set_wanted", "/api/tracking/wanted", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        stars        = stars,
        reason       = reason,
        crimes       = crimes
    })
end

function Shield.PlayerTeamChanged(playerName, playerUserId, oldTeam, newTeam, xpGiven)
    queueEvent("team_changed", "/api/tracking/teamchange", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        oldTeam      = oldTeam,
        newTeam      = newTeam,
        xpGiven      = xpGiven or 0
    })
end

function Shield.PhoneCall(playerName, playerUserId, posX, posZ, forTeam, message)
    queueEvent("phone_call", "/api/tracking/phonecall", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        posX         = posX,
        posZ         = posZ,
        forTeam      = forTeam,
        message      = message
    })
end

function Shield.PlayerDown(playerName, playerUserId, playerTeam, killerName, killerId, weaponName, posX, posZ)
    queueEvent("player_down", "/api/tracking/playerdown", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        playerTeam   = playerTeam,
        killerName   = killerName,
        killerId     = killerId,
        weaponName   = weaponName,
        posX         = posX,
        posZ         = posZ
    })
end

-- ── PUNISHMENTS (log + command) ──────────────────────────────

function Shield.Ban(bannedName, bannedUserId, responsibleName, responsibleId, duration, reason)
    task.spawn(function()
        httpPost("/api/punishments/ban", {
            serverCode          = serverCode,
            bannedUserName      = bannedName,
            bannedUserId        = bannedUserId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            duration            = duration or -1,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Unban(userId, responsibleName, responsibleId, reason)
    task.spawn(function()
        httpPost("/api/punishments/unban", {
            userId              = userId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Kick(targetName, targetId, responsibleName, responsibleId, reason)
    task.spawn(function()
        httpPost("/api/punishments/kick", {
            serverCode          = serverCode,
            target              = targetName,
            targetId            = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided"
        })
    end)
end

function Shield.Warn(targetName, targetId, responsibleName, responsibleId, reason, expireSeconds)
    task.spawn(function()
        httpPost("/api/punishments/warn", {
            serverCode          = serverCode,
            toWho               = targetName,
            toWhoId             = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName,
            reason              = reason or "No reason provided",
            time                = expireSeconds or -1
        })
    end)
end

function Shield.Unwarn(targetName, targetId, caseId)
    task.spawn(function()
        httpPost("/api/punishments/unwarn", {
            serverCode = serverCode,
            who        = targetName,
            whoId      = targetId,
            caseId     = caseId
        })
    end)
end

function Shield.Warns(targetName, targetId)
    -- Synchronous fetch (use in task.spawn to avoid blocking)
    local url = CONFIG.BASE_URL .. "/api/punishments/warns/" .. tostring(targetId)
    local ok, result = pcall(function()
        return HttpService:GetAsync(url, false, {
            ["Authorization"] = "Bearer " .. CONFIG.API_TOKEN
        })
    end)
    if ok then
        local parsed = pcall(function() return HttpService:JSONDecode(result) end)
        return parsed or {}
    end
    return {}
end

function Shield.FreezeToggle(targetName, targetId, responsibleName, responsibleId)
    task.spawn(function()
        httpPost("/api/punishments/freeze", {
            serverCode          = serverCode,
            targetUsername      = targetName,
            targetId            = targetId,
            responsibleId       = responsibleId,
            responsibleUsername = responsibleName
        })
    end)
end

function Shield.Bring(targetName, targetId, responsibleName, responsibleId)
    if not commandsQueue then return end
    -- Queue the command locally (heartbeat already handles 'bring')
    local adminPlayer = Players:GetPlayerByUserId(responsibleId)
    local targetPlayer = Players:GetPlayerByUserId(targetId) or Players:FindFirstChild(targetName)
    if adminPlayer and targetPlayer and adminPlayer.Character and targetPlayer.Character then
        local hum = targetPlayer.Character:FindFirstChildOfClass("Humanoid")
        if hum then hum.Sit = false end
        task.wait(0.1)
        if adminPlayer.Character:FindFirstChild("HumanoidRootPart") and targetPlayer.Character then
            targetPlayer.Character:PivotTo(adminPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0,0,-4))
        end
    end
    -- Log it
    queueEvent("bring", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "bring",
        targetUsername = targetName,
        targetId     = targetId,
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

function Shield.To(targetName, targetId, responsibleName, responsibleId)
    local adminPlayer = Players:GetPlayerByUserId(responsibleId)
    local targetPlayer = Players:GetPlayerByUserId(targetId) or Players:FindFirstChild(targetName)
    if adminPlayer and targetPlayer and targetPlayer.Character and targetPlayer.Character:FindFirstChild("HumanoidRootPart") then
        local hum = adminPlayer.Character and adminPlayer.Character:FindFirstChildOfClass("Humanoid")
        if hum then hum.Sit = false end
        task.wait(0.1)
        if adminPlayer.Character and targetPlayer.Character:FindFirstChild("HumanoidRootPart") then
            adminPlayer.Character:PivotTo(targetPlayer.Character.HumanoidRootPart.CFrame * CFrame.new(0,0,4))
        end
    end
    queueEvent("to", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "to",
        targetUsername = targetName,
        targetId     = targetId,
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

-- ── SIDE COMMANDS ────────────────────────────────────────────

function Shield.ServerShutdown(responsibleName, responsibleId)
    -- Notify API that shutdown is happening (does NOT execute it — let game:BindToClose handle that)
    queueEvent("shutdown_notify", "/api/punishments/log", {
        serverCode   = serverCode,
        type         = "server_shutdown",
        actorUsername= responsibleName,
        actorId      = responsibleId
    })
end

function Shield.PlayerSetInventory(playerName, playerUserId, inventory)
    inventoryCache[playerUserId] = inventory
    queueEvent("inventory", "/api/tracking/inventory", {
        serverCode   = serverCode,
        playerName   = playerName,
        playerUserId = playerUserId,
        inventory    = inventory
    })
end

function Shield.UpdateAdmins(adminIdsArray)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/admins", {
            adminIds = adminIdsArray
        })
    end)
end

function Shield.SetServerOwner(userId)
    serverOwnerId = userId
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/meta", {
            ownerId = userId
        })
    end)
end

function Shield.ServerSetName(newName)
    serverName = newName
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/meta", { name = newName })
    end)
end

function Shield.ServerSetJoinCode(newCode)
    serverJoinCode = newCode
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/meta", { joinCode = newCode })
    end)
end

function Shield.Addlocation(locationName, positionsArray, text)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/addlocation", {
            locationName     = locationName,
            LocationPosition = positionsArray,
            Text             = text
        })
    end)
end

function Shield.Message(toWho, message)
    task.spawn(function()
        httpPost("/api/servers/" .. serverCode .. "/commands", {
            action   = "message",
            target   = toWho,
            reason   = message,
            senderId = serverOwnerId or 0
        })
    end)
end

function Shield.GetServerCode()
    return serverCode
end

return Shield
