// Jellyfin Private P2P Unified Bundle (Engine + UI)
/**
 * Jellyfin WebRTC P2P Mesh Engine (Headless Core)
 * Version: 2.1.0-audio-names-fix
 * 
 * Features:
 * - Universal Global Lobby (Persistent background WebRTC discovery before playback starts)
 * - Peer Exchange (PEX): Connected peers continuously introduce each other
 * - Audio Track Switch Detection: Seamlessly migrates swarms when audio track changes
 * - PlaybackInfo Interception: Forces full-quality HLS stream-copy (-c:v copy) with external subtitles
 * - Multi-source Username Resolution: Instant synchronous lookup from localStorage + ApiClient + Telemetry
 * - Tuned specifically for residential Wi-Fi (15-50 Mbps upload, 55 Mbps server line)
 * - Anti-Drop NAT Keepalive: 5-second UDP pings prevent residential router NAT timeouts
 * - Decoupled Headless Architecture: Zero DOM / UI dependencies; emits clean events
 * - Localhost Observer Mode: Observes swarm without leeching/seeding
 */

(function (global) {
    "use strict";

    if (global.__JellyfinP2PEngineLoaded) {
        console.debug("[P2P-Engine] Already loaded, skipping duplicate registration.");
        return;
    }
    global.__JellyfinP2PEngineLoaded = true;

    // -------------------------------------------------------------------------
    // Configuration & Constants
    // -------------------------------------------------------------------------
    const IS_LOCAL_HOST =
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1" ||
        location.hostname === "::1";

    const PROTOCOL = location.protocol === "https:" ? "wss:" : "ws:";
    const PRIVATE_TRACKER_URL = `${PROTOCOL}//${location.host}/tracker`;
    const GLOBAL_LOBBY_HASH = "6a662d6c6f6262792d7631303030303030303030"; // "jf-lobby-v1000000000" in hex (20 bytes)
    const CORE_ESM_URL = "https://cdn.jsdelivr.net/npm/p2p-media-loader-core@^4/dist/p2p-media-loader-core.es.min.js";
    const HLSJS_ESM_URL = "https://cdn.jsdelivr.net/npm/p2p-media-loader-hlsjs@^4/dist/p2p-media-loader-hlsjs.es.min.js";
    const MAX_AUTO_BITRATE = 140000000;
    const PLAYBACK_INFO_REGEX = /\/Items\/[^/?#]+\/PlaybackInfo\b/i;

    const NAT_PING_INTERVAL_MS = 5000;       // 5s keepalive to survive home router NAT tables
    const PEX_INTERVAL_MS = 7000;            // 7s peer introduction frequency
    const TELEMETRY_INTERVAL_MS = 2500;      // 2.5s swarm telemetry sync

    // -------------------------------------------------------------------------
    // Event Emitter Implementation
    // -------------------------------------------------------------------------
    const listeners = new Map();

    function on(event, callback) {
        if (typeof callback !== "function") return;
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(callback);
    }

    function off(event, callback) {
        if (!listeners.has(event)) return;
        listeners.get(event).delete(callback);
    }

    function emit(event, data) {
        const set = listeners.get(event);
        if (!set) return;
        for (const cb of set) {
            try {
                cb(data);
            } catch (err) {
                console.error(`[P2P-Engine] Error in listener for event "${event}":`, err);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Core Engine State
    // -------------------------------------------------------------------------
    let localPeerId = null;
    let localPeerShort = null;
    let localUserName = null;

    function initLocalPeerId() {
        if (!localPeerId) {
            const rnd = Array.from({ length: 12 }, () =>
                Math.floor(Math.random() * 36).toString(36)
            ).join("");
            localPeerId = `-PM0400-${rnd}`;
            localPeerShort = shortenPeerId(localPeerId);
            globalThis.__jfP2PLocalPeerId = localPeerId;
        }
        return localPeerId;
    }
    initLocalPeerId();
    let currentMovieSwarmId = null;
    let currentMovieItemId = null;
    let currentAudioStreamIndex = null;
    let currentQualityTier = "max";
    globalThis.__jfP2PQuality = "max";
    globalThis.__jfP2PAudioTrack = null;
    let activeTrackerWs = null;

    const peers = new Map();            // peerId -> PeerRecord
    const peerIdentities = new Map();   // peerId -> { userName, browser, audioTrack, quality }
    const lobbyChannels = new Map();     // peerId -> RTCDataChannel (lobby sideband)
    const chunks = new Map();            // sn -> ChunkRecord
    const fragTiming = new Map();        // sn -> { startSec, endSec, durationMs }

    const state = {
        isLocalHost: IS_LOCAL_HOST,
        streamActive: false,
        playingChunk: null,
        currentTime: 0,
        currentAudioTrack: null,
        currentQuality: "max",
        avgChunkDurationSec: 4.0,
        p2pDownBytes: 0,
        httpDownBytes: 0,
        p2pUpBytes: 0,
        lowestChunkNum: null,
        highestChunkNum: null,
        selectedChunkNum: null,
        trackerConnected: false,
        activeSwarms: 0
    };

    function detectBrowserLabel() {
        const ua = navigator.userAgent;
        if (ua.includes("Edg/")) return "Edge";
        if (ua.includes("Chrome/")) return "Chrome";
        if (ua.includes("Firefox/")) return "Firefox";
        if (ua.includes("Safari/") && !ua.includes("Chrome")) return "Safari";
        return "Browser";
    }

    function shortenPeerId(id) {
        if (!id || typeof id !== "string") return "????";
        const clean = id.replace(/^-[A-Za-z0-9]+-/, "");
        return clean.length >= 4 ? clean.slice(-4) : clean;
    }

    // -------------------------------------------------------------------------
    // User Identity Discovery (Multi-source: Instant localStorage + ApiClient)
    // -------------------------------------------------------------------------
    function setLocalUserName(name) {
        if (!name || typeof name !== "string") return;
        const clean = name.trim();
        if (!clean || clean === localUserName) return;
        localUserName = clean;
        globalThis.__jfP2PUserName = localUserName;
        globalThis.__jfP2PBrowser = detectBrowserLabel();
        console.log(`%c[P2P-Engine] Identified local user: ${localUserName}`, "color: #00dc82; font-weight: bold;");
        broadcastLobbyPresence();
        emit("identity-updated", { userName: localUserName });
        sendTelemetry();
    }

    function refreshLocalUserName() {
        if (localUserName) {
            globalThis.__jfP2PUserName = localUserName;
            globalThis.__jfP2PBrowser = detectBrowserLabel();
            return localUserName;
        }

        // Source 1: Synchronous Jellyfin credentials in localStorage
        try {
            const credsRaw = localStorage.getItem("jellyfin_credentials");
            if (credsRaw) {
                const creds = JSON.parse(credsRaw);
                const name = creds?.Servers?.[0]?.User?.Name || creds?.User?.Name;
                if (name) return setLocalUserName(name);
            }
        } catch {}

        // Source 2: Alternative username keys in storage
        try {
            const u = localStorage.getItem("username") || sessionStorage.getItem("username");
            if (u) return setLocalUserName(u);
        } catch {}

        // Source 3: ApiClient async lookup
        try {
            const api = global.ApiClient;
            if (api && typeof api.getCurrentUser === "function") {
                Promise.resolve(api.getCurrentUser())
                    .then((u) => {
                        if (u?.Name) setLocalUserName(u.Name);
                    })
                    .catch(() => {});
            }
        } catch {}

        return localUserName;
    }
    globalThis.__jfP2PBrowser = detectBrowserLabel();
    refreshLocalUserName();
    setInterval(refreshLocalUserName, 2000);

    // -------------------------------------------------------------------------
    // Universal Global Lobby WebSocket Client
    // -------------------------------------------------------------------------
    function connectGlobalLobbyTracker() {
        try {
            const ws = new WebSocket(PRIVATE_TRACKER_URL);
            activeTrackerWs = ws;

            ws.onopen = () => {
                state.trackerConnected = true;
                emit("tracker-connected", { url: PRIVATE_TRACKER_URL });

                // Ensure unified consistent peerId is ready
                initLocalPeerId();

                // Announce to static global lobby
                const announcePayload = JSON.stringify({
                    action: "announce",
                    info_hash: GLOBAL_LOBBY_HASH,
                    peer_id: localPeerId,
                    numwant: 20,
                    uploaded: 0,
                    downloaded: 0,
                    left: 0
                });
                ws.send(announcePayload);

                // Initial telemetry sync
                setTimeout(sendTelemetry, 300);
            };

            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    handleTrackerMessage(msg);
                } catch {
                    // Ignore non-json
                }
            };

            ws.onclose = () => {
                state.trackerConnected = false;
                emit("tracker-disconnected", {});
                setTimeout(connectGlobalLobbyTracker, 4000);
            };

            ws.onerror = () => {
                try { ws.close(); } catch {}
            };
        } catch (e) {
            console.debug("[P2P-Engine] Lobby tracker connect error:", e);
            setTimeout(connectGlobalLobbyTracker, 5000);
        }
    }

    function handleTrackerMessage(msg) {
        if (!msg || typeof msg !== "object") return;

        // Peer offers received via tracker for lobby
        if (msg.offer && msg.peer_id && msg.offer_id) {
            handleIncomingLobbyOffer(msg.peer_id, msg.offer, msg.offer_id);
        }
    }

    // -------------------------------------------------------------------------
    // Tracker Telemetry Polling (Automatic Username Synchronization)
    // -------------------------------------------------------------------------
    async function pollTrackerTelemetry() {
        try {
            const targetUrl = IS_LOCAL_HOST ? "http://127.0.0.1:8000/telemetry" : "/tracker/telemetry";
            const resp = await fetch(targetUrl, { cache: "no-store" });
            if (!resp.ok) return;
            const data = await resp.json();
            if (!data?.swarms || !Array.isArray(data.swarms)) return;

            let updatedAny = false;
            for (const swarm of data.swarms) {
                const isLobby = swarm.infoHashHex === "36613636326436633666363236323739326437363331333033303330333033303330333033303330" ||
                                swarm.infoHashPreview === "3661363632" ||
                                (typeof swarm.infoHashHex === "string" && swarm.infoHashHex.toLowerCase().includes("lobby"));

                for (const p of swarm.peers || []) {
                    if (p.peerId && p.userName && !p.userName.startsWith("Peer ") && !p.userName.startsWith("Peer-") && !p.userName.startsWith("Peer [")) {
                        const targetSwarmId = p.swarmId || (!isLobby ? swarm.infoHashHex : null);
                        peerIdentities.set(p.peerId, {
                            userName: p.userName,
                            browser: p.browser || null,
                            audioTrack: p.audioTrack !== undefined ? p.audioTrack : null,
                            quality: p.quality !== undefined ? p.quality : null,
                            currentSwarmId: targetSwarmId || null
                        });
                        const existing = peers.get(p.peerId);
                        if (existing) {
                            if (!existing.userName || existing.userName !== p.userName) {
                                existing.userName = p.userName;
                                updatedAny = true;
                            }
                            if (p.browser && existing.browser !== p.browser) {
                                existing.browser = p.browser;
                                updatedAny = true;
                            }
                            if (p.audioTrack !== undefined && p.audioTrack !== null && existing.audioTrack !== p.audioTrack) {
                                existing.audioTrack = p.audioTrack;
                                updatedAny = true;
                            }
                            if (p.quality !== undefined && p.quality !== null && existing.quality !== p.quality) {
                                existing.quality = p.quality;
                                updatedAny = true;
                            }
                            if (p.swarmId && existing.currentSwarmId !== p.swarmId) {
                                existing.currentSwarmId = p.swarmId;
                                updatedAny = true;
                            } else if (!isLobby && swarm.infoHashHex && (!existing.currentSwarmId || !existing.currentSwarmId.startsWith("jellyfin-"))) {
                                existing.currentSwarmId = swarm.infoHashHex;
                                updatedAny = true;
                            }
                        }
                    }
                }
            }
            if (updatedAny) {
                emit("lobby-updated", { peers: Array.from(peers.values()) });
            }
        } catch {
            // Ignore telemetry fetch failure
        }
    }
    setInterval(pollTrackerTelemetry, 3500);

    // -------------------------------------------------------------------------
    // Peer Exchange (PEX) & Sideband Data Channels
    // -------------------------------------------------------------------------
    function getOrCreatePeer(peerId, initialInfo = {}) {
        const key = String(peerId || "unknown");
        let p = peers.get(key);
        const known = peerIdentities.get(key);

        if (!p) {
            p = {
                peerId: key,
                shortId: shortenPeerId(key),
                userName: initialInfo.userName || known?.userName || null,
                browser: initialInfo.browser || known?.browser || null,
                audioTrack: initialInfo.audioTrack !== undefined ? initialInfo.audioTrack : (known?.audioTrack || null),
                quality: initialInfo.quality !== undefined ? initialInfo.quality : (known?.quality || null),
                connected: false,
                inHlsSwarm: false,
                rttMs: null,
                currentSwarmId: initialInfo.currentSwarmId || known?.currentSwarmId || null,
                currentMovieTitle: null,
                bufferedChunks: [],
                bytesFrom: 0,
                bytesTo: 0,
                segmentsFrom: 0,
                lastSeenAt: Date.now(),
                get label() {
                    return this.userName ? `${this.userName} [${this.shortId}]` : `Peer [${this.shortId}]`;
                }
            };
            peers.set(key, p);
            emit("peer-joined", p);
        } else {
            if (!p.userName && (initialInfo.userName || known?.userName)) {
                p.userName = initialInfo.userName || known?.userName;
            }
            if (!p.browser && (initialInfo.browser || known?.browser)) {
                p.browser = initialInfo.browser || known?.browser;
            }
            if (initialInfo.audioTrack !== undefined && initialInfo.audioTrack !== null) {
                p.audioTrack = initialInfo.audioTrack;
            } else if (!p.audioTrack && known?.audioTrack) {
                p.audioTrack = known.audioTrack;
            }
            if (initialInfo.quality !== undefined && initialInfo.quality !== null) {
                p.quality = initialInfo.quality;
            } else if (!p.quality && known?.quality) {
                p.quality = known.quality;
            }
            if (initialInfo.currentSwarmId) {
                p.currentSwarmId = initialInfo.currentSwarmId;
            } else if (!p.currentSwarmId && known?.currentSwarmId) {
                p.currentSwarmId = known.currentSwarmId;
            }
        }
        return p;
    }

    function registerLobbyChannel(peerId, channel) {
        if (!peerId || !channel) return;
        lobbyChannels.set(peerId, channel);
        const p = getOrCreatePeer(peerId);
        p.connected = true;

        channel.onopen = () => {
            p.connected = true;
            broadcastLobbyPresenceToPeer(channel);
            emit("peer-connected", p);
            emit("lobby-updated", { peers: Array.from(peers.values()) });
        };

        channel.onclose = () => {
            p.connected = false;
            lobbyChannels.delete(peerId);
            emit("peer-disconnected", p);
            emit("lobby-updated", { peers: Array.from(peers.values()) });
        };

        channel.onmessage = (ev) => {
            handleSidebandMessage(peerId, ev.data, channel);
        };
    }

    function handleSidebandMessage(fromPeerId, rawData, channel) {
        if (typeof rawData !== "string") return;

        let activePeerId = fromPeerId;
        if (!activePeerId && channel) {
            for (const [pid, ch] of lobbyChannels.entries()) {
                if (ch === channel) {
                    activePeerId = pid;
                    break;
                }
            }
        }

        // Fast NAT ping/pong handler
        if (rawData.startsWith("p:")) {
            try { channel.send("q:" + rawData.slice(2)); } catch {}
            return;
        }
        if (rawData.startsWith("q:")) {
            const t0 = Number(rawData.slice(2));
            if (Number.isFinite(t0) && t0 > 0 && activePeerId) {
                const rtt = Math.max(1, Math.round(performance.now() - t0));
                const p = peers.get(activePeerId);
                if (p) {
                    p.rttMs = rtt;
                    p.lastSeenAt = Date.now();
                    emit("peer-rtt-updated", { peerId: activePeerId, rttMs: rtt });
                }
            }
            return;
        }

        // Fast Identity payload: id:{"peerId":"...","userName":"..."}
        if (rawData.startsWith("id:")) {
            try {
                const info = JSON.parse(rawData.slice(3));
                if (info?.peerId && info?.userName) {
                    peerIdentities.set(info.peerId, {
                        userName: info.userName,
                        browser: info.browser || null
                    });
                    if (channel) {
                        lobbyChannels.set(info.peerId, channel);
                    }
                    const real = getOrCreatePeer(info.peerId, info);
                    real.connected = true;
                    if (info.userName && (!real.userName || real.userName !== info.userName)) {
                        real.userName = info.userName;
                    }
                    if (info.browser) real.browser = info.browser;
                    emit("peer-connected", real);
                    emit("peer-updated", real);
                    emit("lobby-updated", { peers: Array.from(peers.values()) });
                }
            } catch {}
            return;
        }

        // JSON Control Messages (PEX, Watch State, Buffer Announcements)
        try {
            const msg = JSON.parse(rawData);
            if (!msg || typeof msg !== "object") return;

            const targetPeerId = msg.peerId || activePeerId;
            if (!targetPeerId) return;
            const p = getOrCreatePeer(targetPeerId);

            switch (msg.type) {
                case "identity":
                    if (msg.userName) {
                        p.userName = String(msg.userName).slice(0, 32);
                        if (msg.peerId) {
                            peerIdentities.set(msg.peerId, { userName: p.userName, browser: msg.browser });
                            if (channel) lobbyChannels.set(msg.peerId, channel);
                        }
                    }
                    if (msg.browser) p.browser = String(msg.browser).slice(0, 32);
                    p.connected = true;
                    emit("peer-updated", p);
                    emit("lobby-updated", { peers: Array.from(peers.values()) });
                    break;

                case "watch-state":
                    p.currentSwarmId = msg.swarmId || null;
                    p.currentMovieTitle = msg.title || null;
                    if (msg.audioStreamIndex !== undefined && msg.audioStreamIndex !== null) {
                        p.audioTrack = String(msg.audioStreamIndex);
                    }
                    if (msg.quality !== undefined && msg.quality !== null) {
                        p.quality = String(msg.quality);
                    }
                    if (Array.isArray(msg.bufferedChunks)) {
                        p.bufferedChunks = msg.bufferedChunks;
                    }
                    emit("peer-watch-updated", p);
                    emit("lobby-updated", { peers: Array.from(peers.values()) });
                    break;

                case "pex":
                    if (Array.isArray(msg.peers)) {
                        handlePexIntroduction(msg.peers);
                    }
                    break;

                case "pex-relay":
                    handlePexRelay(msg);
                    break;
            }
        } catch {
            // Ignore parse errors
        }
    }

    function handlePexIntroduction(introducedPeers) {
        for (const intro of introducedPeers) {
            if (!intro?.peerId || intro.peerId === localPeerId) continue;
            if (intro.userName) {
                peerIdentities.set(intro.peerId, { userName: intro.userName, browser: intro.browser || null });
            }
            const existing = peers.get(intro.peerId);
            if (!existing || !existing.connected) {
                getOrCreatePeer(intro.peerId, intro);
            }
        }
    }

    function handlePexRelay(msg) {
        if (msg.targetPeerId === localPeerId) {
            console.debug(`[P2P-Engine] Received relayed WebRTC signal from ${shortenPeerId(msg.fromPeerId)}`);
        } else {
            const forwardChannel = lobbyChannels.get(msg.targetPeerId);
            if (forwardChannel && forwardChannel.readyState === "open") {
                try {
                    forwardChannel.send(JSON.stringify(msg));
                } catch {}
            }
        }
    }

    function broadcastLobbyPresence() {
        const name = localUserName || (IS_LOCAL_HOST ? "Host (Observer)" : detectBrowserLabel());
        const rawJson = JSON.stringify({
            type: "identity",
            peerId: localPeerId,
            userName: name,
            browser: detectBrowserLabel()
        });
        const idPayload = "id:" + rawJson;

        const watchPayload = currentMovieSwarmId ? JSON.stringify({
            type: "watch-state",
            swarmId: currentMovieSwarmId,
            itemId: currentMovieItemId,
            audioStreamIndex: currentAudioStreamIndex,
            quality: currentQualityTier,
            bufferedChunks: Array.from(chunks.keys()).slice(-64)
        }) : null;

        for (const ch of lobbyChannels.values()) {
            if (ch && ch.readyState === "open") {
                try {
                    ch.send(idPayload);
                    ch.send(rawJson);
                    if (watchPayload) ch.send(watchPayload);
                } catch {}
            }
        }
    }

    function broadcastLobbyPresenceToPeer(channel) {
        if (!channel || channel.readyState !== "open") return;
        try {
            const name = localUserName || (IS_LOCAL_HOST ? "Host (Observer)" : detectBrowserLabel());
            const rawJson = JSON.stringify({
                type: "identity",
                peerId: localPeerId,
                userName: name,
                browser: detectBrowserLabel()
            });
            channel.send("id:" + rawJson);
            channel.send(rawJson);

            if (currentMovieSwarmId) {
                channel.send(JSON.stringify({
                    type: "watch-state",
                    swarmId: currentMovieSwarmId,
                    itemId: currentMovieItemId,
                    audioStreamIndex: currentAudioStreamIndex,
                    quality: currentQualityTier,
                    bufferedChunks: Array.from(chunks.keys()).slice(-64)
                }));
            }
        } catch {}
    }

    // NAT Keepalive & RTT Ping Loop (Every 5 seconds)
    setInterval(() => {
        const now = Math.round(performance.now());
        const pingPayload = "p:" + now;
        for (const [peerId, ch] of lobbyChannels.entries()) {
            if (ch && ch.readyState === "open") {
                try {
                    ch.send(pingPayload);
                } catch {}
            }
        }
    }, NAT_PING_INTERVAL_MS);

    // Peer Exchange Loop (Every 7 seconds: share known peer list with mesh)
    setInterval(() => {
        if (lobbyChannels.size < 1) return;

        const knownList = [];
        for (const p of peers.values()) {
            if (p.connected) {
                knownList.push({
                    peerId: p.peerId,
                    userName: p.userName,
                    browser: p.browser
                });
            }
        }
        if (knownList.length === 0) return;

        const pexPayload = JSON.stringify({
            type: "pex",
            fromPeerId: localPeerId,
            peers: knownList
        });

        for (const ch of lobbyChannels.values()) {
            if (ch && ch.readyState === "open") {
                try { ch.send(pexPayload); } catch {}
            }
        }
    }, PEX_INTERVAL_MS);

    // -------------------------------------------------------------------------
    // WebRTC RTCPeerConnection Sniffer & NAT Sideband Hook
    // -------------------------------------------------------------------------
    const NativeRTCPeerConnection = global.RTCPeerConnection;
    if (typeof NativeRTCPeerConnection === "function" && !NativeRTCPeerConnection.__jfP2PHooked) {
        const ProxiedRTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
            construct(target, args, newTarget) {
                const pc = Reflect.construct(target, args, newTarget);
                let sidebandChannel = null;

                pc.addEventListener("datachannel", (ev) => {
                    const ch = ev.channel;
                    if (ch && ch.label === "__jf_p2p_sideband") {
                        sidebandChannel = ch;
                        attachSidebandChannel(pc, ch);
                    }
                });

                pc.addEventListener("iceconnectionstatechange", () => {
                    if (pc.iceConnectionState === "connected" && !sidebandChannel) {
                        try {
                            sidebandChannel = pc.createDataChannel("__jf_p2p_sideband", {
                                negotiated: true,
                                id: 88
                            });
                            attachSidebandChannel(pc, sidebandChannel);
                        } catch {}
                    }
                });

                function attachSidebandChannel(peerConn, channel) {
                    if (!channel) return;

                    const sendPresence = () => {
                        broadcastLobbyPresenceToPeer(channel);
                    };

                    if (channel.readyState === "open") {
                        sendPresence();
                    } else {
                        channel.addEventListener("open", sendPresence);
                    }

                    channel.addEventListener("message", (ev) => {
                        handleSidebandMessage(null, ev.data, channel);
                    });

                    channel.addEventListener("close", () => {
                        for (const [pid, ch] of lobbyChannels.entries()) {
                            if (ch === channel) {
                                lobbyChannels.delete(pid);
                                const p = peers.get(pid);
                                if (p) {
                                    p.connected = false;
                                    emit("peer-disconnected", p);
                                    emit("lobby-updated", { peers: Array.from(peers.values()) });
                                }
                                break;
                            }
                        }
                    });
                }

                return pc;
            }
        });
        Object.defineProperty(ProxiedRTCPeerConnection, "__jfP2PHooked", { value: true });
        global.RTCPeerConnection = ProxiedRTCPeerConnection;
    }

    // -------------------------------------------------------------------------
    // PlaybackInfo Interceptor (Force Full-Quality HLS Remux + Audio Tracking)
    // -------------------------------------------------------------------------
    function ensureExternalSubtitleProfile(profiles, format, container) {
        const exists = profiles.some((p) => p && String(p.Format || "").toLowerCase() === format);
        if (!exists) {
            profiles.push({
                Format: format,
                Method: "External",
                Container: container || format
            });
        }
    }

    function transformPlaybackInfoUrl(rawUrl) {
        try {
            const parsed = new URL(rawUrl, location.origin);
            const aIdx = getParamCaseInsensitive(parsed.searchParams, "AudioStreamIndex");
            if (aIdx !== null) {
                currentAudioStreamIndex = aIdx;
                state.currentAudioTrack = aIdx;
                globalThis.__jfP2PAudioTrack = aIdx;
            }
            if (parsed.searchParams.has("enableDirectPlay")) {
                parsed.searchParams.set("enableDirectPlay", "false");
            }
            if (parsed.searchParams.has("alwaysBurnInSubtitleWhenTranscoding")) {
                parsed.searchParams.set("alwaysBurnInSubtitleWhenTranscoding", "false");
            }
            if (parsed.searchParams.has("maxStreamingBitrate")) {
                const cur = Number(parsed.searchParams.get("maxStreamingBitrate")) || 0;
                if (!cur || cur >= 80000000) {
                    parsed.searchParams.set("maxStreamingBitrate", String(MAX_AUTO_BITRATE));
                } else {
                    const qTier = `${Math.round(cur / 1000000)}m`;
                    currentQualityTier = qTier;
                    state.currentQuality = qTier;
                    globalThis.__jfP2PQuality = qTier;
                }
            }
            return rawUrl.startsWith("http") ? parsed.toString() : parsed.pathname + parsed.search + parsed.hash;
        } catch {
            return rawUrl;
        }
    }

    function transformPlaybackInfoBody(rawBody) {
        if (typeof rawBody !== "string" || !rawBody.includes("DeviceProfile")) {
            return { body: rawBody };
        }
        try {
            const dto = JSON.parse(rawBody);
            if (!dto || typeof dto !== "object" || !dto.DeviceProfile) {
                return { body: rawBody };
            }

            if (dto.AudioStreamIndex !== undefined && dto.AudioStreamIndex !== null) {
                currentAudioStreamIndex = String(dto.AudioStreamIndex);
                state.currentAudioTrack = currentAudioStreamIndex;
                globalThis.__jfP2PAudioTrack = currentAudioStreamIndex;
                console.log(`%c[P2P-Engine] PlaybackInfo selected AudioStreamIndex: ${currentAudioStreamIndex}`, "color: #d980fa; font-weight: bold;");
            }

            if (dto.MaxStreamingBitrate && Number(dto.MaxStreamingBitrate) > 0) {
                const mb = Number(dto.MaxStreamingBitrate);
                if (mb < 80000000) {
                    currentQualityTier = `${Math.round(mb / 1000000)}m`;
                    state.currentQuality = currentQualityTier;
                    globalThis.__jfP2PQuality = currentQualityTier;
                    console.log(`%c[P2P-Engine] PlaybackInfo selected Quality: ${currentQualityTier}`, "color: #38bdf8; font-weight: bold;");
                } else {
                    currentQualityTier = "max";
                    state.currentQuality = "max";
                    globalThis.__jfP2PQuality = "max";
                    dto.MaxStreamingBitrate = MAX_AUTO_BITRATE;
                }
            } else {
                dto.MaxStreamingBitrate = MAX_AUTO_BITRATE;
            }

            if (Array.isArray(dto.DeviceProfile.DirectPlayProfiles)) {
                dto.DeviceProfile.DirectPlayProfiles = dto.DeviceProfile.DirectPlayProfiles.filter(
                    (p) => !p || p.Type !== "Video" || String(p.Container || "").toLowerCase() === "hls"
                );
            }

            if (dto.EnableDirectStream !== false) dto.EnableDirectStream = true;
            if (dto.AllowVideoStreamCopy !== false) dto.AllowVideoStreamCopy = true;
            if (dto.AllowAudioStreamCopy !== false) dto.AllowAudioStreamCopy = true;

            if (Array.isArray(dto.DeviceProfile.TranscodingProfiles)) {
                for (const tp of dto.DeviceProfile.TranscodingProfiles) {
                    if (tp && tp.Type === "Video" && String(tp.Protocol || "").toLowerCase() === "hls") {
                        tp.BreakOnNonKeyFrames = false;
                        tp.MinSegments = "1";
                    }
                }
            }

            dto.AlwaysBurnInSubtitleWhenTranscoding = false;

            return { body: JSON.stringify(dto) };
        } catch (err) {
            console.warn("[P2P-Engine] Failed to transform PlaybackInfo payload:", err);
            return { body: rawBody };
        }
    }

    function installPlaybackInfoHooks() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            const upperMethod = typeof method === "string" ? method.toUpperCase() : "";
            let targetUrl = typeof url === "string" ? url : String(url || "");
            this.__p2pIsPlaybackInfo = upperMethod === "POST" && PLAYBACK_INFO_REGEX.test(targetUrl);
            if (this.__p2pIsPlaybackInfo && targetUrl.includes("?")) {
                targetUrl = transformPlaybackInfoUrl(targetUrl);
            }
            return origOpen.call(this, method, targetUrl, ...rest);
        };

        XMLHttpRequest.prototype.send = function (body) {
            if (this.__p2pIsPlaybackInfo) {
                const { body: newBody } = transformPlaybackInfoBody(body);
                return origSend.call(this, newBody);
            }
            return origSend.call(this, body);
        };

        if (typeof global.fetch === "function") {
            const origFetch = global.fetch;
            global.fetch = function (input, init) {
                try {
                    const url = typeof input === "string" ? input : input?.url || "";
                    const method = (init?.method || input?.method || "GET").toUpperCase();
                    if (method === "POST" && PLAYBACK_INFO_REGEX.test(url) && typeof init?.body === "string") {
                        const { body: newBody } = transformPlaybackInfoBody(init.body);
                        const newUrl = typeof input === "string" ? transformPlaybackInfoUrl(url) : input;
                        return origFetch.call(this, newUrl, { ...init, body: newBody });
                    }
                } catch {}
                return origFetch.call(this, input, init);
            };
        }
    }
    installPlaybackInfoHooks();

    // -------------------------------------------------------------------------
    // HLS Swarm ID Builder & Helpers
    // -------------------------------------------------------------------------
    function extractJellyfinItemId(url) {
        if (!url || typeof url !== "string") return "";
        const m = url.match(/\/Items\/([a-zA-Z0-9]+)/i) || url.match(/\/videos\/([a-zA-Z0-9]+)/i);
        return m ? m[1] : "";
    }

    function getParamCaseInsensitive(params, key) {
        if (!params) return null;
        for (const [k, v] of params.entries()) {
            if (k.toLowerCase() === key.toLowerCase()) return v;
        }
        return null;
    }

    function buildJellyfinSwarmSuffix(manifestUrl, fallbackUrl) {
        const targetUrl = manifestUrl || fallbackUrl || "";
        let audioIdx = currentAudioStreamIndex ?? "def";
        let segContainer = "mp4";
        let qualityTier = currentQualityTier || "max";

        if (targetUrl) {
            try {
                const parsed = new URL(targetUrl, location.origin);
                const sp = parsed.searchParams;
                const parsedAudio = getParamCaseInsensitive(sp, "AudioStreamIndex");
                if (parsedAudio !== null) {
                    audioIdx = parsedAudio;
                    currentAudioStreamIndex = parsedAudio;
                    state.currentAudioTrack = parsedAudio;
                    globalThis.__jfP2PAudioTrack = parsedAudio;
                }
                const parsedCont = getParamCaseInsensitive(sp, "SegmentContainer");
                if (parsedCont) segContainer = parsedCont.toLowerCase();

                const rawVidBitrate = Number(getParamCaseInsensitive(sp, "VideoBitrate")) ||
                                      Number(getParamCaseInsensitive(sp, "maxStreamingBitrate")) || 0;
                if (rawVidBitrate > 0) {
                    qualityTier =
                        rawVidBitrate >= 80000000
                            ? "max"
                            : `${Math.round(rawVidBitrate / 1000000)}m`;
                }
            } catch {}
        }

        currentQualityTier = qualityTier;
        state.currentQuality = qualityTier;
        globalThis.__jfP2PQuality = qualityTier;

        return `|a:${audioIdx}|c:${segContainer}|q:${qualityTier}`;
    }

    // -------------------------------------------------------------------------
    // P2P Media Loader v4 ESM Loader & Runtime Patching
    // -------------------------------------------------------------------------
    async function loadP2PHlsModule() {
        console.debug("[P2P-Engine] Loading & patching P2P Media Loader v4 ESM engine...");
        const [coreResp, hlsJsResp] = await Promise.all([
            fetch(CORE_ESM_URL),
            fetch(HLSJS_ESM_URL)
        ]);
        if (!coreResp.ok) throw new Error(`Failed to fetch ${CORE_ESM_URL}: HTTP ${coreResp.status}`);
        if (!hlsJsResp.ok) throw new Error(`Failed to fetch ${HLSJS_ESM_URL}: HTTP ${hlsJsResp.status}`);

        let coreCode = await coreResp.text();
        let hlsJsCode = await hlsJsResp.text();

        // Fix 1: Eliminate "dispatchStorageUpdatedEvent is not set" unhandled crash
        coreCode = coreCode.replaceAll(
            'throw Error("dispatchStorageUpdatedEvent is not set")',
            'return'
        );
        coreCode = coreCode.replaceAll(
            'this.segmentChangeCallback(t);',
            'this.segmentChangeCallback?.(t);'
        );

        // Fix 2: Prevent premature peer disconnection on transient ICE 'disconnected' state
        coreCode = coreCode.replace(
            'e === "failed" || e === "closed" || e === "disconnected"',
            'e === "failed" || e === "closed"'
        );

        // Fix 4: Force P2P Core to adopt unified client Peer ID across both Lobby and Video Swarms
        coreCode = coreCode.replace(
            /function\s+Gt\s*\(\s*e\s*\)\s*\{/,
            'function Gt(e) { if (globalThis.__jfP2PLocalPeerId) return globalThis.__jfP2PLocalPeerId; '
        );
        coreCode = coreCode.replace(
            'this.peerId = Gt(this.commonCoreConfig.trackerClientVersionPrefix)',
            'this.peerId = (globalThis.__jfP2PLocalPeerId || Gt(this.commonCoreConfig.trackerClientVersionPrefix))'
        );

        // Fix 5: Pass local username, browser, audio, and quality metadata in Core WebTorrent tracker announce
        coreCode = coreCode.replaceAll(
            'peer_id: this.#n.peerId,',
            'peer_id: this.#n.peerId, userName: (globalThis.__jfP2PUserName || null), browser: (globalThis.__jfP2PBrowser || null), audioTrack: (globalThis.__jfP2PAudioTrack || null), quality: (globalThis.__jfP2PQuality || null),'
        );

        // Fix 3: Neutralize hlsMediaAttaching & hlsManifestLoading from killing the P2P core on media error recovery
        let patchedHlsJs = hlsJsCode
            .replace('t[n]("hlsMediaAttaching", this.destroyCore)', 'void 0 /* no-op on media reattach */')
            .replace('t[n]("hlsManifestLoading", this.destroyCore)', 'void 0 /* no-op on manifest reload */');

        const coreBlob = new Blob([coreCode], { type: "text/javascript" });
        const coreBlobUrl = URL.createObjectURL(coreBlob);

        const rewrittenHlsJs = patchedHlsJs.replace(/(["'])p2p-media-loader-core\1/g, `"${coreBlobUrl}"`);
        const hlsJsBlob = new Blob([rewrittenHlsJs], { type: "text/javascript" });
        const hlsJsBlobUrl = URL.createObjectURL(hlsJsBlob);

        return await import(hlsJsBlobUrl);
    }

    // -------------------------------------------------------------------------
    // Hls.js Wrapping & Integration
    // -------------------------------------------------------------------------
    (async function initP2PHls() {
        try {
            const { HlsJsP2PEngine } = await loadP2PHlsModule();
            if (!HlsJsP2PEngine) {
                console.warn("[P2P-Engine] HlsJsP2PEngine not found in loaded module.");
                return;
            }

            console.log(
                `%c[P2P-Engine] P2P Media Loader v4 ready! Global Lobby + PEX active. Tracker: ${PRIVATE_TRACKER_URL}`,
                "color: #00dc82; font-weight: bold;"
            );

            // Connect to Global Lobby Tracker immediately
            connectGlobalLobbyTracker();

            const wrappedClasses = new WeakMap();
            const wrapHls = (OriginalHls) => {
                if (!OriginalHls || OriginalHls.__p2pWrapped) return OriginalHls;
                if (wrappedClasses.has(OriginalHls)) return wrappedClasses.get(OriginalHls);

                const HlsWithP2P = HlsJsP2PEngine.injectMixin(OriginalHls);

                class JellyfinP2PHls extends HlsWithP2P {
                    constructor(userConfig = {}) {
                        let activeManifestUrl = "";
                        refreshLocalUserName();

                        // Reset stream state
                        state.streamActive = true;
                        state.p2pDownBytes = 0;
                        state.httpDownBytes = 0;
                        state.p2pUpBytes = 0;
                        chunks.clear();
                        fragTiming.clear();
                        state.lowestChunkNum = null;
                        state.highestChunkNum = null;
                        state.selectedChunkNum = null;

                        const mergedConfig = {
                            ...userConfig,
                            maxBufferLength: 75,
                            maxMaxBufferLength: 90,
                            backBufferLength: 90,
                            p2p: {
                                core: {
                                    announceTrackers: [PRIVATE_TRACKER_URL],
                                    simultaneousHttpDownloads: 1,       // Protect 55 Mbps server line from division
                                    simultaneousP2PDownloads: 4,        // Download up to 4 chunks in parallel from mesh
                                    highDemandTimeWindow: 5,            // Only immediate 5s use HTTP; forward buffer (5-90s) is 100% P2P!
                                    httpDownloadInitialTimeoutMs: 1500, // 1.5s P2P head start before falling back to server
                                    httpDownloadTimeWindow: 4000,
                                    p2pDownloadTimeWindow: 10000,
                                    p2pNotReceivingBytesTimeoutMs: 20000, // 20s timeout ensures home Wi-Fi jitter never drops connection
                                    httpNotReceivingBytesTimeoutMs: 8000,
                                    p2pErrorRetries: 8,                 // 8 strikes before closing a peer
                                    p2pInactiveLoaderDestroyTimeoutMs: 1800000, // 30 mins: Never drop peers during movie pause
                                    p2pChurnGracePeriodMs: 60000,
                                    p2pChurnCleanupIntervalMs: 45000,
                                    webRtcConnectionTimeoutMs: 25000,
                                    webRtcOfferTimeoutMs: 50000,
                                    webRtcIceGatheringTimeoutMs: 5000,
                                    isP2PUploadDisabled: IS_LOCAL_HOST,  // Localhost only observes; remote friends seed
                                    isP2PDisabled: IS_LOCAL_HOST,        // Localhost plays via direct server stream
                                    streamSwarmIdBuilder: (params, maybeStreamType) => {
                                        let rawDefault = "";
                                        let streamType = "";
                                        if (typeof params === "object" && params !== null) {
                                            rawDefault =
                                                params.defaultStreamSwarmId ||
                                                params.streamSwarmId ||
                                                params.swarmId ||
                                                "";
                                            streamType = params.streamType || params.streamDetails?.type || "";
                                        } else if (typeof params === "string") {
                                            rawDefault = params;
                                            streamType = typeof maybeStreamType === "string" ? maybeStreamType : "";
                                        }

                                        const itemId =
                                            extractJellyfinItemId(activeManifestUrl) ||
                                            extractJellyfinItemId(rawDefault) ||
                                            extractJellyfinItemId(location?.href) ||
                                            "jellyfin-stream";
                                        const typeTag = streamType === "secondary" ? "|t:secondary" : "|t:main";
                                        const suffix = buildJellyfinSwarmSuffix(activeManifestUrl, rawDefault);
                                        const swarmId = `jellyfin-${itemId}${typeTag}${suffix}`;

                                        const prevSwarm = currentMovieSwarmId;
                                        currentMovieSwarmId = swarmId;
                                        currentMovieItemId = itemId;

                                        if (prevSwarm && prevSwarm !== swarmId) {
                                            console.log(
                                                `%c[P2P-Engine] Swarm Migrated (Audio/Quality switch): ${prevSwarm} -> ${swarmId}`,
                                                "color: #ffaa00; font-weight: bold;"
                                            );
                                        } else {
                                            console.log(
                                                `%c[P2P-Engine] Swarm ID: ${swarmId}`,
                                                "color: #d980fa; font-weight: bold;"
                                            );
                                        }

                                        broadcastLobbyPresence();
                                        sendTelemetry();
                                        return swarmId;
                                    },
                                    rtcConfig: {
                                        iceServers: [
                                            { urls: "stun:stun.l.google.com:19302" },
                                            { urls: "stun:stun1.l.google.com:19302" },
                                            { urls: "stun:global.stun.twilio.com:3478" }
                                        ]
                                    },
                                    ...(userConfig.p2p?.core || {})
                                },
                                onHlsJsCreated(hls) {
                                    hls.p2pEngine.addEventListener("onPeerConnect", (params) => {
                                        const p = getOrCreatePeer(params?.peerId);
                                        p.connected = true;
                                        p.inHlsSwarm = true;
                                        const known = peerIdentities.get(params?.peerId);
                                        if (known?.userName) {
                                            p.userName = known.userName;
                                            p.browser = known.browser || p.browser;
                                        }
                                        broadcastLobbyPresence();
                                        emit("peer-connected", p);
                                        emit("stats-updated", getStats());
                                    });

                                    hls.p2pEngine.addEventListener("onPeerClose", (params) => {
                                        const p = getOrCreatePeer(params?.peerId);
                                        p.connected = false;
                                        p.inHlsSwarm = false;
                                        emit("peer-disconnected", p);
                                        emit("stats-updated", getStats());
                                    });

                                    hls.p2pEngine.addEventListener("onChunkDownloaded", (arg1, arg2, arg3) => {
                                        const isObj = arg1 && typeof arg1 === "object";
                                        const bytes = isObj ? Number(arg1.bytesLength) || 0 : Number(arg1) || 0;
                                        const source = isObj ? arg1.downloadSource : arg2;
                                        const peerId = isObj ? arg1.peerId : arg3;
                                        if (source === "p2p" && peerId) {
                                            const p = getOrCreatePeer(peerId);
                                            p.bytesFrom += bytes;
                                            p.inHlsSwarm = true;
                                        }
                                    });

                                    hls.p2pEngine.addEventListener("onChunkUploaded", (arg1, arg2) => {
                                        const isObj = arg1 && typeof arg1 === "object";
                                        const bytes = isObj ? Number(arg1.bytesLength) || 0 : Number(arg1) || 0;
                                        const peerId = isObj ? arg1.peerId : arg2;
                                        state.p2pUpBytes += bytes;
                                        if (peerId) {
                                            const p = getOrCreatePeer(peerId);
                                            p.bytesTo += bytes;
                                            p.inHlsSwarm = true;
                                        }
                                        emit("chunk-uploaded", { peerId, bytes, totalSeededBytes: state.p2pUpBytes });
                                        emit("stats-updated", getStats());
                                    });

                                    hls.p2pEngine.addEventListener("onSegmentLoaded", (details) => {
                                        const bytes = details?.bytesLength || 0;
                                        const sizeMB = (bytes / 1048576).toFixed(1);
                                        const rawSeq = details?.segment?.externalId ?? details?.segment?.runtimeId ?? 0;
                                        const seqNum = Number.isFinite(Number(rawSeq)) ? Number(rawSeq) : chunks.size;

                                        const fragMeta = fragTiming.get(seqNum);
                                        const startSec = fragMeta ? fragMeta.startSec : seqNum * state.avgChunkDurationSec;
                                        const endSec = fragMeta ? fragMeta.endSec : (seqNum + 1) * state.avgChunkDurationSec;

                                        if (state.lowestChunkNum === null || seqNum < state.lowestChunkNum) {
                                            state.lowestChunkNum = seqNum;
                                        }
                                        if (state.highestChunkNum === null || seqNum > state.highestChunkNum) {
                                            state.highestChunkNum = seqNum;
                                        }

                                        const isP2P = details?.downloadSource === "p2p";
                                        if (isP2P) {
                                            state.p2pDownBytes += bytes;
                                            const p = details?.peerId ? getOrCreatePeer(details.peerId) : null;
                                            if (p) { p.segmentsFrom += 1; p.inHlsSwarm = true; }
                                        } else {
                                            state.httpDownBytes += bytes;
                                        }

                                        const chunkObj = {
                                            num: seqNum,
                                            sourceType: isP2P ? "p2p" : "http",
                                            peerId: details?.peerId || null,
                                            sizeMB,
                                            startSec,
                                            endSec,
                                            durationMs: fragMeta?.durationMs || null
                                        };
                                        chunks.set(seqNum, chunkObj);

                                        emit("segment-loaded", chunkObj);
                                        emit("stats-updated", getStats());
                                        sendTelemetry();
                                    });
                                }
                            }
                        };

                        super(mergedConfig);

                        this.__setP2PManifestUrl = (url) => {
                            activeManifestUrl = typeof url === "string" ? url : "";
                            try {
                                const sp = new URL(activeManifestUrl, location.origin).searchParams;
                                const aIdx = getParamCaseInsensitive(sp, "AudioStreamIndex");
                                if (aIdx !== null) {
                                    currentAudioStreamIndex = String(aIdx);
                                    state.currentAudioTrack = currentAudioStreamIndex;
                                    globalThis.__jfP2PAudioTrack = currentAudioStreamIndex;
                                }
                                const rawVidBitrate = Number(getParamCaseInsensitive(sp, "VideoBitrate")) ||
                                                      Number(getParamCaseInsensitive(sp, "maxStreamingBitrate")) || 0;
                                if (rawVidBitrate > 0) {
                                    const qTier = rawVidBitrate >= 80000000 ? "max" : `${Math.round(rawVidBitrate / 1000000)}m`;
                                    currentQualityTier = qTier;
                                    state.currentQuality = qTier;
                                    globalThis.__jfP2PQuality = qTier;
                                }
                            } catch {}
                        };

                        if (OriginalHls.Events) {
                            if (OriginalHls.Events.FRAG_LOADED) {
                                this.on(OriginalHls.Events.FRAG_LOADED, (event, data) => {
                                    const frag = data?.frag;
                                    if (!frag || typeof frag.sn !== "number") return;
                                    const startSec = Number(frag.start) || 0;
                                    const durSec = Number(frag.duration) || 4;
                                    if (durSec > 0.5 && durSec < 30) {
                                        state.avgChunkDurationSec = durSec;
                                    }
                                    const stats = frag.stats?.loading;
                                    const durationMs =
                                        stats && stats.end > stats.start ? Math.round(stats.end - stats.start) : null;
                                    fragTiming.set(frag.sn, {
                                        startSec,
                                        endSec: startSec + durSec,
                                        durationMs
                                    });
                                });
                            }

                            if (OriginalHls.Events.AUDIO_TRACK_SWITCHED) {
                                this.on(OriginalHls.Events.AUDIO_TRACK_SWITCHED, (ev, data) => {
                                    console.log(`%c[P2P-Engine] Audio track switched event -> track index: ${data?.id}`, "color: #d980fa; font-weight: bold;");
                                    if (data?.id !== undefined) {
                                        currentAudioStreamIndex = String(data.id);
                                        state.currentAudioTrack = currentAudioStreamIndex;
                                        globalThis.__jfP2PAudioTrack = currentAudioStreamIndex;
                                        broadcastLobbyPresence();
                                        sendTelemetry();
                                    }
                                });
                            }

                            if (OriginalHls.Events.LEVEL_SWITCHED) {
                                this.on(OriginalHls.Events.LEVEL_SWITCHED, (ev, data) => {
                                    const lvl = this.levels?.[data?.level];
                                    if (lvl?.bitrate) {
                                        const b = lvl.bitrate;
                                        const qTier = b >= 80000000 ? "max" : `${Math.round(b / 1000000)}m`;
                                        if (qTier !== currentQualityTier) {
                                            currentQualityTier = qTier;
                                            state.currentQuality = qTier;
                                            globalThis.__jfP2PQuality = qTier;
                                            console.log(`%c[P2P-Engine] Quality Level Switched -> ${qTier}`, "color: #38bdf8; font-weight: bold;");
                                            broadcastLobbyPresence();
                                            sendTelemetry();
                                        }
                                    }
                                });
                            }
                        }
                    }

                    loadSource(url) {
                        if (typeof this.__setP2PManifestUrl === "function") {
                            this.__setP2PManifestUrl(url);
                        }
                        return super.loadSource(url);
                    }
                }

                Object.defineProperty(JellyfinP2PHls, "__p2pWrapped", { value: true });
                wrappedClasses.set(OriginalHls, JellyfinP2PHls);
                return JellyfinP2PHls;
            };

            // Hook Hls globally
            if (global.Hls) {
                global.Hls = wrapHls(global.Hls);
            }
            let originalHlsProp = global.Hls;
            Object.defineProperty(global, "Hls", {
                configurable: true,
                enumerable: true,
                get: () => originalHlsProp,
                set: (v) => {
                    originalHlsProp = wrapHls(v);
                }
            });

        } catch (err) {
            console.error("[P2P-Engine] Failed to initialize P2P v4 loader:", err);
        }
    })();

    // -------------------------------------------------------------------------
    // Telemetry Sync Loop
    // -------------------------------------------------------------------------
    function sendTelemetry() {
        if (!activeTrackerWs || activeTrackerWs.readyState !== WebSocket.OPEN) return;

        const targetSwarm = currentMovieSwarmId || GLOBAL_LOBBY_HASH;
        if (!targetSwarm) return;

        const videoEl = document.querySelector("video");
        const curTime = videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : null;
        let playingChunk = null;
        if (curTime !== null) {
            for (const [sn, meta] of fragTiming.entries()) {
                if (curTime >= meta.startSec && curTime < meta.endSec) {
                    playingChunk = sn;
                    break;
                }
            }
            if (playingChunk === null && chunks.size > 0 && state.avgChunkDurationSec > 0) {
                playingChunk = Math.floor(curTime / state.avgChunkDurationSec);
            }
        }
        state.playingChunk = playingChunk;
        state.currentTime = curTime || 0;

        const chunkList = [];
        for (const [sn, c] of chunks.entries()) {
            chunkList.push({
                num: sn,
                sourceType: c.sourceType,
                peerId: c.peerId || null,
                sizeMB: c.sizeMB
            });
        }
        chunkList.sort((a, b) => a.num - b.num);

        const name = localUserName || (IS_LOCAL_HOST ? "Host" : "Friend");
        const payload = JSON.stringify({
            action: "telemetry",
            info_hash: targetSwarm,
            swarmId: currentMovieSwarmId,
            peer_id: localPeerId,
            userName: name,
            browser: detectBrowserLabel(),
            playingChunk,
            audioTrack: currentAudioStreamIndex,
            quality: currentQualityTier,
            chunks: chunkList.slice(-64),
            p2pDownBytes: state.p2pDownBytes,
            httpDownBytes: state.httpDownBytes,
            p2pUpBytes: state.p2pUpBytes
        });

        try { activeTrackerWs.send(payload); } catch {}
    }
    setInterval(sendTelemetry, TELEMETRY_INTERVAL_MS);

    // -------------------------------------------------------------------------
    // Public Statistics & API
    // -------------------------------------------------------------------------
    function getStats() {
        const total = state.p2pDownBytes + state.httpDownBytes;
        const offloadPct = total > 0 ? ((state.p2pDownBytes / total) * 100).toFixed(1) : "0.0";
        const activeNames = new Set();
        let activeUnnamed = 0;
        const myName = (localUserName || "").toLowerCase().trim();
        for (const p of peers.values()) {
            if (!p.connected) continue;
            if (localPeerId && p.peerId === localPeerId) continue;
            const isNamed = p.userName && 
                !p.userName.startsWith("Peer ") && 
                !p.userName.startsWith("Peer-") && 
                !p.userName.startsWith("Peer -");
            if (isNamed) {
                const norm = p.userName.toLowerCase().trim();
                if (norm && norm !== myName) activeNames.add(norm);
            } else {
                activeUnnamed++;
            }
        }
        const activePeers = activeNames.size > 0 ? activeNames.size : activeUnnamed;
        return {
            isLocalHost: IS_LOCAL_HOST,
            offloadPct,
            p2pDownMB: (state.p2pDownBytes / 1048576).toFixed(1),
            httpDownMB: (state.httpDownBytes / 1048576).toFixed(1),
            p2pUpMB: (state.p2pUpBytes / 1048576).toFixed(1),
            activePeers,
            totalPeers: activePeers,
            playingChunk: state.playingChunk,
            currentAudioTrack: currentAudioStreamIndex,
            currentQuality: currentQualityTier,
            currentMovieItemId: currentMovieItemId,
            currentSwarmId: currentMovieSwarmId,
            lowestChunkNum: state.lowestChunkNum,
            highestChunkNum: state.highestChunkNum
        };
    }

    // Expose clean Public Engine API
    global.JellyfinP2P = {
        version: "2.1.0-audio-names-fix",
        on,
        off,
        emit,
        getStats,
        getState: () => ({ ...state }),
        getPeers: () => Array.from(peers.values()),
        getChunks: () => Array.from(chunks.values()),
        getLocalIdentity: () => ({
            peerId: localPeerId,
            peerShort: localPeerShort,
            userName: localUserName
        })
    };

})(window);


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
