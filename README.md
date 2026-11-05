# Jellyfin Private WebRTC P2P Mesh System

A high-performance, 100% private WebRTC P2P mesh network for Jellyfin. It enables viewers watching the same stream to peer-assist video delivery directly between their browsers, dramatically cutting server upstream bandwidth while providing real-time peer telemetry and playback synchronization.

### 💡 Motivation
> Why build this? In short: I wanted to stream high-bitrate movies in maximum quality with a group of friends simultaneously. On a standard residential internet connection, the upstream bandwidth quickly saturates when multiple people stream directly from the home server at once. 
> 
> By enabling viewers to seed and exchange the video chunks they have already buffered with each other over WebRTC, the server bandwidth bottleneck is eliminated. Instead of degrading quality with aggressive transcoding, the stream actually becomes faster and more resilient as more friends join.

---

## ⚡ Quick Start

| Action | Command / File to Run | Description |
| :--- | :--- | :--- |
| **Start Everything (Master)** | `start-all.bat` | Runs watchdog check, starts Tracker daemon (8000), starts Live Mesh Monitor (8001), and launches Caddy reverse proxy. |
| **Start Server & Caddy** | `start-caddy.bat` | Runs watchdog check, ensures Tracker & Monitor are active, and starts Caddy reverse proxy. |
| **Live Mesh Monitor** | `start-monitor.bat` | Opens the standalone console for the live browser mesh visualizer on `http://127.0.0.1:8001/`. |
| **Manual Tracker Test** | `start-tracker.bat` | Starts private WebRTC tracker daemon in a console with real-time peer join/leave/switch logging. |
| **Fresh Setup** | `install-p2p.bat` | Auto-detects Jellyfin, installs P2P client engine & UI, injects hooks, configures Windows startup auto-run, and validates Caddy. |
| **After Jellyfin Update** | `update-p2p.bat` | Restores `<script>` hooks into `index.html` and synchronizes client scripts in 1 second. |

---

## 🛡️ Update-Proof Mechanism

When Jellyfin updates its server, the installer routinely overwrites `jellyfin-web\index.html` with stock files.

To keep this modification persistent:
* **Automatic Hook Injection (`ensure-p2p.ps1`)**: Every time `start-all.bat` or `start-caddy.bat` is launched (or manually via `update-p2p.bat`), a lightweight script scans for the `jellyfin-web` directory.
* If `index.html` does not contain the P2P script tags, it automatically backs up the file to `index.html.original` and injects:
  ```html
  <script defer="defer" src="jellyfin-p2p-engine.js?v=TIMESTAMP"></script>
  <script defer="defer" src="jellyfin-p2p-ui.js?v=TIMESTAMP"></script>
  ```
* It synchronizes the latest client engine and UI files into `jellyfin-web\`, so no manual editing or reinstalling is needed after server upgrades.

---

## 📦 Package Files Inventory

```
Jellyfin-P2P/
├── caddyfile               # Caddy reverse proxy config (domain -> 8096 + 8000)
├── caddy_windows_amd64.exe # (Not included in repo - tested with Caddy v2.11.7)
├── ensure-p2p.ps1          # Self-healing watchdog & background daemon supervisor
├── install-p2p.bat         # 1-Click launcher for install-p2p.ps1
├── install-p2p.ps1         # Full automated installer & system validator
├── jellyfin-p2p-engine.js  # Headless P2P networking core (Lobby, WebTorrent, PEX, NAT keepalive)
├── jellyfin-p2p-ui.js      # Decoupled matrix UI, glowing status pills & 64-cube DOM diffing
├── jellyfin-p2p.js         # Unified bundle fallback (Engine + UI)
├── p2p-monitor.html        # Interactive live browser mesh visualizer & topology graph
├── p2p-monitor.js          # Standalone localhost monitor server (Port 8001)
├── p2p-tracker.js          # Pure Node.js private WebRTC signaling tracker daemon (Port 8000)
├── start-all.bat           # Master 1-click launcher for the entire stack
├── start-caddy.bat         # Starts watchdog + Caddy reverse proxy
├── start-monitor.bat       # Standalone launcher for Live Mesh Monitor (Port 8001)
├── start-tracker.bat       # Standalone launcher for private tracker daemon (Port 8000)
├── update-p2p.bat          # 1-Click fast update & repair script
├── screenshots/            # UI & mesh monitor screenshots
└── README.md               # Documentation
```
> **Note on Caddy**: `caddy_windows_amd64.exe` is excluded from the source tree due to file size limits. You can obtain it directly via `winget install CaddyServer.Caddy` or from [caddyserver.com](https://caddyserver.com/download) (tested with **v2.11.7**).

---

## 🔧 Core Components & Architecture

### 1. Unified Master Launcher (`start-all.bat`)
* Automatically coordinates the entire stack:
  1. Executes `ensure-p2p.ps1` to verify files and update cache-busters.
  2. Ensures the WebRTC Tracker service on `ws://127.0.0.1:8000/tracker` is running in the background.
  3. Ensures the Live Mesh Monitor service on `http://127.0.0.1:8001/` is running in the background.
  4. Runs the Caddy reverse proxy in the foreground with live access logs.

> [!IMPORTANT]
> **Server Host Network Best Practice (Localhost / LAN Access)**:
> The host / server owner should always access Jellyfin via `localhost` (e.g., `http://localhost:8096`) or their local home network IP (e.g., `http://192.168.x.x:8096`), rather than connecting through the public external domain.
> 
> **Why this matters:** The host machine *is* the media server. If the server owner enters the P2P swarm through the external domain as a regular peer, their browser attempts to WebRTC-seed video chunks back out to friends over their home connection. This unnecessarily burns the home network's residential upstream bandwidth—which should instead be reserved exclusively for the Jellyfin server itself. Connecting locally ensures the host streams over pure local loopback without competing with the server's external uplink.

> [!NOTE]
> **Known Issue & Workaround (Simultaneous Group Playback Start)**:
> If all viewers attempt to start playback at the exact same second while already in a SyncPlay session, an initial race condition can cause Jellyfin to display a *"no compatible stream found"* error.
> 
> **Workaround:** Start the SyncPlay session with 1–2 viewers first. Once the initial stream buffer has loaded, have the remaining friends join one by one.

### 2. Live Mesh Monitor (`p2p-monitor.js` & `p2p-monitor.html`)
* **Local Access Only**: Hosted at `http://127.0.0.1:8001/`. Bound strictly to loopback and never exposed via Caddy.
* **Real-Time Visualizer**:
  * Live SVG directed graph mapping active connections and real-time chunk transfer directions between friends.
  * Real-time upload and download throughput meters per peer.
  * Swarm breakdown displaying who is watching which audio track and bitrate tier.
  * Live server offload gauge detailing bandwidth served via P2P vs. HTTP.

### 3. Client Headless Engine (`jellyfin-p2p-engine.js`)
* **Lobby Discovery**: Peers discover each other in a background channel before media playback begins.
* **Audio Track & Quality Multi-Swarm Isolation**:
  * Audio tracks and bitrate limits are hashed into distinct swarm channels (`|a:<track>|q:<quality>`).
  * Viewers watching with identical settings seed directly to one another.
  * Switching audio language or resolution automatically moves the viewer to their matching swarm while maintaining lobby connection.
* **Residential Connection Optimization**:
  * 5-second UDP keepalives prevent consumer NAT routers from dropping WebRTC state.
  * Tuned chunk request windows optimized for home broadband uplinks.

### 4. Client Matrix HUD (`jellyfin-p2p-ui.js`)
* **In-Player Overlay**: Accessible via the network icon (🖧) on the player bar.
* **64-Cube Dynamic Buffer Matrix**: Visualizes active chunk states (P2P vs. HTTP server chunks) using in-place DOM diffing to prevent playback stutter.
* **Electric Pink Playhead (`#ff007f`)**: Real-time indicator highlighting the chunk currently being rendered.
* **Peer Information**: Shows connected friends, browser platform, active audio/video stream parameters, and round-trip ping latency.

### 5. Private WebRTC Tracker (`p2p-tracker.js`)
* **Zero Dependencies**: Pure Node.js built-ins (`http`, `crypto`) listening on port `8000`.
* **Real-Time Swarm Logging**:
  * `[Tracker] Peer Alice (Chrome) [Track #1 • Max] joined swarm 7c89f21b (Active: 3)`
  * `[Tracker] Peer Bob (Edge) switched swarm: [Track #1 • Max] -> [Track #2 • 8 Mbps]`
  * `[Tracker] Peer Charlie (Firefox) [Track #1 • Max] left swarm 7c89f21b (Active: 2)`
* **Telemetry API**: Exposes JSON stats locally at `http://127.0.0.1:8000/telemetry`.

---

## 🔍 Verification & Diagnostics

* **Live Mesh Visualizer**: Navigate to `http://127.0.0.1:8001/` in your browser.
* **Tracker Telemetry**: Visit `http://127.0.0.1:8000/telemetry` to inspect raw swarm statistics.
* **Browser Client HUD**: Click the network icon (🖧) in the Jellyfin top bar or video controls overlay.
