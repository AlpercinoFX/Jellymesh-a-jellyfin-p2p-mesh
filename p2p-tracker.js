// == Jellyfin Private WebRTC / WebTorrent Signaling Tracker ==
// Zero external dependencies (pure built-in Node.js http + crypto).
// Listens on 127.0.0.1:8000 and is proxied privately via Caddy at wss://your-domain.com/tracker

"use strict";

const http = require("http");
const crypto = require("crypto");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8000;
const ANNOUNCE_INTERVAL_SEC = 15; // Fast 15s refresh for private friends mesh
const PING_INTERVAL_MS = 20000;
const CLIENT_TIMEOUT_MS = 120000; // 2 min grace period for pausing/seeking/buffering
const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MB safety cap per socket
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// info_hash (binary string) -> Map<peer_id, Client>
const swarms = new Map();
const clients = new Set();
const startedAt = Date.now();

// info_hash -> Map<peer_id, { peerId, userName, browser, playingChunk, chunks, p2pDownBytes, httpDownBytes, p2pUpBytes, updatedAt }>
const swarmTelemetry = new Map();

function shortenId(id) {
    const s = String(id || "?");
    return s.length > 12 ? `${s.slice(0, 6)}..${s.slice(-4)}` : s;
}

function parseAudioAndQuality(str) {
    if (!str || typeof str !== "string") return { audio: null, quality: null };
    const aMatch = str.match(/\|a:([^|]+)/);
    const qMatch = str.match(/\|q:([^|]+)/);
    return {
        audio: aMatch ? aMatch[1] : null,
        quality: qMatch ? qMatch[1] : null
    };
}

function formatAudioLabel(a) {
    if (a === null || a === undefined || a === "" || a === "def") return "Track #0";
    return `Track #${a}`;
}

function formatQualityLabel(q) {
    if (!q || q === "max" || q === "MAX") return "Max";
    if (typeof q === "string" && q.endsWith("m")) {
        return `${q.slice(0, -1).toUpperCase()} Mbps`;
    }
    if (typeof q === "string" && q.endsWith("k")) {
        return `${q.slice(0, -1)} Kbps`;
    }
    return String(q);
}

function hashHexPreview(binHash) {
    return Buffer.from(String(binHash || ""), "latin1").toString("hex").slice(0, 10);
}

function encodeWsFrame(opcode, payloadBuf) {
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
        header = Buffer.allocUnsafe(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return len > 0 ? Buffer.concat([header, payloadBuf]) : header;
}

function sendJson(client, obj) {
    if (!client || client.closed || !client.socket.writable) return;
    try {
        const payload = Buffer.from(JSON.stringify(obj), "utf8");
        client.socket.write(encodeWsFrame(0x01, payload));
    } catch {
        cleanupClient(client);
    }
}

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function removeClientFromSwarm(client, infoHash) {
    const swarm = swarms.get(infoHash);
    if (!swarm) return;
    if (client.peerId && swarm.get(client.peerId) === client) {
        swarm.delete(client.peerId);
    } else {
        for (const [pid, c] of swarm.entries()) {
            if (c === client) swarm.delete(pid);
        }
    }
    if (swarmTelemetry.has(infoHash) && client.peerId) {
        swarmTelemetry.get(infoHash).delete(client.peerId);
    }
    if (swarm.size === 0) {
        swarms.delete(infoHash);
        swarmTelemetry.delete(infoHash);
    }
    client.infoHashes.delete(infoHash);
}

function cleanupClient(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    for (const infoHash of Array.from(client.infoHashes)) {
        removeClientFromSwarm(client, infoHash);
    }
    try {
        client.socket.destroy();
    } catch {
        // Ignore
    }
}

function handleTrackerMessage(client, rawText) {
    let msg;
    try {
        msg = JSON.parse(rawText);
    } catch {
        return;
    }
    if (!msg || typeof msg !== "object") return;

    const action = msg.action;
    if (action === "scrape") {
        sendJson(client, {
            action: "scrape",
            files: {},
            flags: { min_request_interval: ANNOUNCE_INTERVAL_SEC }
        });
        return;
    }

    if (action === "telemetry") {
        const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : null;
        const peerId = typeof msg.peer_id === "string" ? msg.peer_id : client.peerId;
        if (!infoHash || !peerId) return;

        const parsed = parseAudioAndQuality(infoHash);
        const resolvedAudio = msg.audioTrack !== undefined && msg.audioTrack !== null ? String(msg.audioTrack) : (parsed.audio || client.audioTrack || null);
        const resolvedQuality = msg.quality !== undefined && msg.quality !== null ? String(msg.quality) : (parsed.quality || client.quality || null);

        let st = swarmTelemetry.get(infoHash);
        if (!st) {
            st = new Map();
            swarmTelemetry.set(infoHash, st);
        }
        const existingSt = st.get(peerId);
        st.set(peerId, {
            peerId,
            userName: String(msg.userName || client.userName || "Friend").slice(0, 32),
            browser: String(msg.browser || client.browser || "Browser").slice(0, 32),
            swarmId: typeof msg.swarmId === "string" ? msg.swarmId : (existingSt?.swarmId || null),
            audioTrack: resolvedAudio,
            quality: resolvedQuality,
            playingChunk: Number.isFinite(msg.playingChunk) ? msg.playingChunk : null,
            chunks: Array.isArray(msg.chunks) ? msg.chunks.slice(-64) : [],
            p2pDownBytes: Number(msg.p2pDownBytes) || 0,
            httpDownBytes: Number(msg.httpDownBytes) || 0,
            p2pUpBytes: Number(msg.p2pUpBytes) || 0,
            updatedAt: Date.now()
        });

        if (msg.userName) client.userName = String(msg.userName);
        if (msg.browser) client.browser = String(msg.browser);
        if (resolvedAudio) client.audioTrack = resolvedAudio;
        if (resolvedQuality) client.quality = resolvedQuality;
        return;
    }

    if (action !== "announce") return;

    const infoHash = typeof msg.info_hash === "string" ? msg.info_hash : null;
    const peerId = typeof msg.peer_id === "string" ? msg.peer_id : null;
    if (!infoHash || !peerId || infoHash.length > 64 || peerId.length > 64) return;

    if (client.peerId && client.peerId !== peerId) {
        // Peer changed ID on this socket -> clean old registrations
        for (const ih of Array.from(client.infoHashes)) {
            removeClientFromSwarm(client, ih);
        }
    }
    client.peerId = peerId;

    let st = swarmTelemetry.get(infoHash);
    if (!st) {
        st = new Map();
        swarmTelemetry.set(infoHash, st);
    }
    const existingSt = st.get(peerId);
    const resolvedName = (typeof msg.userName === "string" && msg.userName && !msg.userName.startsWith("Peer "))
        ? msg.userName
        : (existingSt?.userName || client.userName || ("Peer " + shortenId(peerId)));
    const resolvedBrowser = (typeof msg.browser === "string" && msg.browser)
        ? msg.browser
        : (existingSt?.browser || client.browser || "Browser");

    const parsedAnn = parseAudioAndQuality(infoHash);
    const resolvedAudio = msg.audioTrack !== undefined && msg.audioTrack !== null
        ? String(msg.audioTrack)
        : (parsedAnn.audio || existingSt?.audioTrack || client.audioTrack || null);
    const resolvedQuality = msg.quality !== undefined && msg.quality !== null
        ? String(msg.quality)
        : (parsedAnn.quality || existingSt?.quality || client.quality || null);

    client.userName = resolvedName;
    client.browser = resolvedBrowser;

    const isLobby = infoHash.toLowerCase().includes("lobby") || infoHash === "6a662d6c6f6262792d7631303030303030303030";

    if (!existingSt) {
        st.set(peerId, {
            peerId,
            userName: resolvedName,
            browser: resolvedBrowser,
            swarmId: typeof msg.swarmId === "string" ? msg.swarmId : (existingSt?.swarmId || null),
            audioTrack: resolvedAudio,
            quality: resolvedQuality,
            playingChunk: null,
            chunks: [],
            p2pDownBytes: 0,
            httpDownBytes: 0,
            p2pUpBytes: 0,
            updatedAt: Date.now()
        });
    } else {
        if (typeof msg.userName === "string" && msg.userName && !msg.userName.startsWith("Peer ")) {
            existingSt.userName = msg.userName;
        }
        if (typeof msg.browser === "string" && msg.browser) {
            existingSt.browser = msg.browser;
        }
        if (resolvedAudio) existingSt.audioTrack = resolvedAudio;
        if (resolvedQuality) existingSt.quality = resolvedQuality;
        existingSt.updatedAt = Date.now();
    }

    if (msg.event === "stopped") {
        removeClientFromSwarm(client, infoHash);
        const remaining = swarms.get(infoHash)?.size || 0;
        const metaStr = isLobby ? "" : ` [${formatAudioLabel(resolvedAudio)} • ${formatQualityLabel(resolvedQuality)}]`;
        console.log(
            `[Tracker] Peer ${resolvedName} (${resolvedBrowser})${metaStr} left swarm ${hashHexPreview(infoHash)} (Active: ${remaining})`
        );
        sendJson(client, {
            action: "announce",
            interval: ANNOUNCE_INTERVAL_SEC,
            info_hash: infoHash,
            complete: remaining,
            incomplete: 0
        });
        return;
    }

    let swarm = swarms.get(infoHash);
    if (!swarm) {
        swarm = new Map();
        swarms.set(infoHash, swarm);
    }

    // Swarm Switching Detection: If client was in another video swarm (e.g. different audio track or movie),
    // cleanly remove them from the old video swarm and log the audio/stream transition in tracker CLI.
    if (!isLobby) {
        for (const oldHash of Array.from(client.infoHashes)) {
            const oldIsLobby = oldHash.toLowerCase().includes("lobby") || oldHash === "6a662d6c6f6262792d7631303030303030303030";
            if (!oldIsLobby && oldHash !== infoHash) {
                removeClientFromSwarm(client, oldHash);
                const remainingOld = swarms.get(oldHash)?.size || 0;
                const oldAudioStr = formatAudioLabel(client.audioTrack);
                const oldQualStr = formatQualityLabel(client.quality);
                const newAudioStr = formatAudioLabel(resolvedAudio);
                const newQualStr = formatQualityLabel(resolvedQuality);
                console.log(
                    `[Tracker] Peer ${resolvedName} (${resolvedBrowser}) switched swarm: [${oldAudioStr} • ${oldQualStr}] -> [${newAudioStr} • ${newQualStr}] (Swarm: ${hashHexPreview(oldHash)} -> ${hashHexPreview(infoHash)}) (Active in new: ${swarm.size + 1}, Remaining in old: ${remainingOld})`
                );
            }
        }
        if (resolvedAudio) client.audioTrack = resolvedAudio;
        if (resolvedQuality) client.quality = resolvedQuality;
    }

    const isNewInSwarm = swarm.get(peerId) !== client;
    swarm.set(peerId, client);
    client.infoHashes.add(infoHash);

    if (isNewInSwarm) {
        const metaStr = isLobby ? " (Global Lobby)" : ` [${formatAudioLabel(resolvedAudio)} • ${formatQualityLabel(resolvedQuality)}]`;
        console.log(
            `[Tracker] Peer ${resolvedName} (${resolvedBrowser})${metaStr} joined swarm ${hashHexPreview(infoHash)} (Active: ${swarm.size})`
        );
    }

    // Case 1: Forwarding an SDP Answer back to the offering peer
    if (msg.answer && typeof msg.to_peer_id === "string" && msg.offer_id) {
        const targetClient = swarm.get(msg.to_peer_id);
        if (targetClient && targetClient !== client && !targetClient.closed) {
            sendJson(targetClient, {
                action: "announce",
                info_hash: infoHash,
                peer_id: peerId,
                offer_id: msg.offer_id,
                answer: msg.answer
            });
        }
        return;
    }

    // Case 2: Standard announce (initial / started / periodic update)
    sendJson(client, {
        action: "announce",
        interval: ANNOUNCE_INTERVAL_SEC,
        info_hash: infoHash,
        complete: swarm.size,
        incomplete: 0
    });

    const otherClients = [];
    for (const [otherPeerId, otherClient] of swarm.entries()) {
        if (otherPeerId !== peerId && otherClient !== client && !otherClient.closed) {
            otherClients.push(otherClient);
        }
    }
    if (otherClients.length === 0) return;

    shuffleInPlace(otherClients);

    if (Array.isArray(msg.offers) && msg.offers.length > 0) {
        const count = Math.min(msg.offers.length, otherClients.length);
        for (let i = 0; i < count; i++) {
            const item = msg.offers[i];
            if (!item || !item.offer || !item.offer_id) continue;
            sendJson(otherClients[i], {
                action: "announce",
                info_hash: infoHash,
                peer_id: peerId,
                offer_id: item.offer_id,
                offer: item.offer
            });
        }
    } else if (isNewInSwarm) {
        // New/reconnected peer joined without initial offers -> nudge existing peers to send offers within 2s!
        for (const other of otherClients) {
            sendJson(other, {
                action: "announce",
                interval: 2,
                info_hash: infoHash,
                complete: swarm.size,
                incomplete: 0
            });
        }
    }
}

function processSocketBuffer(client) {
    while (!client.closed && client.buffer.length >= 2) {
        const b0 = client.buffer[0];
        const b1 = client.buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (!masked) {
            // Per RFC 6455, client-to-server frames must be masked
            cleanupClient(client);
            return;
        }

        if (payloadLen === 126) {
            if (client.buffer.length < 4) return;
            payloadLen = client.buffer.readUInt16BE(2);
            offset = 4;
        } else if (payloadLen === 127) {
            if (client.buffer.length < 10) return;
            const bigLen = client.buffer.readBigUInt64BE(2);
            if (bigLen > BigInt(MAX_BUFFER_BYTES)) {
                cleanupClient(client);
                return;
            }
            payloadLen = Number(bigLen);
            offset = 10;
        }

        const totalFrameBytes = offset + 4 + payloadLen;
        if (totalFrameBytes > MAX_BUFFER_BYTES) {
            cleanupClient(client);
            return;
        }
        if (client.buffer.length < totalFrameBytes) {
            // Wait for remaining TCP chunks of this WebSocket frame
            return;
        }

        const maskKey = client.buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(client.buffer.subarray(offset + 4, totalFrameBytes));
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
        }

        client.buffer = client.buffer.subarray(totalFrameBytes);
        client.lastSeen = Date.now();

        // Handle RFC 6455 control frames first (can be interleaved between fragments)
        if (opcode === 0x08) {
            // Close
            try {
                if (client.socket.writable) {
                    client.socket.write(encodeWsFrame(0x08, Buffer.alloc(0)));
                }
            } catch {}
            cleanupClient(client);
            return;
        }
        if (opcode === 0x09) {
            // Ping -> Pong
            if (client.socket.writable) {
                try {
                    client.socket.write(encodeWsFrame(0x0a, payload));
                } catch {}
            }
            continue;
        }
        if (opcode === 0x0a) {
            // Pong
            continue;
        }

        // Data frames (0x01 text, 0x02 binary, 0x00 continuation)
        if (opcode === 0x01 || opcode === 0x02) {
            client.fragments = [payload];
            client.fragmentBytes = payload.length;
        } else if (opcode === 0x00 && client.fragments) {
            client.fragmentBytes += payload.length;
            if (client.fragmentBytes > MAX_BUFFER_BYTES) {
                cleanupClient(client);
                return;
            }
            client.fragments.push(payload);
        } else {
            continue;
        }

        if (fin && client.fragments) {
            const fullBuf =
                client.fragments.length === 1
                    ? client.fragments[0]
                    : Buffer.concat(client.fragments, client.fragmentBytes);
            client.fragments = null;
            client.fragmentBytes = 0;
            handleTrackerMessage(client, fullBuf.toString("utf8"));
        }
    }
}

const server = http.createServer((req, res) => {
    const url = req.url || "/";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    if (url.includes("telemetry")) {
        const swarmsData = [];
        const now = Date.now();
        for (const [infoHash, peerMap] of swarmTelemetry.entries()) {
            const peersData = [];
            for (const [peerId, t] of peerMap.entries()) {
                // If telemetry is older than 2 minutes, peer might be gone or paused
                if (now - t.updatedAt > 120000) {
                    peerMap.delete(peerId);
                    continue;
                }
                peersData.push(t);
            }
            if (peersData.length > 0) {
                swarmsData.push({
                    infoHashHex: Buffer.from(infoHash, "latin1").toString("hex"),
                    infoHashPreview: hashHexPreview(infoHash),
                    peerCount: peersData.length,
                    peers: peersData
                });
            }
        }

        const body = JSON.stringify({
            ok: true,
            activeSwarms: swarms.size,
            connectedPeers: clients.size,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            swarms: swarmsData
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
        return;
    }

    const body = JSON.stringify({
        ok: true,
        tracker: "Jellyfin Private P2P Tracker",
        activeSwarms: swarms.size,
        connectedPeers: clients.size,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000)
    });
    res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
    });
    res.end(body);
});

server.on("upgrade", (req, socket) => {
    const upgradeHeader = String(req.headers.upgrade || "").toLowerCase();
    const key = req.headers["sec-websocket-key"];
    if (upgradeHeader !== "websocket" || typeof key !== "string" || !key) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
    }

    const accept = crypto
        .createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");

    socket.setNoDelay(true);
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const client = {
        socket,
        peerId: null,
        infoHashes: new Set(),
        buffer: Buffer.alloc(0),
        fragments: null,
        fragmentBytes: 0,
        lastSeen: Date.now(),
        closed: false
    };
    clients.add(client);

    socket.on("data", (chunk) => {
        if (client.closed) return;
        if (client.buffer.length + chunk.length > MAX_BUFFER_BYTES) {
            cleanupClient(client);
            return;
        }
        client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);
        processSocketBuffer(client);
    });

    socket.on("close", () => cleanupClient(client));
    socket.on("end", () => cleanupClient(client));
    socket.on("error", () => cleanupClient(client));
});

// Keep WebSocket connections alive across Caddy & NAT routers
const keepAliveTimer = setInterval(() => {
    const now = Date.now();
    const pingFrame = encodeWsFrame(0x09, Buffer.alloc(0));
    for (const client of Array.from(clients)) {
        if (now - client.lastSeen > CLIENT_TIMEOUT_MS) {
            cleanupClient(client);
            continue;
        }
        if (client.socket.writable) {
            try {
                client.socket.write(pingFrame);
            } catch {
                cleanupClient(client);
            }
        }
    }
}, PING_INTERVAL_MS);
keepAliveTimer.unref();

server.listen(PORT, HOST, () => {
    console.log(`[Tracker] Jellyfin Private P2P Tracker listening on ws://${HOST}:${PORT}/tracker`);
});
