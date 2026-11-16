/**
 * Minimal WebRTC signaling server for a host/client pair.
 * - Serves static frontend from /public
 * - Relays WebSocket signaling messages: register, offer, answer, ice-candidate
 *
 * Protocol (JSON over WS):
 *   Client -> Server:
 *     { type: "register", role: "host" | "client" }
 *     { type: "offer" | "answer" | "ice-candidate", payload: <RTCSessionDescriptionInit | RTCIceCandidateInit> }
 *   Server -> Client:
 *     { type: "registered", role }
 *     { type: "peer-joined" | "peer-left", role }
 *     { type: "offer" | "answer" | "ice-candidate", from: role, payload }
 *     { type: "error", message }
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

// --- HTTP + static hosting -------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);

// --- Signaling state -------------------------------------------------------
// Single host/client pair for this lightweight prototype.
const peers = {
  host: /** @type {WebSocket|null} */ (null),
  client: /** @type {WebSocket|null} */ (null),
};

function safeSend(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function otherRole(role) {
  return role === 'host' ? 'client' : 'host';
}

function registerPeer(ws, role) {
  if (role !== 'host' && role !== 'client') {
    return safeSend(ws, { type: 'error', message: 'Invalid role. Use "host" or "client".' });
  }
  if (peers[role] && peers[role].readyState === WebSocket.OPEN) {
    return safeSend(ws, { type: 'error', message: `Role "${role}" is already connected.` });
  }

  peers[role] = ws;
  ws.role = role;

  safeSend(ws, { type: 'registered', role });
  safeSend(peers[otherRole(role)], { type: 'peer-joined', role });
  console.log(`[signal] registered: ${role}`);
}

function relayToPeer(ws, msg) {
  const role = ws.role;
  if (!role) {
    return safeSend(ws, { type: 'error', message: 'Must register before signaling.' });
  }

  const target = peers[otherRole(role)];
  if (!target || target.readyState !== WebSocket.OPEN) {
    return safeSend(ws, { type: 'error', message: `Peer "${otherRole(role)}" not connected.` });
  }

  // Forward only the signaling payload; tag with sender role for clarity.
  safeSend(target, {
    type: msg.type,
    from: role,
    payload: msg.payload ?? null,
  });
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return safeSend(ws, { type: 'error', message: 'Invalid JSON.' });
  }

  switch (msg.type) {
    case 'register':
      return registerPeer(ws, msg.role);
    case 'offer':
    case 'answer':
    case 'ice-candidate':
    case 'ready':
      return relayToPeer(ws, msg);
    default:
      return safeSend(ws, { type: 'error', message: `Unknown message type: ${String(msg.type)}` });
  }
}

function handleDisconnect(ws) {
  const role = ws.role;
  if (!role || peers[role] !== ws) return;

  peers[role] = null;
  safeSend(peers[otherRole(role)], { type: 'peer-left', role });
  console.log(`[signal] disconnected: ${role}`);
}

// --- WebSocket server ------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => console.error('[ws] error:', err.message));
});

// Basic heartbeat to drop dead connections.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// --- Start -----------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
