const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const db = require('../db');

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
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Remux] Starting remux for: ${url}`);
    console.log(`[Remux] Using User-Agent: ${settings.userAgentPreset}`);

    // FFmpeg arguments for pure remux (no encoding)
    // Very lightweight - just changes container from TS to fragmented MP4
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
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
        // Reconnect settings for network drops
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        '-i', url,
        // STRICT MAPPING: Only map video and audio, ignore subtitles/data/attachments
        // This prevents remux failure when source container has incompatible subtitle tracks (e.g. MKV -> MP4)
        '-map', '0:v',
        '-map', '0:a',
        // Drop subtitles (-sn) and data (-dn) explicitly
        '-sn', '-dn',
        // Copy streams without re-encoding
        '-c', 'copy',
        // Ensure extradata is correctly extracted/converted (fixes Annex B -> AVCC issues in Firefox)
        '-bsf:v', 'dump_extra',
            // NOTE: We add the audio bitstream filter only when the source
            // audio codec is AAC. Some TS streams carry AAC in ADTS which
            // must be converted to MP4 format using aac_adtstoasc. This
            // filter breaks non-AAC audio (AC3/EAC3/MP3), so we detect
            // codec via ffprobe and add it conditionally below.
        // Handle timestamp discontinuities at output
        '-fps_mode', 'passthrough',
        '-max_muxing_queue_size', '1024',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-' // Output to stdout
    ];

    console.log(`[Remux] Full command: ${ffmpegPath} ${args.join(' ')}`);

    // If ffprobe is available, probe the audio codec and conditionally
    // add the aac ADTS -> ASC bitstream filter when needed.
    async function probeAudioCodec(url, ffprobePath, userAgent) {
        return new Promise((resolve) => {
            if (!ffprobePath) return resolve(null);
            const probeArgs = [
                '-v', 'error',
                '-user_agent', userAgent || 'Mozilla/5.0',
                '-print_format', 'json',
                '-show_streams',
                '-probesize', '5000000',
                '-analyzeduration', '5000000',
                url
            ];
            try {
                const p = spawn(ffprobePath, probeArgs);
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => {
                    try { p.kill('SIGKILL'); } catch (e) {}
                    resolve(null);
                }, 3000);
                p.stdout.on('data', d => { stdout += d.toString(); });
                p.stderr.on('data', d => { stderr += d.toString(); });
                p.on('close', (code) => {
                    clearTimeout(timer);
                    try {
                        const res = JSON.parse(stdout || '{}');
                        const streams = res.streams || [];
                        const audio = streams.find(s => s.codec_type === 'audio');
                        const audioCodec = audio?.codec_name?.toLowerCase() || null;
                        resolve(audioCodec);
                    } catch (e) {
                        resolve(null);
                    }
                });
                p.on('error', () => { clearTimeout(timer); resolve(null); });
            } catch (e) {
                return resolve(null);
            }
        });
    }

    // Probe and update args before spawning ffmpeg
    try {
        const audioCodec = await probeAudioCodec(url, req.app.locals.ffprobePath, userAgent);
        if (audioCodec && audioCodec.includes('aac')) {
            console.log('[Remux] Detected AAC audio, adding -bsf:a aac_adtstoasc');
            // Insert audio bsf after dump_extra (video bsf)
            args.splice(args.indexOf('-bsf:v') + 2, 0, '-bsf:a', 'aac_adtstoasc');
        }
    } catch (e) {
        // Non-fatal: proceed without audio BSF
        console.warn('[Remux] Audio probe failed, proceeding without aac_adtstoasc');
    }

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Remux] Failed to spawn FFmpeg:', spawnErr);
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
            console.log(`[Remux FFmpeg] ${msg}`);
        }
    });

    // Cleanup on client disconnect
    req.on('close', () => {
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
        console.error('[Remux] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Remux failed to start' });
        }
    });
});

module.exports = router;
