const { parseProgram } = require('../services/mpegTsProgram');
const { redactUrl, redactText, validateHttpUrl } = require('../services/urlSecurity');
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');
const { parseAudioCodecs, audioFilterArgs } = require('../services/remuxAudio');

/**
 * Allowed input URL schemes for the remux endpoint.
 *
 * FFmpeg accepts a wide variety of protocol handlers (file://, concat:,
 * subfile:, data:, pipe:, crypto:, async:, cache:, ...). Several of them
 * read from the local filesystem or compose existing protocols, so they
 * must not be reachable from a request parameter. Remux inputs should only
 * reference network streams, never local files or protocol wrappers.
 *
 * Only plain http/https stream URLs are valid inputs here.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/**
 * The set of ffmpeg protocols we explicitly permit via -protocol_whitelist.
 * This is a defence-in-depth layer applied on top of the scheme check: even
 * if a future code path forwarded a different URL, ffmpeg itself would
 * refuse to touch local files / arbitrary demuxer-level protocols.
 *
 * - file/concat/subfile/pipe/data/async/cache are intentionally absent.
 * - tls/tcp are needed for https; https/http are obvious.
 * - hls is needed so the demuxer can follow HLS playlists.
 * - crypto is needed for AES-encrypted HLS segments. Nested file access
 *   remains blocked, and top-level crypto URLs are rejected by the validator.
 */
const FFMPEG_PROTOCOL_WHITELIST = 'http,https,tls,tcp,hls,crypto';

/**
 * Validate a user-supplied stream URL.
 * Returns the normalised URL string on success, or null on rejection.
 */
function validateStreamUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Reject control characters (incl. CR/LF/NUL) before WHATWG URL parsing,
    // which would otherwise silently strip some of them.
    if (/[\x00-\x1F\x7F]/.test(raw)) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (_) {
        return null;
    }
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) return null;
    return parsed.toString();
}

/**
 * Remux stream (container conversion only)
 * GET /api/remux?url=...
 * 
 * Remuxes MPEG-TS to fragmented MP4 for browser playback.
 * This is a lightweight operation - no video/audio re-encoding.
 * Use this for raw .ts streams that browsers can't play directly.
 * 
 * Note: This does NOT fix Dolby/AC3 audio issues - use /api/transcode for that.
 */
router.get('/', async (req, res) => {
    const { url } = req.query;
    try { validateHttpUrl(url); } catch (error) { return res.status(400).json({ error: error.message }); }
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const safeUrl = validateStreamUrl(url);
    if (!safeUrl) {
        return res.status(400).json({ error: 'URL must be an http:// or https:// stream URL' });
    }

    let audioCodecs, program;
    try {
        program = parseProgram(req.query.program);
        audioCodecs = parseAudioCodecs(req.query.audioCodecs);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Remux] Starting remux for: ${redactUrl(safeUrl)}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        // Restrict the protocols ffmpeg is allowed to open for input.
        // Defence in depth: blocks file://, concat:, subfile:, data:, pipe:, etc.
        // even if a different URL slipped past validateStreamUrl().
        '-protocol_whitelist', FFMPEG_PROTOCOL_WHITELIST,
        '-user_agent', userAgent,
        '-user_agent', userAgent,
        // Standard probe size to handle complex containers (MKV) correctly
        '-probesize', '5000000',
        '-analyzeduration', '5000000',
        // Error resilience: discard corrupt packets, generate timestamps, ignore DTS, no buffering
        '-fflags', '+genpts+discardcorrupt+igndts+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues with bad timestamps
        '-max_delay', '5000000',
        '-multiple_requests', '0',
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_on_http_error', '4xx,5xx',
        '-reconnect_delay_max', '10',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', safeUrl,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', program === null ? '0:v' : `0:p:${program}:v:0`,
        '-map', program === null ? '0:a' : `0:p:${program}:a?`,
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // The MP4 muxer handles AVC framing; prepending container extradata corrupts AVCC packets.
        // Convert ADTS only on probed AAC tracks; leave MP3/AC3/EAC3 untouched.
        ...audioFilterArgs(audioCodecs),
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        // Also cut fragments every 0.5s so the first one doesn't wait a full GOP for the next keyframe
        '-frag_duration', '500000',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${redactText(args.join(' '))}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', redactText(spawnErr.message));
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        // Only log warnings/errors, not progress
        if (msg.includes('Warning') || msg.includes('Error') || msg.includes('error')) {
            console.log(`[Remux FFmpeg] ${redactText(msg)}`);
        }
    });

    // Cleanup on client disconnect
    res.on('close', () => {
        console.log('[Remux] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) {
            console.error(`[Remux] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Remux] Failed to spawn FFmpeg:', redactText(err.message));
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
