/**
 * Jellyfin WebRTC P2P Mesh UI Component
 * Version: 2.3.0-quality-and-audio-swarms
 * 
 * Features:
 * - Completely decoupled from networking engine (pure listener/renderer)
 * - Rock-solid button injection into .headerLeft & .videoOsd-appBar with SVG icon & pulse dot
 * - Persistent 64-cube DOM diffing (zero stutter / framerate glitch)
 * - Single neon-pink playhead dot ONLY on active playing chunk
 * - 100% Deduplicated Peer Management: merges dual-sockets (Lobby + HLS) into single friend identities
 * - Eliminates double name/hash labels: clean display of "User1 (Edge)", "User2 (Chrome)", etc.
 * - Live Swarm Indicators: "🟢 In Your Swarm" vs "🟡 Other Swarm" badges
 * - Playback Quality & Audio Track labels next to every friend
 * - Header badges: "Audio: Track #X" and "Quality: Max / 8 Mbps"
 * - Restored Warning / Disclaimer box with live non-seeding peer detection & multi-swarm awareness
 * - Wi-Fi RTT ping & browser identity (Edge, Chrome, etc.)
 */

(function (global) {
    "use strict";

    if (global.__JellyfinP2PUILoaded) return;
    global.__JellyfinP2PUILoaded = true;

    const MATRIX_SIZE = 64; // 16 columns x 4 rows
    let modalEl = null;
    let gridEl = null;
    let cubesCache = [];
    let selectedChunkIndex = null;
    let renderScheduled = false;

    const PEER_PALETTES = [
        { name: "Emerald", bg: "#059669", fg: "#ffffff", border: "#10b981", textCls: "#34d399" },
        { name: "Cyan",    bg: "#0891b2", fg: "#ffffff", border: "#06b6d4", textCls: "#22d3ee" },
        { name: "Violet",  bg: "#7c3aed", fg: "#ffffff", border: "#8b5cf6", textCls: "#a78bfa" },
        { name: "Amber",   bg: "#d97706", fg: "#ffffff", border: "#f59e0b", textCls: "#fbbf24" },
        { name: "Rose",    bg: "#e11d48", fg: "#ffffff", border: "#f43f5e", textCls: "#fb7185" },
        { name: "Indigo",  bg: "#4f46e5", fg: "#ffffff", border: "#6366f1", textCls: "#818cf8" },
        { name: "Teal",    bg: "#0d9488", fg: "#ffffff", border: "#14b8a6", textCls: "#2dd4bf" },
        { name: "Fuchsia", bg: "#c026d3", fg: "#ffffff", border: "#d946ef", textCls: "#e879f9" }
    ];

    const peerColorMap = new Map();
    function getPeerPalette(identifier) {
        const key = String(identifier || "unknown").toLowerCase();
        if (!peerColorMap.has(key)) {
            const idx = peerColorMap.size % PEER_PALETTES.length;
            peerColorMap.set(key, PEER_PALETTES[idx]);
        }
        return peerColorMap.get(key);
    }

    // -------------------------------------------------------------------------
    // Formatters & Swarm Matching Helpers
    // -------------------------------------------------------------------------
    function formatAudio(track) {
        if (track === null || track === undefined || track === "" || track === "def") return "Track #0";
        const s = String(track).trim();
        if (s.toLowerCase().startsWith("track")) return s;
        return `Track #${s}`;
    }

    function formatQuality(q) {
        if (!q || q === "max" || q === "MAX" || q === "auto" || q === "140000k") return "Max";
        const s = String(q).toLowerCase();
        if (s.endsWith("m")) {
            return `${s.slice(0, -1).toUpperCase()} Mbps`;
        }
        if (s.endsWith("k")) {
            const kbps = parseInt(s, 10);
            if (!isNaN(kbps)) {
                if (kbps >= 1000) {
                    const mbps = (kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1);
                    return `${mbps} Mbps`;
                }
                return `${kbps} kbps`;
            }
        }
        return String(q);
    }

    function isPeerInMySwarm(p, stats) {
        if (!p || !p.connected) return false;

        // 1. Direct transfer check: If they downloaded chunks from us or we downloaded from them, they are in our swarm!
        if ((p.segmentsFrom && p.segmentsFrom > 0) || (p.bytesFrom && p.bytesFrom > 0) || (p.bytesTo && p.bytesTo > 0)) {
            return true;
        }

        // 2. Direct HLS WebTorrent mesh connection
        if (p.inHlsSwarm) {
            return true;
        }

        // 3. Audio track comparison
        const myAudio = stats.currentAudioTrack !== null && stats.currentAudioTrack !== undefined && stats.currentAudioTrack !== "" && stats.currentAudioTrack !== "def" 
            ? String(stats.currentAudioTrack) : "0";
        const peerAudio = p.audioTrack !== null && p.audioTrack !== undefined && p.audioTrack !== "" && p.audioTrack !== "def" 
            ? String(p.audioTrack) : "0";

        if (peerAudio !== myAudio) {
            return false;
        }

        // 4. Video quality comparison
        const myQuality = (stats.currentQuality || "max").toLowerCase();
        const peerQuality = (p.quality || "max").toLowerCase();

        if (peerQuality !== myQuality) {
            return false;
        }

        // 5. If watching a different movie item
        if (p.currentMovieItemId && stats.currentMovieItemId && p.currentMovieItemId !== stats.currentMovieItemId) {
            return false;
        }

        // 6. If explicit swarm IDs are provided and both start with 'jellyfin-'
        if (p.currentSwarmId && stats.currentSwarmId && 
            p.currentSwarmId.startsWith("jellyfin-") && stats.currentSwarmId.startsWith("jellyfin-") && 
            p.currentSwarmId !== stats.currentSwarmId) {
            return false;
        }

        // Audio & quality match and peer is connected -> in your swarm!
        return true;
    }

    // -------------------------------------------------------------------------
    // Peer Deduplication & Aggregation
    // -------------------------------------------------------------------------
    function getCleanPeers(engine) {
        if (!engine) return [];
        const rawPeers = engine.getPeers() || [];
        const localId = engine.getLocalIdentity?.() || {};
        const myPeerId = localId.peerId;
        const myName = (localId.userName || "").toLowerCase().trim();

        // Key: Normalized username (if real name) OR raw peerId (if unnamed)
        const merged = new Map();

        for (const p of rawPeers) {
            if (!p || !p.peerId) continue;
            // 0. Skip transient dummy sideband IDs
            if (p.peerId.startsWith("peer-")) continue;
            // 1. Never list ourselves as our own remote friend
            if (myPeerId && p.peerId === myPeerId) continue;
            const peerName = (p.userName || "").trim();
            if (myName && peerName && peerName.toLowerCase() === myName) continue;

            const isNamed = Boolean(peerName && 
                !peerName.startsWith("Peer ") && 
                !peerName.startsWith("Peer-") && 
                !peerName.startsWith("Peer ["));

            const key = isNamed ? peerName.toLowerCase() : p.peerId;

            if (!merged.has(key)) {
                merged.set(key, {
                    peerId: p.peerId,
                    peerIds: new Set([p.peerId]),
                    shortId: p.shortId || p.peerId.slice(-4),
                    userName: isNamed ? peerName : null,
                    browser: p.browser || null,
                    audioTrack: p.audioTrack !== undefined ? p.audioTrack : null,
                    quality: p.quality || null,
                    currentMovieItemId: p.currentMovieItemId || null,
                    currentSwarmId: p.currentSwarmId || null,
                    inHlsSwarm: Boolean(p.inHlsSwarm),
                    connected: Boolean(p.connected),
                    rttMs: p.rttMs,
                    bytesFrom: p.bytesFrom || 0,
                    bytesTo: p.bytesTo || 0,
                    segmentsFrom: p.segmentsFrom || 0,
                    isNamed: isNamed
                });
            } else {
                const item = merged.get(key);
                item.peerIds.add(p.peerId);
                item.bytesFrom += (p.bytesFrom || 0);
                item.bytesTo += (p.bytesTo || 0);
                item.segmentsFrom += (p.segmentsFrom || 0);
                if (p.connected) item.connected = true;
                if (p.rttMs !== null) {
                    item.rttMs = item.rttMs === null ? p.rttMs : Math.min(item.rttMs, p.rttMs);
                }
                if (p.browser && !item.browser) item.browser = p.browser;
                if (p.audioTrack !== null && p.audioTrack !== undefined) item.audioTrack = p.audioTrack;
                if (p.quality) item.quality = p.quality;
                if (p.currentMovieItemId) item.currentMovieItemId = p.currentMovieItemId;
                if (p.currentSwarmId) item.currentSwarmId = p.currentSwarmId;
                if (p.inHlsSwarm) item.inHlsSwarm = true;
                if (!item.userName && isNamed) {
                    item.userName = peerName;
                    item.isNamed = true;
                }
            }
        }

        const namedList = [];
        const unnamedList = [];
        for (const item of merged.values()) {
            if (item.isNamed) {
                namedList.push(item);
            } else if (item.connected || item.bytesFrom > 0 || item.bytesTo > 0) {
                unnamedList.push(item);
            }
        }

        // Reconcile: If an unnamed peer has activity and a named peer has 0 MB, merge them
        if (namedList.length > 0 && unnamedList.length > 0) {
            for (let i = unnamedList.length - 1; i >= 0; i--) {
                const un = unnamedList[i];
                let target = namedList.find((n) => n.shortId === un.shortId || (un.peerId && n.peerIds.has(un.peerId)));
                if (!target && namedList.length === 1 && unnamedList.length === 1) {
                    target = namedList[0];
                }
                if (!target && namedList.filter(n => n.bytesFrom === 0 && n.bytesTo === 0).length === 1) {
                    target = namedList.find(n => n.bytesFrom === 0 && n.bytesTo === 0);
                }
                if (target) {
                    target.bytesFrom += un.bytesFrom;
                    target.bytesTo += un.bytesTo;
                    target.segmentsFrom += un.segmentsFrom;
                    if (un.connected) target.connected = true;
                    if (un.rttMs !== null) target.rttMs = un.rttMs;
                    if (!target.browser && un.browser) target.browser = un.browser;
                    if (target.audioTrack === null && un.audioTrack !== null) target.audioTrack = un.audioTrack;
                    if (!target.quality && un.quality) target.quality = un.quality;
                    if (!target.currentMovieItemId && un.currentMovieItemId) target.currentMovieItemId = un.currentMovieItemId;
                    if (!target.currentSwarmId && un.currentSwarmId) target.currentSwarmId = un.currentSwarmId;
                    if (un.inHlsSwarm) target.inHlsSwarm = true;
                    un.peerIds.forEach(id => target.peerIds.add(id));
                    unnamedList.splice(i, 1);
                }
            }
        }

        return [...namedList, ...unnamedList];
    }

    // -------------------------------------------------------------------------
    // Stylesheet Injection
    // -------------------------------------------------------------------------
    function injectStyles() {
        if (document.getElementById("jf-p2p-styles")) return;
        const style = document.createElement("style");
        style.id = "jf-p2p-styles";
        style.textContent = `
            .headerP2PButton {
                position: relative !important;
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 2.5em !important;
                height: 2.5em !important;
                min-width: 2.5em !important;
                min-height: 2.5em !important;
                padding: 0 !important;
                margin: 0 4px !important;
                background: transparent !important;
                border: none !important;
                border-radius: 50% !important;
                color: rgba(255, 255, 255, 0.85) !important;
                cursor: pointer !important;
                outline: none !important;
                z-index: 100 !important;
                vertical-align: middle !important;
                pointer-events: all !important;
                flex-shrink: 0 !important;
                transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease !important;
            }
            .headerP2PButton:hover {
                background: rgba(255, 255, 255, 0.14) !important;
                color: #ffffff !important;
                transform: scale(1.08);
            }
            .osdHeader .headerP2PButton {
                display: inline-flex !important;
                visibility: visible !important;
                opacity: 1 !important;
            }
            .jf-p2p-dot {
                position: absolute;
                top: 5px;
                right: 5px;
                width: 8px;
                height: 8px;
                border-radius: 999px;
                background: #10b981;
                box-shadow: 0 0 6px #10b981;
                pointer-events: none;
            }

            /* Modal Backdrop & Card */
            .jf-p2p-modal-backdrop {
                position: fixed;
                top: 56px;
                left: 14px;
                z-index: 999999;
                width: min(660px, calc(100vw - 28px));
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                color: #f4f4f5;
                user-select: none;
                display: none;
            }
            .jf-p2p-modal-backdrop.open {
                display: block;
                animation: jfP2pFadeIn 0.16s ease-out;
            }
            @keyframes jfP2pFadeIn {
                from { opacity: 0; transform: translateY(-8px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .jf-p2p-modal {
                background: rgba(18, 18, 22, 0.96);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 16px;
                padding: 16px;
                box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
                backdrop-filter: blur(14px);
            }
            .jf-p2p-modal-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                padding-bottom: 10px;
                margin-bottom: 10px;
            }
            .jf-p2p-badge-mesh {
                background: rgba(0, 220, 130, 0.15);
                color: #00dc82;
                border: 1px solid rgba(0, 220, 130, 0.3);
                padding: 2px 8px;
                border-radius: 999px;
                font-size: 0.72rem;
                font-weight: 600;
                margin-left: 8px;
            }
            .jf-p2p-badge-audio {
                background: rgba(56, 189, 248, 0.15);
                color: #38bdf8;
                border: 1px solid rgba(56, 189, 248, 0.3);
                padding: 2px 8px;
                border-radius: 999px;
                font-size: 0.72rem;
                font-weight: 600;
                margin-left: 6px;
                display: none;
            }
            .jf-p2p-badge-quality {
                background: rgba(168, 85, 247, 0.15);
                color: #c084fc;
                border: 1px solid rgba(168, 85, 247, 0.35);
                padding: 2px 8px;
                border-radius: 999px;
                font-size: 0.72rem;
                font-weight: 600;
                margin-left: 6px;
                display: none;
            }
            .jf-p2p-close-btn {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.14);
                color: #e4e4e7;
                border-radius: 8px;
                padding: 3px 9px;
                font-size: 0.85rem;
                cursor: pointer;
            }
            .jf-p2p-close-btn:hover {
                background: rgba(255, 255, 255, 0.18);
                color: #fff;
            }

            /* Legend */
            .jf-p2p-legend {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 12px;
                padding: 8px 12px;
                border-radius: 10px;
                background: rgba(9, 9, 11, 0.65);
                border: 1px solid rgba(255, 255, 255, 0.09);
                margin-bottom: 10px;
                font-size: 0.78rem;
            }
            .jf-p2p-legend-item {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                color: #d4d4d8;
                font-weight: 500;
            }
            .jf-p2p-mini-cube {
                width: 18px;
                height: 18px;
                border-radius: 4px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-weight: 800;
                font-size: 10px;
                line-height: 1;
            }

            /* 64-cube Grid */
            .jf-p2p-grid-meta {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 0.76rem;
                color: #a1a1aa;
                margin-bottom: 6px;
                padding: 0 2px;
            }
            .jf-p2p-grid-box {
                padding: 10px;
                border-radius: 12px;
                background: rgba(9, 9, 11, 0.88);
                border: 1px solid rgba(255, 255, 255, 0.11);
                width: 100%;
                box-sizing: border-box;
            }
            .jf-p2p-grid {
                display: grid;
                grid-template-columns: repeat(16, minmax(0, 1fr));
                gap: 5px;
                width: 100%;
            }
            @media (max-width: 540px) {
                .jf-p2p-grid {
                    grid-template-columns: repeat(12, minmax(0, 1fr));
                }
            }
            .jf-p2p-cube {
                width: 100%;
                aspect-ratio: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 800;
                font-size: 12px;
                line-height: 1;
                border-radius: 4px;
                cursor: pointer;
                position: relative;
                box-sizing: border-box;
                transition: transform 0.12s ease;
                user-select: none;
            }
            .jf-p2p-cube:hover {
                transform: scale(1.22);
                z-index: 40;
                box-shadow: 0 0 12px rgba(255, 255, 255, 0.45);
            }
            .jf-p2p-cube-pending {
                background: rgba(255, 255, 255, 0.04);
                border: 1px dashed rgba(255, 255, 255, 0.22);
                color: transparent;
            }
            .jf-p2p-cube-http {
                background: #ffffff;
                color: #09090b;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
            }
            .jf-p2p-cube-p2p {
                background: #00dc82;
                color: #052e16;
                border: 1px solid #4ade80;
                box-shadow: 0 0 8px rgba(0, 220, 130, 0.35);
            }

            /* Single Neon-Pink Playhead Dot ONLY on Active Chunk */
            @keyframes jfP2pPing {
                0% {
                    box-shadow: 0 0 0 0 rgba(255, 0, 127, 0.9), inset 0 0 6px rgba(255, 255, 255, 0.7);
                    outline: 2px solid #ff007f;
                }
                50% {
                    box-shadow: 0 0 0 8px rgba(255, 0, 127, 0), inset 0 0 10px rgba(255, 0, 127, 0.5);
                    outline: 2px solid #ff2a85;
                }
                100% {
                    box-shadow: 0 0 0 0 rgba(255, 0, 127, 0), inset 0 0 6px rgba(255, 255, 255, 0.7);
                    outline: 2px solid #ff007f;
                }
            }
            .jf-p2p-playhead-badge {
                position: absolute !important;
                top: -4px !important;
                right: -4px !important;
                width: 14px !important;
                height: 14px !important;
                background: #ff007f !important;
                border: 1.5px solid #ffffff !important;
                border-radius: 999px !important;
                display: none !important;
                align-items: center !important;
                justify-content: center !important;
                font-size: 7px !important;
                color: #ffffff !important;
                font-weight: 900 !important;
                box-shadow: 0 0 8px rgba(255, 0, 127, 0.9) !important;
                pointer-events: none !important;
                z-index: 35 !important;
                line-height: 1 !important;
            }
            .jf-p2p-cube-playing {
                animation: jfP2pPing 1.35s infinite cubic-bezier(0.25, 1, 0.5, 1) !important;
                z-index: 30 !important;
                position: relative !important;
            }
            .jf-p2p-cube-playing .jf-p2p-playhead-badge {
                display: flex !important;
            }
            .jf-p2p-cube-playing .jf-p2p-playhead-badge::after {
                content: "";
                width: 0;
                height: 0;
                border-top: 3px solid transparent;
                border-bottom: 3px solid transparent;
                border-left: 5px solid #fff;
                margin-left: 1px;
            }

            /* Detail Card & Friends */
            .jf-p2p-detail {
                margin-top: 10px;
                padding: 9px 12px;
                border-radius: 10px;
                background: rgba(9, 9, 11, 0.72);
                border: 1px solid rgba(255, 255, 255, 0.1);
                font-size: 0.78rem;
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .jf-p2p-friends-box {
                margin-top: 10px;
                padding: 10px 12px;
                border-radius: 10px;
                background: rgba(9, 9, 11, 0.65);
                border: 1px solid rgba(255, 255, 255, 0.09);
                font-size: 0.78rem;
            }
            .jf-p2p-peers-list {
                display: flex;
                flex-wrap: wrap;
                gap: 7px;
                margin-top: 6px;
            }
            .jf-p2p-peer-pill {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 999px;
                padding: 4px 10px;
                font-size: 0.74rem;
                display: inline-flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            .jf-p2p-peer-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                flex-shrink: 0;
            }
            .jf-p2p-peer-meta {
                color: #cbd5e1;
                font-size: 0.7rem;
                background: rgba(255, 255, 255, 0.06);
                padding: 1px 6px;
                border-radius: 4px;
                border: 1px solid rgba(255, 255, 255, 0.08);
            }
            .jf-p2p-swarm-tag {
                font-size: 0.68rem;
                font-weight: 700;
                padding: 1px 7px;
                border-radius: 999px;
                letter-spacing: 0.02em;
                display: inline-flex;
                align-items: center;
                gap: 5px;
                line-height: 1.3;
            }
            .jf-p2p-swarm-tag.same-swarm {
                background: rgba(16, 185, 129, 0.15);
                color: #34d399;
                border: 1px solid rgba(16, 185, 129, 0.35);
            }
            .jf-p2p-swarm-tag.same-swarm::before {
                content: "";
                display: inline-block;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #10b981;
                box-shadow: 0 0 5px #10b981;
            }
            .jf-p2p-swarm-tag.other-swarm {
                background: rgba(245, 158, 11, 0.15);
                color: #fbbf24;
                border: 1px solid rgba(245, 158, 11, 0.35);
            }
            .jf-p2p-swarm-tag.other-swarm::before {
                content: "";
                display: inline-block;
                width: 6px;
                height: 6px;
                border-radius: 50%;
                background: #f59e0b;
                box-shadow: 0 0 5px #f59e0b;
            }

            /* Restored Warning & Disclaimer Box */
            .jf-p2p-warn-box {
                margin-top: 10px;
                padding: 10px 12px;
                border-radius: 10px;
                background: rgba(245, 158, 11, 0.08);
                border: 1px solid rgba(245, 158, 11, 0.28);
                font-size: 0.78rem;
            }
            .jf-p2p-warn-header {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
                font-weight: 700;
                color: #fbbf24;
                margin-bottom: 6px;
            }
            .jf-p2p-disclaimer {
                font-size: 0.72rem;
                color: #d4d4d8;
                line-height: 1.5;
                background: rgba(9, 9, 11, 0.45);
                padding: 8px 10px;
                border-radius: 8px;
                border: 1px solid rgba(245, 158, 11, 0.12);
            }
            .jf-p2p-disclaimer ul {
                margin: 4px 0 0 16px;
                padding: 0;
            }
        `;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // Bulletproof Header Button Injection (.headerLeft & .videoOsd-appBar)
    // -------------------------------------------------------------------------
    function createP2PButton() {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("is", "paper-icon-button-light");
        btn.className = "headerP2PButton headerButton headerButtonLeft paper-icon-button-light";
        btn.title = "P2P WebRTC Mesh Monitor";
        btn.innerHTML = `
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true" style="pointer-events:none;">
                <path d="M17 16c-1.3 0-2.4.84-2.82 2H9.82C9.4 16.84 8.3 16 7 16c-1.66 0-3 1.34-3 3s1.34 3 3 3c1.3 0 2.4-.84 2.82-2h4.36c.42 1.16 1.52 2 2.82 2 1.66 0 3-1.34 3-3s-1.34-3-3-3zM7 6c1.12 0 2.09-.61 2.61-1.52l3.52 1.76c-.08.24-.13.5-.13.76 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3c-1.12 0-2.09.61-2.61 1.52L9.87 3.76C9.95 3.52 10 3.26 10 3c0-1.66-1.34-3-3-3S4 1.34 4 3s1.34 3 3 3z"/>
            </svg>
            <span class="jf-p2p-dot"></span>
        `;
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleModal();
        });
        return btn;
    }

    function mountJellyfinHeaderButton() {
        injectStyles();

        // 1. Standard / Legacy Header (.skinHeader / .headerLeft)
        const headerLeftList = document.querySelectorAll(".headerLeft");
        headerLeftList.forEach((headerLeft) => {
            if (headerLeft.querySelector(".headerP2PButton")) return;

            const btn = createP2PButton();
            const pageTitle = headerLeft.querySelector(".pageTitle");
            const backBtn = headerLeft.querySelector(".headerBackButton");
            const mainDrawerBtn = headerLeft.querySelector(".mainDrawerButton, .barsMenuButton");

            if (pageTitle && pageTitle.parentNode === headerLeft) {
                headerLeft.insertBefore(btn, pageTitle.nextSibling);
            } else if (backBtn && backBtn.parentNode === headerLeft) {
                headerLeft.insertBefore(btn, backBtn.nextSibling);
            } else if (mainDrawerBtn && mainDrawerBtn.parentNode === headerLeft) {
                headerLeft.insertBefore(btn, mainDrawerBtn.nextSibling);
            } else {
                headerLeft.appendChild(btn);
            }
        });

        // 2. React / MUI Video OSD AppBar (.videoOsd-appBar)
        const videoAppBars = document.querySelectorAll(".videoOsd-appBar");
        videoAppBars.forEach((appBar) => {
            if (appBar.querySelector(".headerP2PButton")) return;

            const btn = createP2PButton();
            const backBtn = appBar.querySelector("button[aria-label*='Back' i], button[title*='Back' i]");
            if (backBtn && backBtn.parentNode === appBar) {
                appBar.insertBefore(btn, backBtn.nextSibling);
            } else {
                appBar.appendChild(btn);
            }
        });

        // 3. Fallback headerRight if headerLeft is completely absent
        if (!document.querySelector(".headerP2PButton")) {
            const fallback = document.querySelector(".headerRight") || document.querySelector(".viewMenuBar");
            if (fallback && !fallback.querySelector(".headerP2PButton")) {
                const btn = createP2PButton();
                fallback.prepend(btn);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Modal DOM Generation
    // -------------------------------------------------------------------------
    function buildModal() {
        if (modalEl && document.body.contains(modalEl)) return modalEl;
        injectStyles();

        const backdrop = document.createElement("div");
        backdrop.id = "jf-p2p-hud-backdrop";
        backdrop.className = "jf-p2p-modal-backdrop";

        const modal = document.createElement("div");
        modal.className = "jf-p2p-modal";

        // Header
        const header = document.createElement("div");
        header.className = "jf-p2p-modal-header";
        header.innerHTML = `
            <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
                <span style="font-weight: 700; font-size: 1rem; margin-right: 4px;">P2P Mesh Chunk Matrix</span>
                <span class="jf-p2p-badge-mesh">Private Mesh</span>
                <span class="jf-p2p-badge-audio" id="jf-p2p-audio-badge">Audio: Track #0</span>
                <span class="jf-p2p-badge-quality" id="jf-p2p-quality-badge">Quality: Max</span>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
                <div style="text-align: right;">
                    <div id="jf-p2p-offload-text" style="color: #00dc82; font-weight: 700; font-size: 0.85rem;">0.0% P2P Offload</div>
                    <div id="jf-p2p-peers-text" style="color: #94a3b8; font-size: 0.72rem;">0 Active Peers • 5s NAT Keepalive</div>
                </div>
                <button class="jf-p2p-close-btn" title="Close">✕</button>
            </div>
        `;
        header.querySelector(".jf-p2p-close-btn").onclick = closeModal;
        modal.appendChild(header);

        // Dynamic Legend
        const legend = document.createElement("div");
        legend.id = "jf-p2p-legend";
        legend.className = "jf-p2p-legend";
        modal.appendChild(legend);

        // 64-cube Grid
        const gridMeta = document.createElement("div");
        gridMeta.className = "jf-p2p-grid-meta";
        gridMeta.innerHTML = `
            <span id="jf-p2p-window-label">Buffer Matrix (Chunks #0 – #63)</span>
            <span id="jf-p2p-buffered-count" style="color: #00dc82; font-weight: 700;">Buffered: 0 / 64 chunks</span>
        `;
        modal.appendChild(gridMeta);

        const gridBox = document.createElement("div");
        gridBox.className = "jf-p2p-grid-box";
        const grid = document.createElement("div");
        grid.className = "jf-p2p-grid";

        cubesCache = [];
        for (let i = 0; i < MATRIX_SIZE; i++) {
            const cube = document.createElement("div");
            cube.className = "jf-p2p-cube jf-p2p-cube-pending";
            cube.textContent = "";

            const badge = document.createElement("div");
            badge.className = "jf-p2p-playhead-badge";
            cube.appendChild(badge);

            cube.onclick = () => {
                selectedChunkIndex = i;
                scheduleRender();
            };

            grid.appendChild(cube);
            cubesCache.push({ cube, badge });
        }
        gridBox.appendChild(grid);
        modal.appendChild(gridBox);
        gridEl = grid;

        // Detail Bar
        const detailCard = document.createElement("div");
        detailCard.id = "jf-p2p-detail-card";
        detailCard.className = "jf-p2p-detail";
        detailCard.innerHTML = `<span style="color: #94a3b8;">Click any chunk cube to inspect transfer speed, size, and source peer.</span>`;
        modal.appendChild(detailCard);

        // Connected Friends in Lobby
        const friendsCard = document.createElement("div");
        friendsCard.id = "jf-p2p-friends-card";
        friendsCard.className = "jf-p2p-friends-box";
        friendsCard.innerHTML = `
            <div style="font-weight: 600; color: #94a3b8; margin-bottom: 4px;">Connected Friends in Swarm & Lobby</div>
            <div id="jf-p2p-friends-list" class="jf-p2p-peers-list">
                <span style="color: #64748b; font-size: 0.76rem;">No friends online in lobby yet</span>
            </div>
        `;
        modal.appendChild(friendsCard);

        // Restored Disclaimer / Warning Box
        const warnBox = document.createElement("div");
        warnBox.className = "jf-p2p-warn-box";
        warnBox.innerHTML = `
            <div class="jf-p2p-warn-header">
                <span id="jf-p2p-nonseed-list">⚠️ Not Seeding / HTTP-Only: None detected (Mesh Healthy)</span>
                <span style="font-size: 0.72rem; font-weight: 500; color: rgba(251, 191, 36, 0.85);">Using Server Upload</span>
            </div>
            <div class="jf-p2p-disclaimer">
                <strong style="color: #f4f4f5;">To enable P2P seeding for non-seeding peers:</strong>
                <ul>
                    <li><strong>Turn VPN off</strong> (VPNs block direct WebRTC UDP peer connections).</li>
                    <li><strong>Disable Adblockers / Tracking Prevention</strong> (e.g., uBlock / Brave Shield / Firefox ETP).</li>
                    <li><strong>Use a Chromium browser</strong> (Chrome, Edge, Brave) for full WebRTC P2P and 4K support.</li>
                </ul>
            </div>
        `;
        modal.appendChild(warnBox);

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        modalEl = backdrop;
        return modalEl;
    }

    function toggleModal() {
        const m = buildModal();
        if (m.classList.contains("open")) {
            closeModal();
        } else {
            m.classList.add("open");
            scheduleRender();
        }
    }

    function closeModal() {
        if (modalEl) modalEl.classList.remove("open");
    }

    // -------------------------------------------------------------------------
    // Render Loop & In-Place DOM Diffing
    // -------------------------------------------------------------------------
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(() => {
            renderScheduled = false;
            renderModalContent();
        });
    }

    function renderModalContent() {
        if (!modalEl || !modalEl.classList.contains("open")) return;
        const engine = global.JellyfinP2P;
        if (!engine) return;

        const stats = engine.getStats();
        const cleanPeers = getCleanPeers(engine);
        const activeCount = cleanPeers.filter((p) => p.connected).length;
        const chunks = engine.getChunks();
        const chunksMap = new Map();
        for (const c of chunks) chunksMap.set(c.num, c);

        // Header Stats
        const audioBadgeEl = document.getElementById("jf-p2p-audio-badge");
        if (audioBadgeEl) {
            const track = stats.currentAudioTrack;
            if (track !== null && track !== undefined && track !== "") {
                audioBadgeEl.textContent = `Audio: ${formatAudio(track)}`;
                audioBadgeEl.style.display = "inline-block";
            } else {
                audioBadgeEl.textContent = "Audio: Track #0";
                audioBadgeEl.style.display = "inline-block";
            }
        }

        const qualityBadgeEl = document.getElementById("jf-p2p-quality-badge");
        if (qualityBadgeEl) {
            qualityBadgeEl.textContent = `Quality: ${formatQuality(stats.currentQuality)}`;
            qualityBadgeEl.style.display = "inline-block";
        }

        const offloadEl = document.getElementById("jf-p2p-offload-text");
        if (offloadEl) {
            offloadEl.textContent = `${stats.offloadPct}% P2P Offload (${stats.p2pDownMB} MB P2P / ${stats.httpDownMB} MB HTTP)`;
        }

        const peersTextEl = document.getElementById("jf-p2p-peers-text");
        if (peersTextEl) {
            if (stats.isLocalHost) {
                peersTextEl.textContent = `${activeCount} Remote Friend${activeCount === 1 ? "" : "s"} • Direct Play Host Observer`;
            } else {
                peersTextEl.textContent = `${activeCount} Active Peer${activeCount === 1 ? "" : "s"} • 5s NAT Keepalive`;
            }
        }

        // Render Clean Legend with real usernames ONLY (no duplicate hash items)
        const legendEl = document.getElementById("jf-p2p-legend");
        if (legendEl) {
            let legHtml = `
                <div class="jf-p2p-legend-item" style="color: #ff007f; font-weight: 700;">
                    <span class="jf-p2p-mini-cube" style="background: rgba(255, 0, 127, 0.2); border: 2px solid #ff007f; color: #ff007f; font-size: 8px;">▶</span>
                    <span>Watching Now</span>
                </div>
                <div class="jf-p2p-legend-item">
                    <span class="jf-p2p-mini-cube jf-p2p-cube-http">H</span>
                    <span>Server (HTTP)</span>
                </div>
            `;
            for (const p of cleanPeers) {
                const pal = getPeerPalette(p.userName || p.peerId);
                const name = p.userName || `Peer [${p.shortId}]`;
                const initial = (p.userName || "P")[0].toUpperCase();
                const mb = (p.bytesFrom / 1048576).toFixed(1);
                const audioLbl = formatAudio(p.audioTrack);
                const qualityLbl = formatQuality(p.quality);
                const inSameSwarm = isPeerInMySwarm(p, stats);
                const swarmStatus = inSameSwarm
                    ? `<span style="color: #34d399; font-weight: 600;">• In Your Swarm</span>`
                    : `<span style="color: #fbbf24; font-weight: 600;">• Other Swarm</span>`;
                legHtml += `
                    <div class="jf-p2p-legend-item" style="opacity: ${p.connected ? "1" : "0.6"}">
                        <span class="jf-p2p-mini-cube" style="background: ${pal.bg}; color: ${pal.fg};">${initial}</span>
                        <span>${name} (${mb} MB • ${audioLbl} • ${qualityLbl} ${swarmStatus})</span>
                    </div>
                `;
            }
            legHtml += `
                <div class="jf-p2p-legend-item">
                    <span class="jf-p2p-mini-cube jf-p2p-cube-pending" style="color: #64748b;">·</span>
                    <span>Pending Buffer</span>
                </div>
            `;
            legendEl.innerHTML = legHtml;
        }

        // Determine Window Range
        const playingChunk = stats.playingChunk;
        let startWindow = 0;
        if (playingChunk !== null && playingChunk >= MATRIX_SIZE - 4) {
            startWindow = playingChunk - (MATRIX_SIZE - 8);
        }

        const winLabelEl = document.getElementById("jf-p2p-window-label");
        if (winLabelEl) {
            winLabelEl.textContent = `Buffer Matrix (Chunks #${startWindow} – #${startWindow + MATRIX_SIZE - 1})`;
        }

        let bufferedCount = 0;

        // Diff 64 Cubes
        for (let i = 0; i < MATRIX_SIZE; i++) {
            const sn = startWindow + i;
            const cMeta = chunksMap.get(sn);
            const { cube } = cubesCache[i];
            const isPlaying = playingChunk !== null && sn === playingChunk;

            let targetClass = "jf-p2p-cube ";
            let targetText = "";
            let targetBg = "";
            let targetColor = "";

            if (cMeta) {
                bufferedCount++;
                if (cMeta.sourceType === "p2p") {
                    targetClass += "jf-p2p-cube-p2p ";
                    const peerObj = cMeta.peerId
                        ? cleanPeers.find((p) => p.peerIds?.has(cMeta.peerId) || p.peerId === cMeta.peerId)
                        : null;
                    const pal = peerObj ? getPeerPalette(peerObj.userName || peerObj.peerId) : (cMeta.peerId ? getPeerPalette(cMeta.peerId) : null);
                    if (pal) {
                        targetBg = pal.bg;
                        targetColor = pal.fg;
                    }
                    targetText = peerObj?.userName ? peerObj.userName[0].toUpperCase() : "P";
                } else {
                    targetClass += "jf-p2p-cube-http ";
                    targetText = "H";
                }
            } else {
                targetClass += "jf-p2p-cube-pending ";
                targetText = "";
            }

            if (isPlaying) {
                targetClass += "jf-p2p-cube-playing ";
            }

            if (cube.className !== targetClass) {
                cube.className = targetClass;
            }
            if (targetBg) cube.style.background = targetBg;
            else cube.style.background = "";
            if (targetColor) cube.style.color = targetColor;
            else cube.style.color = "";

            if (cube.childNodes[0]?.nodeType === 3) {
                if (cube.childNodes[0].nodeValue !== targetText) {
                    cube.childNodes[0].nodeValue = targetText;
                }
            } else {
                cube.insertBefore(document.createTextNode(targetText), cube.firstChild);
            }
        }

        const bufCountEl = document.getElementById("jf-p2p-buffered-count");
        if (bufCountEl) {
            bufCountEl.textContent = `Buffered: ${bufferedCount} / ${MATRIX_SIZE} chunks`;
        }

        // Friends in Lobby & Swarm (Deduplicated Clean Pills with Live Swarm & Quality Badges)
        const friendsListEl = document.getElementById("jf-p2p-friends-list");
        if (friendsListEl) {
            if (cleanPeers.length === 0) {
                friendsListEl.innerHTML = `<span style="color: #64748b; font-size: 0.76rem;">No friends connected yet</span>`;
            } else {
                friendsListEl.innerHTML = cleanPeers
                    .map((p) => {
                        const pal = getPeerPalette(p.userName || p.peerId);
                        const displayName = p.userName
                            ? `<span style="font-weight: 700; color: #fff;">${p.userName}</span>`
                            : `<span style="color: #cbd5e1;">Peer [${p.shortId}]</span>`;
                        const browserTag = p.browser ? `<span style="color: #94a3b8; font-size: 0.72rem; margin-left: 2px;">(${p.browser})</span>` : "";
                        const audioLbl = formatAudio(p.audioTrack);
                        const qualityLbl = formatQuality(p.quality);
                        const metaBadge = `<span class="jf-p2p-peer-meta">${audioLbl} • ${qualityLbl}</span>`;

                        let swarmBadge = "";
                        if (p.connected) {
                            if (isPeerInMySwarm(p, stats)) {
                                swarmBadge = `<span class="jf-p2p-swarm-tag same-swarm">In Your Swarm</span>`;
                            } else {
                                swarmBadge = `<span class="jf-p2p-swarm-tag other-swarm">Other Swarm</span>`;
                            }
                        } else {
                            swarmBadge = `<span style="color: #64748b; font-size: 0.7rem;">(Offline)</span>`;
                        }

                        const rtt = p.rttMs !== null ? `${p.rttMs}ms RTT` : (p.connected ? "Active" : "Offline");
                        return `
                            <div class="jf-p2p-peer-pill" style="border-color: ${p.connected ? pal.border : 'rgba(255,255,255,0.1)'}">
                                <span class="jf-p2p-peer-dot" style="background: ${p.connected ? pal.textCls : '#64748b'};"></span>
                                <span>${displayName}${browserTag}</span>
                                ${metaBadge}
                                ${swarmBadge}
                                <span style="color: #94a3b8; font-size: 0.7rem;">(${rtt})</span>
                            </div>
                        `;
                    })
                    .join("");
            }
        }

        // Details Panel
        const detailCard = document.getElementById("jf-p2p-detail-card");
        if (detailCard) {
            const targetSn = selectedChunkIndex !== null ? startWindow + selectedChunkIndex : playingChunk;
            const chunkMeta = targetSn !== null ? chunksMap.get(targetSn) : null;
            if (chunkMeta) {
                let srcText = "Jellyfin Server (HTTP)";
                let srcColor = "#ffffff";
                if (chunkMeta.sourceType === "p2p") {
                    const seederPeer = chunkMeta.peerId
                        ? cleanPeers.find((p) => p.peerIds?.has(chunkMeta.peerId) || p.peerId === chunkMeta.peerId)
                        : null;
                    const seederName = seederPeer?.userName || (chunkMeta.peerId ? `Peer [${chunkMeta.peerId.slice(-4)}]` : 'P2P Peer');
                    const seederAudio = seederPeer?.audioTrack !== undefined && seederPeer?.audioTrack !== null ? formatAudio(seederPeer.audioTrack) : null;
                    const seederQuality = seederPeer?.quality ? formatQuality(seederPeer.quality) : null;
                    const metaExtra = (seederAudio || seederQuality) ? ` [${[seederAudio, seederQuality].filter(Boolean).join(" • ")}]` : "";
                    srcText = `P2P WebRTC Peer: <strong>${seederName}</strong>${metaExtra}`;
                    srcColor = "#00dc82";
                }
                detailCard.innerHTML = `
                    <div style="font-weight: 600; color: ${srcColor}; margin-bottom: 2px;">Chunk #${chunkMeta.num} (${srcText})</div>
                    <div style="color: #cbd5e1; font-size: 0.78rem;">
                        Size: <b>${chunkMeta.sizeMB} MB</b> • Timeline: <b>${Math.floor(chunkMeta.startSec)}s - ${Math.floor(chunkMeta.endSec)}s</b>
                        ${chunkMeta.durationMs ? ` • Transfer Time: <b>${chunkMeta.durationMs}ms</b>` : ""}
                    </div>
                `;
            } else if (targetSn !== null) {
                detailCard.innerHTML = `
                    <div style="font-weight: 600; color: #94a3b8;">Chunk #${targetSn} (Queued in Buffer Window)</div>
                    <div style="color: #64748b; font-size: 0.78rem;">Waiting for playhead window or P2P buffer expansion.</div>
                `;
            }
        }

        // Non-seeding / Swarm Separation Detection
        const nonseedListEl = document.getElementById("jf-p2p-nonseed-list");
        if (nonseedListEl) {
            const mySwarmPeers = cleanPeers.filter((p) => p.connected && isPeerInMySwarm(p, stats));
            const otherSwarmPeers = cleanPeers.filter((p) => p.connected && !isPeerInMySwarm(p, stats));
            const httpOnlyPeers = mySwarmPeers.filter((p) => p.bytesFrom === 0 && p.bytesTo === 0);

            if (httpOnlyPeers.length > 0) {
                const names = httpOnlyPeers.map((p) => p.userName ? (p.browser ? `${p.userName} (${p.browser})` : p.userName) : `Peer [${p.shortId}]`).join(", ");
                let text = `⚠️ In Your Swarm Not Seeding / HTTP-Only: ${names}`;
                if (otherSwarmPeers.length > 0) {
                    const otherNames = otherSwarmPeers.map(p => `${p.userName || `Peer [${p.shortId}]`} [${formatAudio(p.audioTrack)} • ${formatQuality(p.quality)}]`).join(", ");
                    text += ` • In Other Swarm: ${otherNames}`;
                }
                nonseedListEl.textContent = text;
            } else if (otherSwarmPeers.length > 0) {
                const otherNames = otherSwarmPeers.map(p => `${p.userName || `Peer [${p.shortId}]`} [${formatAudio(p.audioTrack)} • ${formatQuality(p.quality)}]`).join(", ");
                nonseedListEl.textContent = `ℹ️ Swarms Active: ${mySwarmPeers.length} in your swarm • ${otherSwarmPeers.length} in other swarm (${otherNames})`;
            } else {
                nonseedListEl.textContent = `⚠️ Not Seeding / HTTP-Only: None detected (Mesh Healthy)`;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Subscriptions to Headless Engine Events
    // -------------------------------------------------------------------------
    function initSubscriptions() {
        const engine = global.JellyfinP2P;
        if (!engine) {
            setTimeout(initSubscriptions, 300);
            return;
        }

        engine.on("stats-updated", scheduleRender);
        engine.on("segment-loaded", scheduleRender);
        engine.on("peer-connected", scheduleRender);
        engine.on("peer-disconnected", scheduleRender);
        engine.on("peer-rtt-updated", scheduleRender);
        engine.on("peer-watch-updated", scheduleRender);
        engine.on("lobby-updated", scheduleRender);
    }

    // -------------------------------------------------------------------------
    // Initialization Loop
    // -------------------------------------------------------------------------
    initSubscriptions();

    if (typeof document !== "undefined") {
        injectStyles();
        setInterval(mountJellyfinHeaderButton, 1500);
        setTimeout(mountJellyfinHeaderButton, 100);
        setTimeout(mountJellyfinHeaderButton, 600);
        setTimeout(mountJellyfinHeaderButton, 1500);

        document.addEventListener("headerrendered", mountJellyfinHeaderButton);
        window.addEventListener("hashchange", () => setTimeout(mountJellyfinHeaderButton, 100));
        window.addEventListener("popstate", () => setTimeout(mountJellyfinHeaderButton, 100));
        window.addEventListener("keydown", (ev) => {
            if (ev?.key === "Escape") closeModal();
        });
    }

})(window);
