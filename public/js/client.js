import * as THREE from "three";
import {
  $,
  createLogger,
  createSignaling,
  createPeerConnection,
  bindDataChannel,
  wsStateLabel,
  CHANNEL_LABEL,
} from "./common.js";
import { createScene } from "./scene.js";

const log = createLogger($("log"));
const wsStateEl = $("ws-state");
const pcStateEl = $("pc-state");
const dcStateEl = $("dc-state");
const connBadgeEl = $("conn-badge");
const seqEl = $("seq");
const rateEl = $("rate");
const rttEl = $("rtt");
const owEl = $("ow");
const jitterEl = $("jitter");
const lossEl = $("loss");
const fpsEl = $("fps");
const modeLabelEl = $("mode-label");
const modeToggleBtn = $("mode-toggle");
const exportBtn = $("export-csv");
const offlineBadgeEl = $("offline-badge");

const { cube, render } = createScene($("scene"));

// --- config ---
const JITTER_BUFFER_MS = 50;
const PING_INTERVAL_MS = 200;
const HUD_INTERVAL_MS = 250;
const RECORD_INTERVAL_MS = 250;
const HISTORY_WINDOW_MS = 30000;
const IA_WINDOW_MS = 2000;
const WATCHDOG_MS = 500;

// --- connection state ---
let signaling = null;
let peer = null;
let dataChannel = null;
let pingInterval = null;
let hudInterval = null;

// --- watchdog ---
let lastPacketTime = 0;
let watchdogArmed = false;
let watchdogLost = false;

// --- render/mode state ---
let mode = "raw"; // 'raw' | 'interpolated'
const stateBuffer = []; // { t, pos: THREE.Vector3, rx, ry, rz }
let latestSample = null;

// --- metrics state ---
let lastSeq = -1;
let recvCountWindow = 0;
let recvHz = 0;
let lastArrival = null;
const iaWindow = []; // { t, ia }
const lossWindow = []; // { t, received, lost }
let rttMs = null;

// --- fps ---
let fpsFrames = 0;
let fpsLastTime = performance.now();
let fpsValue = 0;

// --- recording ---
const records = [];
const startWallTime = Date.now();
const startPerf = performance.now();

function setWsState(s) {
  wsStateEl.textContent = typeof s === "number" ? wsStateLabel(s) : String(s);
}
function setPcState() {
  if (!peer) {
    pcStateEl.textContent = "-";
    return;
  }
  const pc = peer.pc;
  pcStateEl.textContent = `${pc.connectionState}/${pc.iceConnectionState}`;
  if (connBadgeEl) connBadgeEl.textContent = pc.connectionState || "-";
}
function setDcState(s) {
  dcStateEl.textContent = s || "-";
}

function pruneByTime(arr, now, windowMs) {
  const cutoff = now - windowMs;
  while (arr.length && arr[0].t < cutoff) arr.shift();
}

function getJitterMs(now) {
  pruneByTime(iaWindow, now, IA_WINDOW_MS);
  if (iaWindow.length < 2) return null;
  let mean = 0;
  for (const s of iaWindow) mean += s.ia;
  mean /= iaWindow.length;
  let variance = 0;
  for (const s of iaWindow) {
    const d = s.ia - mean;
    variance += d * d;
  }
  variance /= iaWindow.length;
  return Math.sqrt(variance);
}

function getLossPct(now) {
  pruneByTime(lossWindow, now, HISTORY_WINDOW_MS);
  let received = 0;
  let lost = 0;
  for (const e of lossWindow) {
    received += e.received;
    lost += e.lost;
  }
  const expected = received + lost;
  if (expected <= 0) return 0;
  return (lost / expected) * 100;
}

function stopIntervals() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (hudInterval) {
    clearInterval(hudInterval);
    hudInterval = null;
  }
}

function resetLiveMetrics() {
  lastSeq = -1;
  recvCountWindow = 0;
  recvHz = 0;
  lastArrival = null;
  iaWindow.length = 0;
  lossWindow.length = 0;
  rttMs = null;
  stateBuffer.length = 0;
  latestSample = null;
  seqEl.textContent = "-";
  rateEl.textContent = "0";
  rttEl.textContent = "-";
  owEl.textContent = "-";
  jitterEl.textContent = "-";
  lossEl.textContent = "0.00";
}

function cleanupPeer(reason) {
  stopIntervals();
  if (dataChannel) {
    try {
      dataChannel.close();
    } catch {}
    dataChannel = null;
  }
  if (peer) {
    peer.close();
    peer = null;
  }
  watchdogArmed = false;
  watchdogLost = false;
  lastPacketTime = 0;
  if (offlineBadgeEl) offlineBadgeEl.hidden = true;
  resetLiveMetrics();
  setPcState();
  setDcState("closed");
  if (reason) log(`Peer cleaned up: ${reason}`);
}

function sendPing() {
  if (!dataChannel || dataChannel.readyState !== "open") return;
  try {
    dataChannel.send(JSON.stringify({ type: "ping", t0: performance.now() }));
  } catch {}
}

function isValidState(msg) {
  if (!msg || typeof msg.seq !== "number") return false;
  const p = msg.position;
  const r = msg.rotation;
  if (
    !Array.isArray(p) ||
    p.length !== 3 ||
    !Array.isArray(r) ||
    r.length !== 3
  )
    return false;
  for (let i = 0; i < 3; i++) {
    if (typeof p[i] !== "number" || !Number.isFinite(p[i])) return false;
    if (typeof r[i] !== "number" || !Number.isFinite(r[i])) return false;
  }
  return true;
}

function pushSample(now, msg) {
  const sample = {
    t: now,
    pos: new THREE.Vector3(msg.position[0], msg.position[1], msg.position[2]),
    rx: msg.rotation[0],
    ry: msg.rotation[1],
    rz: msg.rotation[2],
  };
  stateBuffer.push(sample);
  latestSample = sample;
  const cutoff = now - 2000;
  while (stateBuffer.length > 2 /* && stateBuffer[0].t < cutoff*/)
    stateBuffer.shift();
}

function applySample(sample) {
  if (!sample) return;
  cube.position.copy(sample.pos);
  cube.rotation.set(sample.rx, sample.ry, sample.rz);
}

function handleStateMessage(msg) {
  const now = performance.now();
  if (!isValidState(msg)) return;
  if (msg.seq <= lastSeq) return; // drop stale/out-of-order (unordered channel)

  let gap = 0;
  if (lastSeq >= 0) gap = Math.max(0, msg.seq - lastSeq - 1);
  lossWindow.push({ t: now, received: 1, lost: gap });
  pruneByTime(lossWindow, now, HISTORY_WINDOW_MS);

  if (lastArrival != null) {
    const ia = now - lastArrival;
    if (ia >= 0 && Number.isFinite(ia)) {
      iaWindow.push({ t: now, ia });
      pruneByTime(iaWindow, now, IA_WINDOW_MS);
    }
  }
  lastArrival = now;
  lastSeq = msg.seq;
  recvCountWindow += 1;
  seqEl.textContent = String(lastSeq);

  pushSample(now, msg);
  if (mode === "raw") {
    applySample(latestSample);
  }
}

function onDataChannelMessage(ev) {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!msg) return;
  lastPacketTime = performance.now();
  if (msg.type === "pong") {
    if (typeof msg.t0 === "number") {
      const sample = performance.now() - msg.t0;
      if (sample >= 0 && Number.isFinite(sample)) rttMs = sample;
    }
    return;
  }
  if (typeof msg.seq === "number") {
    handleStateMessage(msg);
  }
}

function updateInterpolated(now) {
  if (mode !== "interpolated") return;
  if (stateBuffer.length === 0) return;
  const renderTime = now - JITTER_BUFFER_MS;

  if (renderTime <= stateBuffer[0].t) {
    applySample(stateBuffer[0]);
    return;
  }
  const last = stateBuffer[stateBuffer.length - 1];
  if (renderTime >= last.t) {
    applySample(last);
    return;
  }

  let i = stateBuffer.length - 2;
  while (i > 0 && stateBuffer[i].t > renderTime) i--;
  const s0 = stateBuffer[i];
  const s1 = stateBuffer[i + 1];
  if (!s0 || !s1) {
    applySample(last);
    return;
  }
  const span = s1.t - s0.t;
  const alpha =
    span > 0 ? Math.min(1, Math.max(0, (renderTime - s0.t) / span)) : 1;
  cube.position.lerpVectors(s0.pos, s1.pos, alpha);
  cube.rotation.set(
    THREE.MathUtils.lerp(s0.rx, s1.rx, alpha),
    THREE.MathUtils.lerp(s0.ry, s1.ry, alpha),
    THREE.MathUtils.lerp(s0.rz, s1.rz, alpha),
  );
}

function updateWatchdog(now) {
  if (!watchdogArmed) {
    watchdogLost = false;
    if (offlineBadgeEl) offlineBadgeEl.hidden = true;
    return false;
  }
  const lost = now - lastPacketTime > WATCHDOG_MS;
  if (lost !== watchdogLost) {
    watchdogLost = lost;
    if (offlineBadgeEl) offlineBadgeEl.hidden = !lost;
    log(
      lost
        ? "CONNECTION LOST / OFFLINE (no packets for 500ms)"
        : "Connection recovered",
    );
  }
  return lost;
}

function fmt(n, digits = 2) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function recordSample(now) {
  pruneByTime(records, now, HISTORY_WINDOW_MS);
  records.push({
    t: now,
    wall: startWallTime + (now - startPerf),
    mode,
    rtt: rttMs,
    ow: typeof rttMs === "number" ? rttMs / 2 : null,
    jitter: getJitterMs(now),
    loss: getLossPct(now),
    fps: fpsValue,
    recvHz,
    seq: lastSeq >= 0 ? lastSeq : null,
  });
}

function updateHud(now) {
  recvHz = recvCountWindow * (1000 / HUD_INTERVAL_MS);
  recvCountWindow = 0;
  const jitter = getJitterMs(now);
  const loss = getLossPct(now);
  const ow = typeof rttMs === "number" ? rttMs / 2 : null;

  rttEl.textContent = fmt(rttMs, 2);
  owEl.textContent = fmt(ow, 2);
  jitterEl.textContent = fmt(jitter, 2);
  lossEl.textContent = fmt(loss, 2);
  fpsEl.textContent = String(Math.round(fpsValue));
  rateEl.textContent = fmt(recvHz, 1);
}

function startHudAndPing() {
  stopIntervals();
  pingInterval = setInterval(sendPing, PING_INTERVAL_MS);
  hudInterval = setInterval(() => {
    const now = performance.now();
    updateHud(now);
  }, HUD_INTERVAL_MS);
  // recording on separate cadence aligned to HUD ticks
}

let lastRecordTime = 0;
function maybeRecord(now) {
  if (now - lastRecordTime >= RECORD_INTERVAL_MS) {
    lastRecordTime = now;
    recordSample(now);
  }
}

function attachDataChannel(dc) {
  dataChannel = dc;
  bindDataChannel(dc, {
    onOpen: () => {
      setDcState("open");
      if (connBadgeEl) connBadgeEl.textContent = "connected";
      log(`DataChannel open: ${dc.label}`);
      watchdogArmed = true;
      watchdogLost = false;
      lastPacketTime = performance.now();
      if (offlineBadgeEl) offlineBadgeEl.hidden = true;
      startHudAndPing();
    },
    onClose: () => {
      setDcState("closed");
      log("DataChannel closed");
      stopIntervals();
    },
    onError: () => {
      setDcState("error");
      log("DataChannel error");
    },
    onMessage: onDataChannelMessage,
  });
  setDcState(dc.readyState);
}

async function handleOffer(msg) {
  cleanupPeer();
  try {
    peer = createPeerConnection({
      onLocalIceCandidate: (c) => signaling.sendSignal("ice-candidate", c),
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
    signaling.sendSignal("answer", peer.pc.localDescription);
    log("Received offer, sent answer");
  } catch (e) {
    log(`Failed handling offer: ${e.message}`);
    cleanupPeer("offer handling failure");
  }
}

async function handleSignal(msg) {
  switch (msg.type) {
    case "offer":
      await handleOffer(msg);
      break;
    case "ice-candidate":
      if (peer) await peer.addIceCandidate(msg.payload);
      break;
    default:
      break;
  }
}

signaling = createSignaling("client", {
  onLog: log,
  onWsState: setWsState,
  onRegistered: (role) => log(`Registered as ${role}`),
  onPeerJoined: async (role) => {
    log(`Peer joined: ${role}`);
    if (role === "host") {
      signaling.sendSignal("ready", null);
      log("Sent ready signal to host");
    }
  },
  onPeerLeft: (role) => {
    log(`Peer left: ${role}`);
    cleanupPeer("peer left");
  },
  onSignal: handleSignal,
  onClose: () => cleanupPeer("signaling closed"),
});

function setMode(next) {
  mode = next;
  modeLabelEl.textContent = mode === "raw" ? "Raw" : "Interpolated";
  modeToggleBtn.textContent =
    mode === "raw" ? "Switch to Interpolated" : "Switch to Raw";
  log(`Render mode: ${mode}`);
  if (mode === "raw" && latestSample) applySample(latestSample);
}

modeToggleBtn.addEventListener("click", () => {
  setMode(mode === "raw" ? "interpolated" : "raw");
});

function csvEscape(v) {
  if (v == null || (typeof v === "number" && !Number.isFinite(v))) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const now = performance.now();
  pruneByTime(records, now, HISTORY_WINDOW_MS);
  const header = [
    "time_iso",
    "elapsed_ms",
    "mode",
    "rtt_ms",
    "ow_est_ms",
    "jitter_ms",
    "loss_pct",
    "fps",
    "recv_hz",
    "last_seq",
  ];
  const rows = [header.join(",")];
  for (const r of records) {
    rows.push(
      [
        new Date(r.wall).toISOString(),
        (r.t - startPerf).toFixed(2),
        r.mode,
        typeof r.rtt === "number" ? r.rtt.toFixed(3) : "",
        typeof r.ow === "number" ? r.ow.toFixed(3) : "",
        typeof r.jitter === "number" ? r.jitter.toFixed(3) : "",
        typeof r.loss === "number" ? r.loss.toFixed(3) : "",
        typeof r.fps === "number" ? r.fps.toFixed(1) : "",
        typeof r.recvHz === "number" ? r.recvHz.toFixed(2) : "",
        r.seq ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `benchmark-client-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  log(
    `Exported CSV (${records.length} samples, last ${HISTORY_WINDOW_MS / 1000}s)`,
  );
}

exportBtn.addEventListener("click", exportCsv);

function loop() {
  const now = performance.now();
  fpsFrames += 1;
  const dtFps = now - fpsLastTime;
  if (dtFps >= 1000) {
    fpsValue = (fpsFrames * 1000) / dtFps;
    fpsFrames = 0;
    fpsLastTime = now;
  }
  const lost = updateWatchdog(now);
  if (!lost) {
    updateInterpolated(now);
  }
  maybeRecord(now);
  render();
  requestAnimationFrame(loop);
}

setWsState(WebSocket.CONNECTING);
setDcState("-");
if (connBadgeEl) connBadgeEl.textContent = "connecting";
setMode("raw");
log("Client starting (auto-register, auto-answer, telemetry + mitigation)");
signaling.connect();
loop();

