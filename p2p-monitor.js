// == Jellyfin P2P Live Mesh Monitor (standalone, localhost-only) ==
// Zero external dependencies. Completely separate from Jellyfin / Caddy / the tracker.
//
// It READS the existing tracker telemetry (http://127.0.0.1:8000/telemetry), which every
// peer already fills with: its chunk list (each chunk = http or p2p + the peerId it came from),
// playing chunk and p2p/http/up byte counters. From that it derives "who seeded whom",
// live, and serves a visualization page at http://127.0.0.1:8001/
//
// Access control: bound to 127.0.0.1 only, and every request is additionally rejected if it
// is not from a loopback socket, carries proxy headers, or has a non-local Host/Origin.
// Caddy does not route to this port, so it is never exposed to the internet.

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.MONITOR_PORT) || 8001;
const TRACKER_TELEMETRY_URL = process.env.TRACKER_TELEMETRY_URL || "http://127.0.0.1:8000/telemetry";
const POLL_MS = 1000;
const STALE_MS = 15000;
const LOBBY_HASH = "6a662d6c6f6262792d7631303030303030303030";
const HTML_FILE = path.join(__dirname, "p2p-monitor.html");

const peerHistory = new Map(); // peerId -> { prevUp, prevDown, prevHttp, upRate, downRate, seedingAt, ts, prevChunkKeys:Set|null }
const edges = new Map();       // "from>to" -> { from, to, chunks, bytes, lastAt }
const sseClients = new Set();
let lastState = { ok: false, error: "starting", now: Date.now(), peers: [], edges: [], totals: {} };

function isLobby(infoHashHex) {
    let s = "";
    try { s = Buffer.from(String(infoHashHex), "hex").toString("latin1"); } catch {}
    return s === LOBBY_HASH || s.toLowerCase().includes("lobby") || String(infoHashHex) === LOBBY_HASH;
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

function fetchTelemetry() {
    return new Promise((resolve, reject) => {
        const req = http.get(TRACKER_TELEMETRY_URL, { timeout: 2500 }, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => { data += c; if (data.length > 8e6) req.destroy(); });
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => req.destroy(new Error("tracker timeout")));
        req.on("error", reject);
    });
}

function buildState(tele) {
    const now = Date.now();
    // 1. Flatten swarms -> one record per peer (prefer video swarms with chunks over lobby/empty swarms).
    const byPeer = new Map();
    const swarmsSummary = [];

    for (const sw of tele.swarms || []) {
        let decoded = "";
        try { decoded = Buffer.from(String(sw.infoHashHex), "hex").toString("utf8"); } catch {}
        const lobby = isLobby(sw.infoHashHex) || decoded.toLowerCase().includes("lobby");
        const parsedSwarm = parseAudioAndQuality(decoded);

        if (!lobby && (sw.peerCount > 0 || (sw.peers && sw.peers.length > 0))) {
            const itemMatch = decoded.match(/jellyfin-([a-zA-Z0-9]+)/);
            swarmsSummary.push({
                hashPreview: sw.infoHashPreview,
                hashHex: sw.infoHashHex,
                itemId: itemMatch ? itemMatch[1] : null,
                audioTrack: parsedSwarm.audio,
                quality: parsedSwarm.quality,
                peerCount: sw.peerCount || (sw.peers ? sw.peers.length : 0),
                peers: (sw.peers || []).map(p => p.userName).filter(Boolean)
            });
        }

        for (const p of sw.peers || []) {
            const resolvedAudio = (p.audioTrack !== undefined && p.audioTrack !== null && p.audioTrack !== "")
                ? String(p.audioTrack)
                : (parsedSwarm.audio || null);
            const resolvedQuality = (p.quality !== undefined && p.quality !== null && p.quality !== "")
                ? String(p.quality)
                : (parsedSwarm.quality || null);

            const rec = { 
                ...p, 
                audioTrack: resolvedAudio,
                quality: resolvedQuality,
                swarm: sw.infoHashPreview, 
                swarmHex: sw.infoHashHex, 
                swarmDecoded: decoded,
                lobby 
            };
            const old = byPeer.get(p.peerId);
            const oldHasChunks = old && Array.isArray(old.chunks) && old.chunks.length > 0;
            const newHasChunks = Array.isArray(p.chunks) && p.chunks.length > 0;
            if (!old || 
                (old.lobby && !lobby) || 
                (!old.lobby && !lobby && newHasChunks && !oldHasChunks) ||
                (old.lobby === lobby && (!oldHasChunks || newHasChunks) && p.updatedAt > old.updatedAt)) {
                if (old) {
                    rec.audioTrack = rec.audioTrack || old.audioTrack;
                    rec.quality = rec.quality || old.quality;
                }
                byPeer.set(p.peerId, rec);
            }
        }
    }

    const peers = [];
    for (const p of byPeer.values()) {
        if (now - p.updatedAt > STALE_MS * 8) continue;
        let h = peerHistory.get(p.peerId);
        if (!h) {
            h = { 
                prevUp: p.p2pUpBytes, 
                prevDown: p.p2pDownBytes, 
                prevHttp: p.httpDownBytes, 
                upRate: 0, 
                downRate: 0, 
                seedingAt: 0, 
                ts: now, 
                prevChunkKeys: null, 
                prevSwarm: p.swarmHex,
                chunksMap: new Map(),
                streamStartChunk: null
            };
            peerHistory.set(p.peerId, h);
        }
        const dt = Math.max(0.001, (now - h.ts) / 1000);
        if (p.p2pUpBytes !== h.prevUp || p.p2pDownBytes !== h.prevDown || p.httpDownBytes !== h.prevHttp) {
            const dUp = p.p2pUpBytes - h.prevUp;
            const dDown = (p.p2pDownBytes - h.prevDown) + (p.httpDownBytes - h.prevHttp);
            h.upRate = dUp > 0 ? dUp / dt : 0;
            h.downRate = dDown > 0 ? dDown / dt : 0;
            if (dUp > 0) h.seedingAt = now;
            h.prevUp = p.p2pUpBytes;
            h.prevDown = p.p2pDownBytes;
            h.prevHttp = p.httpDownBytes;
            h.ts = now;
        } else if (now - h.ts > 4000) {
            h.upRate = 0;
            h.downRate = 0;
        }

        // 2. Swarm switch detection: reset accumulated chunks on new movie
        if (h.prevSwarm !== p.swarmHex) { 
            h.prevChunkKeys = null; 
            h.prevSwarm = p.swarmHex; 
            h.chunksMap = new Map();
            h.streamStartChunk = null;
        }

        // 3. Accumulate chunks into h.chunksMap so prefetched chunks never wipe out the playback buffer
        for (const c of p.chunks || []) {
            if (h.streamStartChunk === null || c.num < h.streamStartChunk) {
                h.streamStartChunk = c.num;
            }
            h.chunksMap.set(c.num, { n: c.num, s: c.sourceType === "p2p" ? "p" : "h", p: c.peerId || null });
        }
        if (h.chunksMap.size > 800) {
            const sortedKeys = Array.from(h.chunksMap.keys()).sort((a, b) => a - b);
            const toRemove = sortedKeys.length - 500;
            for (let i = 0; i < toRemove; i++) h.chunksMap.delete(sortedKeys[i]);
        }

        // 4. Derive "who seeded whom" from newly appeared p2p chunks of this receiver.
        const keys = new Set();
        const firstSight = h.prevChunkKeys === null;
        for (const c of p.chunks || []) {
            if (c.sourceType !== "p2p" || !c.peerId || c.peerId === p.peerId) continue;
            const key = c.num + "|" + c.peerId;
            keys.add(key);
            if (h.prevChunkKeys && h.prevChunkKeys.has(key)) continue;
            const ek = c.peerId + ">" + p.peerId;
            let e = edges.get(ek);
            if (!e) { e = { from: c.peerId, to: p.peerId, chunks: 0, bytes: 0, lastAt: 0 }; edges.set(ek, e); }
            e.chunks += 1;
            e.bytes += (Number(c.sizeMB) || 0) * 1048576;
            if (!firstSight) e.lastAt = now; // history on first sight is counted but not "live"
        }
        h.prevChunkKeys = keys;

        const totalDown = p.p2pDownBytes + p.httpDownBytes;
        peers.push({
            peerId: p.peerId,
            userName: p.userName,
            browser: p.browser,
            audioTrack: p.audioTrack,
            quality: p.quality,
            swarm: p.swarm,
            swarmDecoded: p.swarmDecoded,
            lobby: p.lobby,
            playingChunk: p.playingChunk,
            streamStartChunk: h.streamStartChunk,
            chunks: Array.from(h.chunksMap.values()),
            p2pDownBytes: p.p2pDownBytes,
            httpDownBytes: p.httpDownBytes,
            p2pUpBytes: p.p2pUpBytes,
            offloadPct: totalDown > 0 ? (p.p2pDownBytes / totalDown) * 100 : 0,
            upRate: h.upRate,
            downRate: h.downRate,
            seedingAt: h.seedingAt,
            updatedAt: p.updatedAt,
            stale: now - p.updatedAt > STALE_MS
        });
    }

    // Drop history / edges of peers that are gone.
    const ids = new Set(peers.map((p) => p.peerId));
    for (const id of Array.from(peerHistory.keys())) if (!ids.has(id)) peerHistory.delete(id);
    for (const [k, e] of Array.from(edges.entries())) {
        if (!ids.has(e.from) || !ids.has(e.to)) edges.delete(k);
    }

    peers.sort((a, b) => (a.userName || "").localeCompare(b.userName || "") || a.peerId.localeCompare(b.peerId));

    let p2p = 0, httpB = 0, up = 0;
    for (const p of peers) { p2p += p.p2pDownBytes; httpB += p.httpDownBytes; up += p.p2pUpBytes; }

    return {
        ok: true,
        now,
        tracker: { activeSwarms: tele.activeSwarms, connectedPeers: tele.connectedPeers, uptimeSec: tele.uptimeSec },
        swarmsList: swarmsSummary,
        totals: { p2pDownBytes: p2p, httpDownBytes: httpB, p2pUpBytes: up, offloadPct: p2p + httpB > 0 ? (p2p / (p2p + httpB)) * 100 : 0 },
        peers,
        edges: Array.from(edges.values())
    };
}

async function tick() {
    try {
        lastState = buildState(await fetchTelemetry());
    } catch (e) {
        lastState = { ok: false, error: "Tracker unreachable: " + (e && e.message || e), now: Date.now(), peers: [], edges: [], totals: {} };
    }
    if (sseClients.size > 0) {
        const msg = "data: " + JSON.stringify(lastState) + "\n\n";
        for (const res of sseClients) {
            try { res.write(msg); } catch { sseClients.delete(res); }
        }
    }
}
setInterval(tick, POLL_MS);
tick();

// ---------------------------------------------------------------------------
// Localhost-only guard
// ---------------------------------------------------------------------------
function isLoopbackAddr(a) {
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}
function isLocalHostHeader(h) {
    if (!h) return false;
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(h));
}
function isAllowed(req) {
    if (!isLoopbackAddr(req.socket.remoteAddress)) return false;
    for (const hdr of ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "cf-connecting-ip"]) {
        if (req.headers[hdr]) return false; // came through a reverse proxy (e.g. Caddy)
    }
    if (!isLocalHostHeader(req.headers.host)) return false; // blocks DNS-rebinding / public domain
    const origin = req.headers.origin;
    if (origin) {
        try {
            const o = new URL(origin);
            if (!isLocalHostHeader(o.host)) return false;
        } catch { return false; }
    }
    return true;
}

const server = http.createServer((req, res) => {
    if (!isAllowed(req)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: localhost only");
        return;
    }
    const url = (req.url || "/").split("?")[0];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (url === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        res.write("retry: 2000\n\ndata: " + JSON.stringify(lastState) + "\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
    }
    if (url === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(lastState));
        return;
    }
    if (url === "/" || url === "/index.html") {
        fs.readFile(HTML_FILE, (err, buf) => {
            if (err) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("p2p-monitor.html missing");
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(buf);
        });
        return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
});

server.listen(PORT, HOST, () => {
    console.log(`[Monitor] P2P Live Mesh Monitor: http://127.0.0.1:${PORT}/  (localhost only)`);
    console.log(`[Monitor] Reading tracker telemetry from ${TRACKER_TELEMETRY_URL}`);
});
