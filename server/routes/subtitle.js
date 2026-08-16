const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { resolvePlaybackUrl } = require('../services/playbackUrl');

/**
 * Subtitle extraction endpoint
 * GET /api/subtitle?url=...&index=...
 * 
 * Extracts a specific subtitle track and converts it to WebVTT on the fly.
 */
router.get('/', async (req, res) => {
    let { url } = req.query;
    const { index } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    try {
        url = await resolvePlaybackUrl(url);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    // console.log(`[Subtitle] Extracting track ${index} from: ${url}`);

    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        '-i', url,
        '-map', `0:${index}`,
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
