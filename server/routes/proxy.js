const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const xtreamApi = require('../services/xtreamApi');
const m3uParser = require('../services/m3uParser');
const epgParser = require('../services/epgParser');
const cache = require('../services/cache');
const { Readable } = require('stream');

// Default cache TTL: 24 hours
const DEFAULT_MAX_AGE_HOURS = 24;

/**
 * Proxy Xtream API calls
 * GET /api/proxy/xtream/:sourceId/:action
 */
router.get('/xtream/:sourceId/:action', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const { action } = req.params;
        const { category_id, stream_id, vod_id, series_id, limit, refresh, maxAge } = req.query;
        const forceRefresh = refresh === '1';
        const maxAgeHours = parseInt(maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Actions that should be cached
        const cacheableActions = [
            'live_categories', 'live_streams',
            'vod_categories', 'vod_streams',
            'series_categories', 'series'
        ];

        // Build cache key (include category_id if present)
        const cacheKey = category_id ? `${action}_${category_id}` : action;

        // Check cache for cacheable actions
        if (!forceRefresh && cacheableActions.includes(action)) {
            const cached = cache.get('xtream', sourceId, cacheKey, maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        const api = xtreamApi.createFromSource(source);
        let data;
        switch (action) {
            case 'auth':
                data = await api.authenticate();
                break;
            case 'live_categories':
                data = await api.getLiveCategories();
                break;
            case 'live_streams':
                data = await api.getLiveStreams(category_id);
                break;
            case 'vod_categories':
                data = await api.getVodCategories();
                break;
            case 'vod_streams':
                data = await api.getVodStreams(category_id);
                break;
            case 'vod_info':
                data = await api.getVodInfo(vod_id);
                break;
            case 'series_categories':
                data = await api.getSeriesCategories();
                break;
            case 'series':
                data = await api.getSeries(category_id);
                break;
            case 'series_info':
                data = await api.getSeriesInfo(series_id);
                break;
            case 'short_epg':
                data = await api.getShortEpg(stream_id, limit);
                break;
            default:
                return res.status(400).json({ error: 'Unknown action' });
        }

        // Cache the result for cacheable actions
        if (cacheableActions.includes(action)) {
            cache.set('xtream', sourceId, cacheKey, data);
        }

        res.json(data);
    } catch (err) {
        console.error('Xtream proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get Xtream stream URL
 * GET /api/proxy/xtream/:sourceId/stream/:streamId
 */
router.get('/xtream/:sourceId/stream/:streamId/:type?', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'xtream') {
            return res.status(404).json({ error: 'Xtream source not found' });
        }

        const api = xtreamApi.createFromSource(source);
        const { streamId, type = 'live' } = req.params;
        const { container = 'm3u8' } = req.query;

        const url = api.buildStreamUrl(streamId, type, container);
        res.json({ url });
    } catch (err) {
        console.error('Stream URL error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch and parse M3U playlist
 * GET /api/proxy/m3u/:sourceId
 */
router.get('/m3u/:sourceId', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || source.type !== 'm3u') {
            return res.status(404).json({ error: 'M3U source not found' });
        }

        const forceRefresh = req.query.refresh === '1';
        const maxAgeHours = parseInt(req.query.maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Check cache
        if (!forceRefresh) {
            const cached = cache.get('m3u', sourceId, 'playlist', maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        const data = await m3uParser.fetchAndParse(source.url);

        // Store in cache
        cache.set('m3u', sourceId, 'playlist', data);

        res.json(data);
    } catch (err) {
        console.error('M3U proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Fetch and parse EPG (with file-based caching)
 * GET /api/proxy/epg/:sourceId
 * Query params:
 *   - refresh=1  Force refresh, bypass cache
 *   - maxAge=N   Max cache age in hours (default 24)
 */
router.get('/epg/:sourceId', async (req, res) => {
    try {
        const sourceId = req.params.sourceId;
        const source = await sources.getById(sourceId);
        if (!source || (source.type !== 'epg' && source.type !== 'xtream')) {
            return res.status(404).json({ error: 'Valid EPG source not found' });
        }

        const forceRefresh = req.query.refresh === '1';
        const maxAgeHours = parseInt(req.query.maxAge) || DEFAULT_MAX_AGE_HOURS;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Check file cache (unless force refresh)
        if (!forceRefresh) {
            const cached = cache.get('epg', sourceId, 'data', maxAgeMs);
            if (cached) {
                return res.json(cached);
            }
        }

        // Fetch fresh data
        let url = source.url;
        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            url = api.getXmltvUrl();
        }

        const data = await epgParser.fetchAndParse(url);

        // Store in file cache
        cache.set('epg', sourceId, 'data', data);

        res.json(data);
    } catch (err) {
        console.error('EPG proxy error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Clear cache for a source
 * DELETE /api/proxy/cache/:sourceId
 */
router.delete('/cache/:sourceId', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clearSource(sourceId);
    res.json({ success: true });
});

/**
 * Clear EPG cache for a source (legacy endpoint, calls clearSource)
 * DELETE /api/proxy/epg/:sourceId/cache
 */
router.delete('/epg/:sourceId/cache', (req, res) => {
    const sourceId = req.params.sourceId;
    cache.clear('epg', sourceId, 'data');
    res.json({ success: true });
});

/**
 * Get EPG for specific channels
 * POST /api/proxy/epg/:sourceId/channels
 */
router.post('/epg/:sourceId/channels', async (req, res) => {
    try {
        const source = await sources.getById(req.params.sourceId);
        if (!source || source.type !== 'epg') {
            return res.status(404).json({ error: 'EPG source not found' });
        }

        const { channelIds } = req.body;
        if (!channelIds || !Array.isArray(channelIds)) {
            return res.status(400).json({ error: 'channelIds array required' });
        }

        const data = await epgParser.fetchAndParse(source.url);

        // Filter programmes for requested channels
        const result = {};
        for (const channelId of channelIds) {
            result[channelId] = epgParser.getCurrentAndUpcoming(data.programmes, channelId);
        }

        res.json(result);
    } catch (err) {
        console.error('EPG channels error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Proxy stream for playback
 * This handles CORS for streams that don't allow cross-origin
 * Supports HTTP Range requests for video seeking
 */
router.get('/stream', async (req, res) => {
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            let { url } = req.query;
            if (!url) {
                return res.status(400).json({ error: 'URL required' });
            }

            // Forward some headers to be more "transparent" back to the origin
            const isPluto = url.includes('pluto.tv');

            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                // Using https and matching the origin of the request
                'Origin': isPluto ? 'https://pluto.tv' : new URL(url).origin,
                'Referer': isPluto ? 'https://pluto.tv/' : new URL(url).origin + '/'
            };

            // Forward Range header for video seeking support
            const rangeHeader = req.get('range');
            if (rangeHeader) {
                headers['Range'] = rangeHeader;
            }

            const response = await fetch(url, { headers });

            // Retry on 5xx errors (transient upstream issues)
            if (response.status >= 500 && attempt < maxRetries) {
                console.log(`[Proxy] Upstream 5xx error (attempt ${attempt}/${maxRetries}), retrying in 500ms...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            if (!response.ok) {
                console.error(`Upstream error for ${url.substring(0, 80)}...: ${response.status} ${response.statusText}`);
                if (response.status === 403) {
                    const errorBody = await response.text().catch(() => 'N/A');
                    console.error(`403 Response body: ${errorBody.substring(0, 200)}`);
                }
                return res.status(response.status).send(`Failed to fetch stream: ${response.statusText}`);
            }

            const contentType = response.headers.get('content-type') || '';
            res.set('Access-Control-Allow-Origin', '*');
            
            // Forward range-related headers for video seeking support
            const contentLength = response.headers.get('content-length');
            const contentRange = response.headers.get('content-range');
            const acceptRanges = response.headers.get('accept-ranges');
            
            if (contentLength) {
                res.set('Content-Length', contentLength);
            }
            if (contentRange) {
                res.set('Content-Range', contentRange);
            }
            if (acceptRanges) {
                res.set('Accept-Ranges', acceptRanges);
            } else if (contentLength && !contentRange) {
                // If server supports content-length but didn't explicitly state accept-ranges,
                // we can safely assume it supports byte ranges
                res.set('Accept-Ranges', 'bytes');
            }
            
            // Set status code (206 for partial content when range request was made)
            res.status(response.status);

            // Create an async iterator for the response body
            const iterator = response.body[Symbol.asyncIterator]();
            const first = await iterator.next();

            if (first.done) {
                res.set('Content-Type', contentType || 'application/octet-stream');
                return res.end();
            }

            const firstChunk = Buffer.from(first.value);

            // Peek at first bytes to check for HLS manifest ({ #EXTM3U })
            const textPrefix = firstChunk.subarray(0, 7).toString('utf8');
            const contentLooksLikeHls = textPrefix === '#EXTM3U';

            if (contentLooksLikeHls) {
                // HLS Manifest: We must read the WHOLE manifest to rewrite it
                const chunks = [firstChunk];

                // Consume the rest of the stream
                let result = await iterator.next();
                while (!result.done) {
                    chunks.push(Buffer.from(result.value));
                    result = await iterator.next();
                }

                const buffer = Buffer.concat(chunks);
                const finalUrl = response.url || url;
                console.log(`[Proxy] Processing HLS manifest from: ${finalUrl.substring(0, 80)}...`);
                res.set('Content-Type', 'application/vnd.apple.mpegurl');

                let manifest = buffer.toString('utf-8');

                const finalUrlObj = new URL(finalUrl);
                const baseUrl = finalUrlObj.origin + finalUrlObj.pathname.substring(0, finalUrlObj.pathname.lastIndexOf('/') + 1);

                manifest = manifest.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '' || trimmed.startsWith('#')) {
                        if (trimmed.includes('URI="')) {
                            return line.replace(/URI="([^"]+)"/g, (match, p1) => {
                                try {
                                    const absoluteUrl = new URL(p1, baseUrl).href;
                                    return `URI="${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}"`;
                                } catch (e) { return match; }
                            });
                        }
                        return line;
                    }

                    // Stream URL handling
                    try {
                        let absoluteUrl;
                        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                            absoluteUrl = trimmed;
                        } else {
                            absoluteUrl = new URL(trimmed, baseUrl).href;
                        }
                        return `${req.protocol}://${req.get('host')}${req.baseUrl}/stream?url=${encodeURIComponent(absoluteUrl)}`;
                    } catch (e) { return line; }
                }).join('\n');

                return res.send(manifest);
            }

            // Binary content (Video Segment): Efficient Pipe
            console.log(`[Proxy] Piping binary stream (${contentType})`);
            res.set('Content-Type', contentType || 'application/octet-stream');

            // Write the chunk we peeked
            res.write(firstChunk);

            // Stream the rest
            // Create a readable stream from the iterator
            const restOfStream = Readable.from(iterator);

            // Pipe to response
            restOfStream.pipe(res);
            return; // Success - exit the retry loop

        } catch (err) {
            lastError = err;
            console.error(`Stream proxy error (attempt ${attempt}/${maxRetries}):`, err.message);
            if (attempt < maxRetries) {
                console.log('[Proxy] Retrying after error...');
                await new Promise(r => setTimeout(r, 500));
                continue;
            }
        }
    }

    // All retries failed
    if (!res.headersSent) {
        res.status(500).json({ error: lastError?.message || 'Stream proxy failed after retries' });
    }
});

/**
 * Proxy images (channel logos, posters)
 * Fixes mixed content errors when loading HTTP images on HTTPS pages
 * GET /api/proxy/image?url=...
 */
router.get('/image', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8'
            }
        });

        if (!response.ok) {
            return res.status(response.status).send('Failed to fetch image');
        }

        const contentType = response.headers.get('content-type') || 'image/png';
        res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours

        // Efficiently pipe the response body
        if (response.body) {
            // response.body is an AsyncIterable in standard fetch/undici
            // Readable.from converts it to a Node.js Readable stream
            const stream = Readable.from(response.body);
            stream.pipe(res);
        } else {
            res.end();
        }

    } catch (err) {
        console.error('Image proxy error:', err.message);
        res.status(500).send('Image proxy error');
    }
});

module.exports = router;
