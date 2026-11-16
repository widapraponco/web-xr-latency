const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const CHANNEL_LABEL = 'state';

export function $(id) {
  return document.getElementById(id);
}

export function createLogger(logEl) {
  return (msg) => {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console.log(line);
    if (logEl) {
      logEl.textContent += line + '\n';
      logEl.scrollTop = logEl.scrollHeight;
    }
  };
}

export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function createSignaling(role, handlers = {}) {
  let ws = null;

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    handlers.onWsState?.(ws.readyState);

    ws.addEventListener('open', () => {
      handlers.onWsState?.(ws.readyState);
      handlers.onLog?.(`WS connected, registering as "${role}"`);
      send({ type: 'register', role });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        handlers.onLog?.('WS received invalid JSON');
        return;
      }
      switch (msg.type) {
        case 'registered':
          handlers.onRegistered?.(msg.role);
          break;
        case 'peer-joined':
          handlers.onPeerJoined?.(msg.role);
          break;
        case 'peer-left':
          handlers.onPeerLeft?.(msg.role);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'ready':
          handlers.onSignal?.(msg);
          break;
        case 'error':
          handlers.onLog?.(`Signaling error: ${msg.message}`);
          break;
        default:
          handlers.onLog?.(`Unknown WS message: ${msg.type}`);
      }
    });

    ws.addEventListener('close', () => {
      handlers.onWsState?.(WebSocket.CLOSED);
      handlers.onLog?.('WS closed');
      handlers.onClose?.();
    });

    ws.addEventListener('error', () => {
      handlers.onLog?.('WS error');
    });
  }

  function sendSignal(type, payload) {
    send({ type, payload });
  }

  function close() {
    try { ws?.close(); } catch {}
    ws = null;
  }

  return { connect, sendSignal, close, get socket() { return ws; } };
}

export function createPeerConnection(handlers = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingRemoteCandidates = [];
  let hasRemoteDescription = false;

  function onPcState() {
    handlers.onPcState?.(pc.connectionState, pc.signalingState, pc.iceConnectionState);
  }

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      handlers.onLocalIceCandidate?.(ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate);
    }
  };
  pc.onconnectionstatechange = onPcState;
  pc.oniceconnectionstatechange = onPcState;
  pc.onsignalingstatechange = onPcState;

  async function setRemoteDescription(desc) {
    await pc.setRemoteDescription(desc);
    hasRemoteDescription = true;
    while (pendingRemoteCandidates.length) {
      const c = pendingRemoteCandidates.shift();
      try { await pc.addIceCandidate(c); } catch (e) { handlers.onLog?.(`ICE add error: ${e.message}`); }
    }
  }

  async function addIceCandidate(candidate) {
    if (!candidate) return;
    if (!hasRemoteDescription) {
      pendingRemoteCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (e) {
      handlers.onLog?.(`ICE add error: ${e.message}`);
    }
  }

  function close() {
    try { pc.close(); } catch {}
  }

  return { pc, setRemoteDescription, addIceCandidate, close };
}

export function bindDataChannel(dc, handlers = {}) {
  dc.onopen = () => handlers.onOpen?.(dc);
  dc.onclose = () => handlers.onClose?.(dc);
  dc.onerror = (e) => handlers.onError?.(e);
  dc.onmessage = (e) => handlers.onMessage?.(e);
  return dc;
}

export function wsStateLabel(state) {
  switch (state) {
    case WebSocket.CONNECTING: return 'connecting';
    case WebSocket.OPEN: return 'open';
    case WebSocket.CLOSING: return 'closing';
    case WebSocket.CLOSED: return 'closed';
    default: return String(state ?? '-');
  }
}

export { ICE_SERVERS, CHANNEL_LABEL };
