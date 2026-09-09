'use strict';

const express = require('express');
const router = express.Router();
const { oauthStates, activeAdmins, cacheUsername } = require('../state');

const CLIENT_ID     = process.env.ClientId;
const CLIENT_SECRET = process.env.ClientSecret;
const REDIRECT_URI  = process.env.RedirectURI;

/**
 * NOTE: Login no longer resolves a global "role". Any Roblox account can
 * sign in — what they can actually see/do is resolved per-server the
 * moment they open a specific server's dashboard (getServerRole()).
 * This matches the module-driven permission model: access comes from
 * Shield.UpdateAdmins() / Shield.SetServerOwner(), not from a login gate.
 */

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

        cacheUsername(userId, username);

        oauthStates[state] = { status: 'success', adminData: { userId, username } };

        if (!activeAdmins[userId]) {
            activeAdmins[userId] = {
                userId, username,
                status: 'Online', serverCode: null,
                updatedAt: new Date().toISOString(),
                lastSeen: Date.now(),
                totalBreakSeconds: 0,
                shiftPunishments: 0
            };
        } else {
            activeAdmins[userId].lastSeen = Date.now();
            activeAdmins[userId].username = username;
            if (activeAdmins[userId].status === 'Offline') activeAdmins[userId].status = 'Online';
        }

        res.send(`<script>
            if(window.opener) {
                window.opener.postMessage({ type:'oauth_success', userId:${userId}, username:'${username.replace(/'/g,"\\'")}' }, '*');
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

router.get('/status', (req, res) => {
    const { state } = req.query;
    if (!state || !oauthStates[state]) return res.json({ status: 'unknown' });
    res.json(oauthStates[state]);
});

/** Register/refresh dashboard presence (called on page load + heartbeat) */
router.post('/register', (req, res) => {
    const { userId, username } = req.body;
    const id = parseInt(userId);
    if (!id) return res.status(400).json({ error: 'userId required' });

    cacheUsername(id, username);

    if (!activeAdmins[id]) {
        activeAdmins[id] = {
            userId: id, username,
            status: 'Online', serverCode: null,
            updatedAt: new Date().toISOString(),
            lastSeen: Date.now(),
            totalBreakSeconds: 0,
            shiftPunishments: 0
        };
    } else {
        activeAdmins[id].lastSeen = Date.now();
        activeAdmins[id].username = username || activeAdmins[id].username;
        if (activeAdmins[id].status === 'Offline') activeAdmins[id].status = 'Online';
    }

    res.json({ success: true });
});

router.post('/disconnect', (req, res) => {
    const { userId } = req.body;
    if (userId && activeAdmins[userId]) {
        activeAdmins[userId].status = 'Offline';
        activeAdmins[userId].updatedAt = new Date().toISOString();
    }
    res.json({ success: true });
});

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

setInterval(() => {
    const now = Date.now();
    Object.keys(oauthStates).forEach(k => {
        if (now - oauthStates[k].time > 600000) delete oauthStates[k];
    });
}, 600000);

module.exports = router;
