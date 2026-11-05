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
