const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');

/**
 * Subtitle extraction endpoint
 * GET /api/subtitle?url=...&index=...
 * 
 * Extracts a specific subtitle track and converts it to WebVTT on the fly.
 */
router.get('/', (req, res) => {
    const { url, index } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    // Validate URL: only allow http(s) schemes. This prevents ffmpeg protocol
    // handler abuse (file://, concat:, subfile:, data:, etc.) which could
    // otherwise be used to read arbitrary local files from the server.
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL' });
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return res.status(400).json({ error: 'Only http(s) URLs are allowed' });
    }

    // Validate index: must be a non-negative integer. Prevents injection of
    // extra ffmpeg option tokens via the -map argument.
    const indexNum = Number(index);
    if (!Number.isInteger(indexNum) || indexNum < 0 || String(indexNum) !== String(index).trim()) {
        return res.status(400).json({ error: 'Index must be a non-negative integer' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    // console.log(`[Subtitle] Extracting track ${indexNum} from: ${parsedUrl.href}`);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        // Restrict ffmpeg to safe network protocols only, as defense in depth
        // against protocol handler abuse or redirects into local file reads.
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-i', parsedUrl.href,
        '-map', `0:${indexNum}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        '-'
    ];

    const ffmpeg = spawn(ffmpegPath, args);

    res.setHeader('Content-Type', 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
        // console.error(`[Subtitle FFmpeg] ${data}`);
    });

    req.on('close', () => {
        ffmpeg.kill('SIGKILL');
    });

    ffmpeg.on('error', (err) => {
        console.error('[Subtitle] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).send('Subtitle extraction failed');
        }
    });
});

module.exports = router;
