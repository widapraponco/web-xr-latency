# webxr-webrtc-latency-benchmark

## 1. Overview & Motivation

Cloud XR and edge-assisted immersive simulations offload scene rendering, physics, and authoritative state generation from resource-constrained clients (e.g., head-mounted displays and mobile devices) to nearby edge servers. While this paradigm enables richer real-time experiences, it introduces a stringent **motion-to-photon (MTP)** latency budget: delays and variability between user or scene motion and the corresponding visual update can degrade interaction fidelity, reduce perceived stability, and negatively affect user comfort in immersive environments.

This repository provides a lightweight, reproducible research prototype for evaluating **real-time 3D state synchronization** over **WebRTC DataChannels**. It models an edge host streaming authoritative object pose updates to a remote viewer and exposes transport/mitigation trade-offs (unreliable delivery versus client-side buffering and interpolation) through built-in network telemetry and CSV logging for experimental analysis.

## 2. System Architecture

The prototype comprises an edge simulation host, a browser-based client viewer, and a minimal WebSocket signaling server. After signaling (SDP/ICE exchange), pose updates are transmitted peer-to-peer over an unreliable WebRTC DataChannel. The client can render updates immediately (raw mode) or through a jitter buffer with linear interpolation (interpolated mode).

```text
                         +--------------------------------------+
                         |       WebSocket Signaling Server     |
                         |               (server.js)            |
                         |       Express (HTTP / static)        |
                         |   ws relay: register, offer/answer,  |
                         |          ICE candidates, ready       |
                         +------------------+-------------------+
                                      ^               ^
                          register /  |               |  register /
                        SDP, ICE,     |               |  SDP, ICE,
                          ready       |               |  ready
                                      v               v
+----------------------------------------+     +-------------------------------------------+
|               Edge Host                |     |                   Client                  |
|       (public/host.html, host.js)      |     |        (public/client.html, client.js)    |
|                                        |     |                                           |
|  [Three.js Simulation @ ~60 Hz]        |     |  [Telemetry HUD & Recorder]               |
|   - Figure-eight / manual control      |     |   - RTT / one-way latency (est.)          |
|   - Authoritative cube pose            |     |   - Inter-arrival jitter (σ)              |
|   - Ping responder (RTT echo)          |     |   - Packet loss via seq gaps (rolling)    |
|                                        |     |   - Render FPS / receive rate             |
|  State: {seq, timestamp,               |     |   - CSV export (last 30 s)                |
|    position:[x,y,z], rotation:[x,y,z]} |     |                                           |
+--------------------+-------------------+     |  [Client Jitter Buffer (50 ms)]           |
                     |                         |      +-------------------------------+    |
                     |  WebRTC PeerConnection  |      | Raw: snap to latest sample    |    |
                     +========================>|      | Interpolated: lerp between    |    |
                       Unreliable DataChannel  |      | buffered samples (smooth)     |    |
                       label: "state"          |      +---------------+---------------+    |
                       ordered: false          |                      |                    |
                       maxRetransmits: 0       |          [Three.js Rendered Cube]         |
                                               +-------------------------------------------+
```

## 3. Key Technical Features

- **Unreliable, low-latency transport:** The host creates the state DataChannel with `ordered: false` and `maxRetransmits: 0` to avoid head-of-line blocking, prioritizing timeliness over guaranteed delivery for continuous pose updates. The client uses monotonic sequence numbers (`seq`) to discard stale/out-of-order samples.
- **Client-side mitigation modes:**
  - *Raw mode:* applies the latest received pose immediately, exposing visible stutter/jumps under jitter and loss.
  - *Interpolated mode:* maintains a 50 ms jitter buffer and renders via linear interpolation (`THREE.Vector3.lerpVectors` for position and per-axis rotation interpolation) to improve visual smoothness under network perturbations.
- **Real-time telemetry HUD:** displays RTT (DataChannel ping-pong), one-way latency estimate, inter-arrival jitter, packet loss (%), receive rate, sequence number, and render FPS.
- **CSV telemetry logging:** exports the last 30 seconds of recorded samples (time, mode, RTT/one-way estimate, jitter, packet loss, FPS, receive rate, last sequence) for offline analysis and benchmarking.
- **Deterministic host simulation:** authoritative 60 Hz state stream with automatic figure-eight motion and a manual control toggle (`M`, arrow keys) to support repeatable experiments.

## 4. How to Run & Reproduce Experiments

### Prerequisites
- Node.js **>= 18**
- A modern browser with WebRTC and WebGL support (e.g., recent Chrome/Edge/Firefox)
- Two browser contexts (tabs/windows or devices) with access to the signaling server

### Setup and execution
1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Start the signaling/static server**
   ```bash
   npm start
   ```
   For auto-restart during development (Node >= 18.11): `npm run dev`.
3. **Open the roles**
   - Host (edge simulation server): `http://localhost:3000/host.html`
   - Client (viewer): `http://localhost:3000/client.html`
4. **Run a session**
   - Both pages auto-register and auto-negotiate the WebRTC connection.
   - **Host controls:** `M` toggles Auto/Manual motion; arrow keys move the cube in Manual mode.
   - **Client controls:** toggle **Raw / Interpolated** rendering and click **Download Benchmark CSV** to export the last 30 s of telemetry.
5. **Verify transport configuration (optional)**
   - In browser DevTools/WebRTC internals, confirm the `state` DataChannel reports `ordered: false` and `maxRetransmits: 0`.

### Simulating packet loss and latency
Browser DevTools HTTP throttling generally does **not** affect WebRTC (UDP/DataChannel) traffic. To reproduce impaired network conditions, apply impairment at the OS/network layer on the relevant interface/path between peers:

- **Linux (`tc/netem`)** (example: 60 ms delay, ±20 ms jitter, 2% loss):
  ```bash
  sudo tc qdisc add dev <iface> root netem delay 60ms 20ms distribution normal loss 2%
  # remove impairment
  sudo tc qdisc del dev <iface> root netem
  ```
  Use `<iface>` such as `lo` (localhost testing) or the active network interface (separate machines).
- **Windows:** use a packet-shaping tool such as [clumsy](https://jagt.github.io/clumsy/) to add lag, jitter, and packet drop to relevant UDP traffic.
- **macOS:** use **Network Link Conditioner** (Additional Tools for Xcode) to apply bandwidth/delay/loss profiles.

For realistic measurements, run host and client on separate devices over the target network (LAN/Wi-Fi/edge link). The prototype uses STUN-only ICE by default; restrictive NATs may require adding a TURN server for connectivity (not included).

## 5. Sample Benchmark Results

Use the table below to record experimental results (e.g., derived from client CSV exports). Fill in measured values for your test conditions.

| Network Condition | Transport Mode | Mean Latency (ms) | Jitter (ms) | Packet Loss (%) | Visual Smoothness |
|---|---|---:|---:|---:|---|
| Baseline (LAN, no impairment) | Raw |  |  |  |  |
| Baseline (LAN, no impairment) | Interpolated (50 ms buffer) |  |  |  |  |
| 50 ms delay, 10 ms jitter | Raw |  |  |  |  |
| 50 ms delay, 10 ms jitter | Interpolated (50 ms buffer) |  |  |  |  |
| 60 ms delay, 20 ms jitter, 2% loss | Raw |  |  |  |  |
| 60 ms delay, 20 ms jitter, 2% loss | Interpolated (50 ms buffer) |  |  |  |  |

*Reporting suggestions:* specify whether "Mean Latency" is RTT or one-way estimate, define the jitter metric (e.g., inter-arrival σ), state sample duration/window, and use a consistent rubric for "Visual Smoothness" (e.g., a 1–5 scale or qualitative labels).

## Repository Structure

```text
.
├─ server.js               # Express static hosting + WebSocket signaling relay
├─ package.json
└─ public/
   ├─ index.html           # Landing page
   ├─ host.html            # Edge simulation host UI
   ├─ client.html          # Viewer UI + telemetry/mitigation controls
   ├─ css/style.css
   └─ js/
      ├─ common.js         # Signaling and WebRTC helpers
      ├─ scene.js          # Three.js scene and host simulation
      ├─ host.js           # Host logic (60 Hz state send, ping responder)
      └─ client.js         # Client logic (telemetry, jitter buffer, CSV export)
```

## Notes and Limitations

- This is a **single host–client** research prototype intended for controlled benchmarking, not a production synchronization framework.
- One-way latency reported in the HUD is an estimate derived from RTT (clock offset between peers is not assumed).
- Packet loss is inferred from sequence-number gaps over received samples; with unordered/unreliable delivery, late arrivals beyond sequence progression are treated as stale drops.
- WebXR device deployment and cross-network operation may require a secure context (HTTPS/localhost) and TURN infrastructure in addition to STUN.
