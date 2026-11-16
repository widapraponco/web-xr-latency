/**
 * Frontend scaffold for WebRTC DataChannel latency benchmarking.
 * TODO: implement signaling client, RTCPeerConnection setup, DataChannel
 *       creation (host) / handling (client), and RTT/state-sync measurements.
 */

const roleSelect = document.getElementById('role');
const connectBtn = document.getElementById('connect');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');

function log(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = `Status: ${text}`;
}

connectBtn.addEventListener('click', () => {
  const role = roleSelect.value;
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  log(`(scaffold) would connect as "${role}" to ${wsUrl}`);
  setStatus(`ready to implement signaling (${role})`);
});

log('Frontend scaffold loaded. Implement WebRTC signaling and DataChannel logic here.');
