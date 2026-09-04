'use strict';

const express = require('express');
const router = express.Router();
const { oauthStates, activeAdmins } = require('../state');
const { getUserRole } = require('../middleware/auth');

const CLIENT_ID     = process.env.ClientId;
const CLIENT_SECRET = process.env.ClientSecret;
const REDIRECT_URI  = process.env.RedirectURI;

/** Start OAuth flow — optional, opens Roblox login in new window */
router.get('/login', (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).send('Missing state');

    oauthStates[state] = { status: 'pending', adminData: null, time: Date.now() };

    const url = `https://apis.roblox.com/oauth/v1/authorize?` +
        `client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=openid%20profile` +
        `&response_type=code` +
        `&state=${state}`;

    res.redirect(url);
});

/** OAuth callback from Roblox */
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates[state]) {
        return res.send(`<script>setTimeout(()=>window.close(),100);</script>`);
    }

    try {
        const tokenRes = await fetch('https://apis.roblox.com/oauth/v1/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI
            })
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) throw new Error('Token exchange failed');

        const userRes = await fetch('https://apis.roblox.com/oauth/v1/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const userData = await userRes.json();

        const userId   = parseInt(userData.sub);
        const username = userData.preferred_username || userData.name;
        const role     = getUserRole(userId);

        oauthStates[state] = {
            status: 'success',
            adminData: { userId, username, role }
        };

        // Register admin session if authorized
        if (role !== 'user' && !activeAdmins[userId]) {
            activeAdmins[userId] = {
                userId,
                username,
                role,
                status: 'Online',
                serverCode: null,
                updatedAt: new Date().toISOString(),
                lastSeen: Date.now()
            };
        } else if (role !== 'user') {
            activeAdmins[userId].lastSeen = Date.now();
            activeAdmins[userId].username = username;
        }

        res.send(`<script>
            if(window.opener) {
                window.opener.postMessage({ type:'oauth_success', userId:${userId}, username:'${username.replace(/'/g,"\\'")}', role:'${role}' }, '*');
            }
            setTimeout(()=>window.close(), 100);
        </script>`);

    } catch (err) {
        oauthStates[state] = { status: 'failed', adminData: null };
        res.send(`<script>
            if(window.opener) window.opener.postMessage({ type:'oauth_failed' }, '*');
            setTimeout(()=>window.close(), 100);
        </script>`);
    }
});

/** Poll login status by state token */
router.get('/status', (req, res) => {
    const { state } = req.query;
    if (!state || !oauthStates[state]) return res.json({ status: 'unknown' });
    res.json(oauthStates[state]);
});

/** Register admin presence (called on page load if session cookie exists) */
router.post('/register', (req, res) => {
    const { userId, username } = req.body;
    const id   = parseInt(userId);
    const role = getUserRole(id);

    if (role === 'user') return res.status(403).json({ error: 'Not authorized' });

    if (!activeAdmins[id]) {
        activeAdmins[id] = {
            userId: id,
            username,
            role,
            status: 'Online',
            serverCode: null,
            updatedAt: new Date().toISOString(),
            lastSeen: Date.now()
        };
    } else {
        activeAdmins[id].lastSeen = Date.now();
        activeAdmins[id].status = activeAdmins[id].status === 'Offline' ? 'Online' : activeAdmins[id].status;
    }

    res.json({ success: true, role });
});

/** Disconnect — mark offline */
router.post('/disconnect', (req, res) => {
    const { userId } = req.body;
    if (userId && activeAdmins[userId]) {
        activeAdmins[userId].status = 'Offline';
        activeAdmins[userId].updatedAt = new Date().toISOString();
    }
    res.json({ success: true });
});

/** Avatar proxy */
router.get('/avatar/:userId', async (req, res) => {
    try {
        const r = await fetch(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=false`
        );
        const d = await r.json();
        if (d?.data?.[0]?.state === 'Completed') return res.redirect(d.data[0].imageUrl);
        res.redirect('https://tr.rbxcdn.com/3b43a29ce73ed72b47b2c554a938c5d6/150/150/AvatarHeadshot/Png');
    } catch {
        res.redirect('https://tr.rbxcdn.com/3b43a29ce73ed72b47b2c554a938c5d6/150/150/AvatarHeadshot/Png');
    }
});

// Clean up expired oauth states every 10 minutes
setInterval(() => {
    const now = Date.now();
    Object.keys(oauthStates).forEach(k => {
        if (now - oauthStates[k].time > 600000) delete oauthStates[k];
    });
}, 600000);

module.exports = router;
