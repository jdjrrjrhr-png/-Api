'use strict';

const { WebSocketServer } = require('ws');

let wss = null;
const subscriptions = new Map(); // ws -> serverCode

function initWebSocket(httpServer) {
    wss = new WebSocketServer({ server: httpServer, path: '/ws' });

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'subscribe' && msg.serverCode) {
                    subscriptions.set(ws, msg.serverCode);
                } else if (msg.type === 'unsubscribe') {
                    subscriptions.delete(ws);
                }
            } catch { /* ignore malformed messages */ }
        });

        ws.on('close', () => subscriptions.delete(ws));
        ws.on('error', () => subscriptions.delete(ws));
    });

    // Heartbeat ping every 25s to detect dead connections
    setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) { ws.terminate(); subscriptions.delete(ws); return; }
            ws.isAlive = false;
            ws.ping();
        });
    }, 25000);

    console.log('[ws] WebSocket server attached at /ws');
}

/** Push a position packet to every dashboard client subscribed to this serverCode */
function broadcastPositions(serverCode, positions) {
    if (!wss) return;
    const payload = JSON.stringify({ type: 'positions', serverCode, positions, timestamp: Date.now() });
    subscriptions.forEach((code, ws) => {
        if (code === serverCode && ws.readyState === 1) {
            try { ws.send(payload); } catch { /* ignore send errors */ }
        }
    });
}

/** Push an arbitrary event (e.g. eviction notice) to clients subscribed to this serverCode */
function broadcastEvent(serverCode, type, data) {
    if (!wss) return;
    const payload = JSON.stringify({ type, serverCode, ...data, timestamp: Date.now() });
    subscriptions.forEach((code, ws) => {
        if (code === serverCode && ws.readyState === 1) {
            try { ws.send(payload); } catch { /* ignore send errors */ }
        }
    });
}

module.exports = { initWebSocket, broadcastPositions, broadcastEvent };
