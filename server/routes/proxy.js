const express = require("express");
const router = express.Router();
const { sources } = require("../db");
const xtreamApi = require("../services/xtreamApi");
const m3uParser = require("../services/m3uParser");
const epgParser = require("../services/epgParser");

/**
 * Proxy Xtream API calls
 */
router.get("/xtream/:sourceId/:action", async (req, res) => {
    try {
        const source = sources.getById(req.params.sourceId);
        if (!source || source.type !== "xtream") {
            return res.status(404).json({ error: "Xtream source not found" });
        }

        const api = xtreamApi.createFromSource(source);
        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit } = req.query;

        let data;
        switch (action) {
            case "auth": data = await api.authenticate(); break;
            case "live_categories": data = await api.getLiveCategories(); break;
            case "live_streams": data = await api.getLiveStreams(category_id); break;
            case "vod_categories": data = await api.getVodCategories(); break;
            case "vod_streams": data = await api.getVodStreams(category_id); break;
            case "vod_info": data = await api.getVodInfo(vod_id); break;
            case "series_categories": data = await api.getSeriesCategories(); break;
            case "series": data = await api.getSeries(category_id); break;
            case "series_info": data = await api.getSeriesInfo(series_id); break;
            case "short_epg": data = await api.getShortEpg(stream_id, limit); break;
            default: return res.status(400).json({ error: "Unknown action" });
        }
        res.json(data);
    } catch (err) {
        console.error("Xtream proxy error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.get("/xtream/:sourceId/stream/:streamId/:type?", (req, res) => {
    try {
        const source = sources.getById(req.params.sourceId);
        if (!source || source.type !== "xtream") {
            return res.status(404).json({ error: "Xtream source not found" });
        }
        const api = xtreamApi.createFromSource(source);
        const { streamId, type = "live" } = req.params;
        const { container = "m3u8" } = req.query;
        const url = api.buildStreamUrl(streamId, type, container);
        res.json({ url });
    } catch (err) {
        console.error("Stream URL error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.get("/m3u/:sourceId", async (req, res) => {
    try {
        const source = sources.getById(req.params.sourceId);
        if (!source || source.type !== "m3u") {
            return res.status(404).json({ error: "M3U source not found" });
        }
        const data = await m3uParser.fetchAndParse(source.url);
        res.json(data);
    } catch (err) {
        console.error("M3U proxy error:", err);
        res.status(500).json({ error: err.message });
    }
});

const epgMemoryCache = {};

router.get("/epg/:sourceId", async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = sources.getById(sourceId);
        if (!source || (source.type !== "epg" && source.type !== "xtream")) {
            return res.status(404).json({ error: "Valid EPG source not found" });
        }

        const forceRefresh = req.query.refresh === "1";
        const maxAgeHours = parseInt(req.query.maxAge) || 24;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        if (!forceRefresh && epgMemoryCache[sourceId]) {
            const cached = epgMemoryCache[sourceId];
            if (Date.now() - cached.fetchedAt < maxAgeMs) {
                return res.json(cached.data);
            }
        }

        let url = source.url;
        if (source.type === "xtream") {
            const api = xtreamApi.createFromSource(source);
            url = api.getXmltvUrl();
        }

        const data = await epgParser.fetchAndParse(url);
        epgMemoryCache[sourceId] = { data, fetchedAt: Date.now() };
        res.json(data);
    } catch (err) {
        console.error("EPG proxy error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.delete("/epg/:sourceId/cache", (req, res) => {
    delete epgMemoryCache[req.params.sourceId];
    res.json({ success: true });
});

router.post("/epg/:sourceId/channels", async (req, res) => {
    try {
        const source = sources.getById(req.params.sourceId);
        if (!source || source.type !== "epg") {
            return res.status(404).json({ error: "EPG source not found" });
        }
        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: "channelIds array required" });
        }
        const data = await epgParser.fetchAndParse(source.url);
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }
        res.json(result);
    } catch (err) {
        console.error("EPG channels error:", err);
        res.status(500).json({ error: err.message });
    }
});

// Cache referer per CDN hostname
const streamRefererCache = new Map();

/**
 * Proxy stream for playback - handles CORS and referer issues
 */
router.get("/stream", async (req, res) => {
    try {
        let { url, referer } = req.query;
        if (!url) {
            return res.status(400).json({ error: "URL required" });
        }

        const urlObj = new URL(url);
        const cacheKey = urlObj.hostname;

        // Store referer for this CDN hostname if provided
        if (referer) {
            streamRefererCache.set(cacheKey, referer);
        }

        // Determine the best referer
        let finalReferer = referer || streamRefererCache.get(cacheKey);

        if (!finalReferer) {
            if (url.includes("pluto.tv")) {
                finalReferer = "https://pluto.tv/";
            } else {
                // For Xtream CDNs, use the Xtream portal URL as referer
                const allSources = sources.getAll();
                const xtreamSource = allSources.find(s => s.type === "xtream");
                if (xtreamSource && xtreamSource.url) {
                    finalReferer = xtreamSource.url;
                    streamRefererCache.set(cacheKey, finalReferer);
                } else {
                    finalReferer = urlObj.origin + "/";
                }
            }
        }

        let refererOrigin;
        try {
            refererOrigin = new URL(finalReferer).origin;
        } catch {
            refererOrigin = urlObj.origin;
        }

        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": refererOrigin,
            "Referer": finalReferer
        };

        console.log("Proxying:", url.substring(0, 80) + "... with Referer:", finalReferer);

        const response = await fetch(url, { headers, redirect: "follow" });
        if (!response.ok) {
            console.error("Upstream " + response.status + " for " + url);
            return res.status(response.status).send("Failed: " + response.statusText);
        }

        // Use the final URL after redirects for base URL calculation
        const finalUrl = response.url || url;
        const finalUrlObj = new URL(finalUrl);

        console.log("Final URL after redirects:", finalUrl.substring(0, 80));

        const contentType = response.headers.get("content-type") || "";
        res.set("Access-Control-Allow-Origin", "*");

        const isHls = contentType.includes("mpegurl") ||
                      contentType.includes("x-mpegURL") ||
                      finalUrl.toLowerCase().includes(".m3u8");

        if (isHls) {
            let manifest = await response.text();

            if (manifest.trim().startsWith("#EXTM3U")) {
                res.set("Content-Type", "application/vnd.apple.mpegurl");

                // Use the FINAL URL (after redirects) as the base for segment URLs
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf("/") + 1);
                const proxyBase = req.protocol + "://" + req.get("host") + req.baseUrl + "/stream";

                manifest = manifest.split("\n").map(line => {
                    const trimmed = line.trim();
                    if (trimmed === "" || trimmed.startsWith("#")) {
                        if (trimmed.includes('URI="')) {
                            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
                                try {
                                    const absoluteUrl = new URL(p1, baseUrl).href;
                                    return 'URI="' + proxyBase + '?url=' + encodeURIComponent(absoluteUrl) + '"';
                                } catch { return match; }
                            });
                        }
                        return line;
                    }
                    try {
                        const absoluteUrl = new URL(trimmed, baseUrl).href;
                        return proxyBase + "?url=" + encodeURIComponent(absoluteUrl);
                    } catch { return line; }
                }).join("\n");

                return res.send(manifest);
            }
        }

        res.set("Content-Type", contentType);
        const buffer = await response.arrayBuffer();
        return res.send(Buffer.from(buffer));

    } catch (err) {
        console.error("Stream proxy error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

module.exports = router;
