import { $, createLogger, createSignaling, createPeerConnection, bindDataChannel, wsStateLabel, CHANNEL_LABEL } from './common.js';
import { createScene, applyState } from './scene.js';

const log = createLogger($('log'));
const wsStateEl = $('ws-state');
const pcStateEl = $('pc-state');
const dcStateEl = $('dc-state');
const seqEl = $('seq');
const rateEl = $('rate');
const ageEl = $('age');

const { cube, render } = createScene($('scene'));

let signaling = null;
let peer = null;
let dataChannel = null;
let lastSeq = -1;
let recvCount = 0;
let lastTimestamp = null;
let rateInterval = null;

function setWsState(s) { wsStateEl.textContent = typeof s === 'number' ? wsStateLabel(s) : String(s); }
function setPcState() {
  if (!peer) { pcStateEl.textContent = '-'; return; }
  const pc = peer.pc;
  pcStateEl.textContent = `${pc.connectionState}/${pc.iceConnectionState}`;
}
function setDcState(s) { dcStateEl.textContent = s || '-'; }

function cleanupPeer(reason) {
  if (dataChannel) { try { dataChannel.close(); } catch {} dataChannel = null; }
  if (peer) { peer.close(); peer = null; }
  lastSeq = -1;
  lastTimestamp = null;
  setPcState();
  setDcState('closed');
  if (reason) log(`Peer cleaned up: ${reason}`);
}

function onDataChannelMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!msg || typeof msg.seq !== 'number') return;
  if (msg.seq <= lastSeq) return; // drop stale/out-of-order (unordered channel)
  if (!applyState(cube, msg)) return;

  lastSeq = msg.seq;
  if (typeof msg.timestamp === 'number') lastTimestamp = msg.timestamp;
  recvCount += 1;
  seqEl.textContent = String(lastSeq);
}

function attachDataChannel(dc) {
  dataChannel = dc;
  bindDataChannel(dc, {
    onOpen: () => { setDcState('open'); log(`DataChannel open: ${dc.label}`); },
    onClose: () => { setDcState('closed'); log('DataChannel closed'); },
    onError: () => { setDcState('error'); log('DataChannel error'); },
    onMessage: onDataChannelMessage,
  });
  setDcState(dc.readyState);
}

async function handleOffer(msg) {
  cleanupPeer();
  lastSeq = -1;
  try {
    peer = createPeerConnection({
      onLocalIceCandidate: (c) => signaling.sendSignal('ice-candidate', c),
      onPcState: setPcState,
      onLog: log,
    });
    peer.pc.ondatachannel = (ev) => {
      if (ev.channel.label === CHANNEL_LABEL) {
        attachDataChannel(ev.channel);
      } else {
        log(`Ignoring unexpected channel: ${ev.channel.label}`);
      }
    };

    await peer.setRemoteDescription(msg.payload);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    signaling.sendSignal('answer', peer.pc.localDescription);
    log('Received offer, sent answer');
  } catch (e) {
    log(`Failed handling offer: ${e.message}`);
    cleanupPeer('offer handling failure');
  }
}

async function handleSignal(msg) {
  switch (msg.type) {
    case 'offer':
      await handleOffer(msg);
      break;
    case 'ice-candidate':
      if (peer) await peer.addIceCandidate(msg.payload);
      break;
    default:
      break;
  }
}

signaling = createSignaling('client', {
  onLog: log,
  onWsState: setWsState,
  onRegistered: (role) => log(`Registered as ${role}`),
  onPeerJoined: async (role) => {
    log(`Peer joined: ${role}`);
    if (role === 'host') {
      // host-joined-last case: nudge host to start offer
      signaling.sendSignal('ready', null);
      log('Sent ready signal to host');
    }
  },
  onPeerLeft: (role) => {
    log(`Peer left: ${role}`);
    cleanupPeer('peer left');
  },
  onSignal: handleSignal,
  onClose: () => cleanupPeer('signaling closed'),
});

rateInterval = setInterval(() => {
  rateEl.textContent = String(recvCount);
  recvCount = 0;
  if (lastTimestamp != null) {
    ageEl.textContent = Math.max(0, performance.now() - lastTimestamp).toFixed(1);
  } else {
    ageEl.textContent = '-';
  }
}, 500);

function loop() {
  render();
  requestAnimationFrame(loop);
}

setWsState(WebSocket.CONNECTING);
setDcState('-');
log('Client starting (auto-register, auto-answer, receive-only)');
signaling.connect();
loop();
