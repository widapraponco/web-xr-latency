import { $, createLogger, createSignaling, createPeerConnection, bindDataChannel, wsStateLabel, CHANNEL_LABEL } from './common.js';
import { createScene, createHostSimulation } from './scene.js';

const log = createLogger($('log'));
const wsStateEl = $('ws-state');
const pcStateEl = $('pc-state');
const dcStateEl = $('dc-state');
const seqEl = $('seq');
const rateEl = $('rate');
const modeEl = $('mode');

const { cube, render } = createScene($('scene'));
const sim = createHostSimulation(cube, {
  onModeChange: (mode) => {
    modeEl.textContent = `Mode: ${mode}`;
    log(`Mode: ${mode}`);
  },
});

let signaling = null;
let peer = null;
let dataChannel = null;
let seq = 0;
let sendCount = 0;
let sendInterval = null;
let rateInterval = null;
let offerInFlight = false;

function setWsState(s) { wsStateEl.textContent = typeof s === 'number' ? wsStateLabel(s) : String(s); }
function setPcState() {
  if (!peer) { pcStateEl.textContent = '-'; return; }
  const pc = peer.pc;
  pcStateEl.textContent = `${pc.connectionState}/${pc.iceConnectionState}`;
}
function setDcState(s) { dcStateEl.textContent = s || '-'; }

function cleanupPeer(reason) {
  if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
  offerInFlight = false;
  if (dataChannel) { try { dataChannel.close(); } catch {} dataChannel = null; }
  if (peer) { peer.close(); peer = null; }
  setPcState();
  setDcState('closed');
  if (reason) log(`Peer cleaned up: ${reason}`);
}

function startSendLoop() {
  if (sendInterval) return;
  sendInterval = setInterval(() => {
    sim.step(1 / 60);
    if (dataChannel && dataChannel.readyState === 'open') {
      seq += 1;
      const state = sim.getState();
      const msg = {
        seq,
        timestamp: performance.now(),
        position: state.position,
        rotation: state.rotation,
      };
      try {
        dataChannel.send(JSON.stringify(msg));
        sendCount += 1;
        seqEl.textContent = String(seq);
      } catch (e) {
        log(`Send error: ${e.message}`);
      }
    }
  }, 1000 / 60);
}

async function startOffer() {
  if (offerInFlight) return;
  if (peer && peer.pc.signalingState !== 'closed') {
    // avoid duplicate negotiation if DC/PC already active
    if (dataChannel && (dataChannel.readyState === 'open' || dataChannel.readyState === 'connecting')) return;
  }
  cleanupPeer();
  offerInFlight = true;
  try {
    peer = createPeerConnection({
      onLocalIceCandidate: (c) => signaling.sendSignal('ice-candidate', c),
      onPcState: setPcState,
      onLog: log,
    });

    dataChannel = peer.pc.createDataChannel(CHANNEL_LABEL, { ordered: false, maxRetransmits: 0 });
    bindDataChannel(dataChannel, {
      onOpen: () => { setDcState('open'); log('DataChannel open (ordered:false, maxRetransmits:0)'); startSendLoop(); },
      onClose: () => { setDcState('closed'); log('DataChannel closed'); },
      onError: () => { setDcState('error'); log('DataChannel error'); },
    });
    setDcState('connecting');

    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    signaling.sendSignal('offer', peer.pc.localDescription);
    log('Sent offer');
  } catch (e) {
    log(`Offer failed: ${e.message}`);
    cleanupPeer('offer failure');
  } finally {
    offerInFlight = false;
  }
}

async function handleSignal(msg) {
  if (!peer && msg.type !== 'ready') {
    // only host initiates; unexpected answer/ice before pc means ignore
  }
  switch (msg.type) {
    case 'ready':
      log('Peer ready signal received');
      await startOffer();
      break;
    case 'answer':
      if (!peer) { log('Received answer without active peer'); return; }
      try {
        await peer.setRemoteDescription(msg.payload);
        log('Applied remote answer');
        setPcState();
      } catch (e) {
        log(`Failed to apply answer: ${e.message}`);
      }
      break;
    case 'ice-candidate':
      if (!peer) return;
      await peer.addIceCandidate(msg.payload);
      break;
    default:
      break;
  }
}

signaling = createSignaling('host', {
  onLog: log,
  onWsState: setWsState,
  onRegistered: (role) => log(`Registered as ${role}`),
  onPeerJoined: async (role) => {
    log(`Peer joined: ${role}`);
    if (role === 'client') await startOffer();
  },
  onPeerLeft: (role) => {
    log(`Peer left: ${role}`);
    cleanupPeer('peer left');
  },
  onSignal: handleSignal,
  onClose: () => cleanupPeer('signaling closed'),
});

rateInterval = setInterval(() => {
  rateEl.textContent = String(sendCount);
  sendCount = 0;
}, 1000);

function loop() {
  render();
  requestAnimationFrame(loop);
}

setWsState(WebSocket.CONNECTING);
setDcState('-');
log('Host starting (auto-register, auto-negotiate, 60Hz state send)');
signaling.connect();
loop();
