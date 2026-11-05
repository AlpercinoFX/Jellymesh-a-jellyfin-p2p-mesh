# Jellyfin Private WebRTC P2P Mesh System

A high-performance, 100% private WebRTC P2P mesh network for Jellyfin. It enables viewers watching the same stream to peer-assist video delivery directly between their browsers, dramatically cutting server upstream bandwidth while providing real-time peer telemetry and playback synchronization.

---

## ⚡ Quick Start: 1-Click Operations

| Action | Command / File to Run | What it Does |
| :--- | :--- | :--- |
| **Start Everything (Master)** | `start-all.bat` | **Recommended.** Runs watchdog, starts Tracker daemon (8000), starts Live Mesh Monitor (8001), and runs Caddy reverse proxy. |
| **Start Server & Caddy** | `start-caddy.bat` | Runs self-healer check, ensures Tracker & Monitor are active, and starts Caddy reverse proxy. |
| **Live Mesh Monitor** | `start-monitor.bat` | Opens standalone console for the live browser mesh visualizer on `http://127.0.0.1:8001/`. |
| **Manual Tracker Test** | `start-tracker.bat` | Starts private WebRTC tracker daemon in a console with real-time peer join/leave/switch logging. |
| **Fresh Setup** | `install-p2p.bat` | Auto-detects Jellyfin, installs P2P client engine & UI, injects hooks, configures Windows startup auto-run, and validates Caddy. |
| **After Jellyfin Update** | `update-p2p.bat` | Restores `<script>` hooks into `index.html` and updates client scripts in 1 second. |

---

## 🛡️ Update-Proof Architecture

### Why standard mods break during Jellyfin updates:
When Jellyfin updates, its installer completely replaces `jellyfin-web\index.html` and may clean unversioned scripts inside `jellyfin-web`.

### How this setup makes it 100% update-proof:
1. **Self-Healing Watchdog (`ensure-p2p.ps1`)**:
   - Runs automatically before Caddy starts (`start-all.bat` or `start-caddy.bat`), or manually via `update-p2p.bat`.
   - Scans and locates `jellyfin-web` across any drive letter or folder structure.
   - Checks if `index.html` contains the P2P engine & UI hooks.
   - If missing or outdated, automatically backs up the new `index.html` to `index.html.original` and injects:
     ```html
     <script defer="defer" src="jellyfin-p2p-engine.js?v=TIMESTAMP"></script>
     <script defer="defer" src="jellyfin-p2p-ui.js?v=TIMESTAMP"></script>
     ```
   - Syncs the latest `jellyfin-p2p-engine.js`, `jellyfin-p2p-ui.js`, and `jellyfin-p2p.js` into `jellyfin-web\`.
   - Confirms the private WebRTC tracker daemon on port 8000 is active (auto-launches if stopped).
   - Confirms the live mesh monitor daemon on port 8001 is active (auto-launches if stopped).
2. **Zero Manual Coding Needed**:
   - After updating Jellyfin, you never need to edit code or HTML manually. Just double-click `start-all.bat` or `start-caddy.bat`.

---

## 📦 Package Files Inventory

```
Jellyfin-P2P/
├── caddyfile               # Caddy reverse proxy config (domain -> 8096 + 8000)
├── caddy_windows_amd64.exe # Portable Caddy reverse proxy binary
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
└── README.md               # This documentation
```

---

## 🔧 Core Architectural Components

### 1. Unified Master Launcher (`start-all.bat`)
- Double-clicking **`start-all.bat`** brings up the complete system:
  1. Executes `ensure-p2p.ps1` to sync files and stamp cache-busters.
  2. Ensures the WebRTC Tracker service on `ws://127.0.0.1:8000/tracker` is running.
  3. Ensures the Live Mesh Monitor service on `http://127.0.0.1:8001/` is running.
  4. Runs Caddy reverse proxy in the foreground with live access logs.
- All background processes run quietly without cluttering the screen with multiple CMD windows.

### 2. Live Mesh Monitor (`p2p-monitor.js` & `p2p-monitor.html`)
- Accessible locally at **`http://127.0.0.1:8001/`**.
- **Security**: Bound strictly to `127.0.0.1` and rejected if forwarded by external proxies. Never exposed to the internet.
- **Real-Time Visualizer**:
  - Live SVG directed graph showing active connections and chunk transfer directions between friends.
  - Per-peer live upload and download speed meters.
  - Swarm breakdown displaying who is watching which audio track and bitrate tier.
  - Server offload gauge detailing total data served via P2P vs. HTTP.

### 3. Client Headless Engine (`jellyfin-p2p-engine.js`)
- **Universal Global Lobby**: Peers discover each other in a background lobby channel before media playback even begins.
- **Audio Track & Quality Multi-Swarm Isolation**:
  - Audio and video bitrate limits are encoded into the swarm hash (`|a:<track>|q:<quality>`).
  - Friends watching with identical settings (e.g., German audio, Max quality) seed directly to each other.
  - If a friend selects another language or lower bitrate, they transition to their own video swarm while remaining connected in the lobby for presence and status.
- **Residential Wi-Fi Optimization**:
  - 5-second anti-drop UDP NAT keepalives keep consumer router states open.
  - Optimized chunk pipelining for 15–50 Mbps upload speeds and residential 55 Mbps server connections.

### 4. Client Matrix HUD (`jellyfin-p2p-ui.js`)
- **Decoupled Architecture**: Clean event listener and renderer that never interferes with media playback.
- **64-Cube Dynamic Buffer Matrix**: In-place DOM diffing with zero frame drops during video playback.
- **Live Swarm Indicators**:
  - **● In Your Swarm** (Emerald neon glow): Actively sharing video segments.
  - **● Other Swarm** (Amber neon glow): Friend is watching on another audio track or resolution.
- **Peer Pills**: Display friend's real username, browser, audio track, bitrate, and ping RTT.
- **Electric Pink (`#ff007f`) Playhead Ripple**: Pulsing indicator on the active playing chunk.
- **Smart Non-Seeding Detection**: Automatically warns if peers in *your* swarm fail to seed (VPN, adblocker), without falsely warning about friends in other swarms.

### 5. Private WebRTC Tracker (`p2p-tracker.js`)
- **Zero Dependencies**: Pure Node.js standard libraries (`http`, `crypto`) listening on port `8000`.
- **Informative CLI Logging**:
  - `[Tracker] Peer Alice (Chrome) [Track #1 • Max] joined swarm 7c89f21b (Active: 3)`
  - `[Tracker] Peer Bob (Edge) switched swarm: [Track #1 • Max] -> [Track #2 • 8 Mbps]`
  - `[Tracker] Peer Charlie (Firefox) [Track #1 • Max] left swarm 7c89f21b (Active: 2)`
- **Telemetry API**: Exposes JSON stats at `http://127.0.0.1:8000/telemetry`.

---

## 🔍 Diagnostics & Verification

- **Live Mesh Visualizer**: Open `http://127.0.0.1:8001/` in your browser.
- **Tracker Telemetry**: Open `http://127.0.0.1:8000/telemetry` to inspect raw JSON swarm data.
- **Browser Client HUD**: Click the network icon (🖧) in the Jellyfin top bar or video OSD controls.
