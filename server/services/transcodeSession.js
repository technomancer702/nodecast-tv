/**
 * Transcode Session Service
 * 
 * Manages HLS transcoding sessions with segment caching for VOD seeking.
 * Each session transcodes a source URL to HLS segments on disk.
 * 
 * Key features:
 * - Session-based transcoding with unique IDs
 * - HLS segment output for seeking support
 * - Segment caching for fast access
 * - Session persistence for recovery after restart
 * - Automatic cleanup of stale sessions
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');

// Session storage
const sessions = new Map();

// Cache directory for transcoded segments
const CACHE_DIR = path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SEGMENT_DURATION = 4; // seconds per HLS segment
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

/**
 * TranscodeSession class
 * Manages a single transcoding session from source URL to HLS segments
 */
class TranscodeSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = url;
        this.dir = path.join(CACHE_DIR, this.id);
        this.playlistPath = path.join(this.dir, 'stream.m3u8');
        this.process = null;
        this.segments = new Map(); // segment index -> { ready: boolean, path: string }
        this.status = 'pending'; // pending | starting | running | stopped | error
        this.error = null;
        this.startTime = Date.now();
        this.lastAccess = Date.now();
        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            userAgent: options.userAgent || 'Mozilla/5.0',
            seekOffset: options.seekOffset || 0,
            hwEncoder: options.hwEncoder || 'software',
            maxResolution: options.maxResolution || '1080p',
            quality: options.quality || 'medium',
            ...options
        };
    }

    /**
     * Start the transcoding process
     */
    async start() {
        if (this.status === 'running') {
            return;
        }

        this.status = 'starting';
        console.log(`[TranscodeSession ${this.id}] Starting session for: ${this.url}`);

        // Create session directory
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }

        // Build FFmpeg arguments for HLS output
        const args = this.buildFFmpegArgs();

        console.log(`[TranscodeSession ${this.id}] Command: ${this.options.ffmpegPath} ${args.join(' ')}`);

        try {
            this.process = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });

            this.status = 'running';

            // Handle stdout (should be empty for file output)
            this.process.stdout.on('data', (data) => {
                console.log(`[TranscodeSession ${this.id}] stdout: ${data}`);
            });

            // Handle stderr (FFmpeg progress/errors)
            let stderrBuffer = '';
            this.process.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                // Log periodically to avoid spam
                const lines = stderrBuffer.split('\n');
                if (lines.length > 1) {
                    lines.slice(0, -1).forEach(line => {
                        if (line.trim()) {
                            console.log(`[FFmpeg ${this.id}] ${line}`);
                        }
                    });
                    stderrBuffer = lines[lines.length - 1];
                }
            });

            // Handle process exit
            this.process.on('exit', (code) => {
                if (code === 0 || code === null) {
                    console.log(`[TranscodeSession ${this.id}] FFmpeg completed successfully`);
                    this.status = 'stopped';
                } else if (code !== 255) { // 255 is often from SIGKILL
                    console.error(`[TranscodeSession ${this.id}] FFmpeg exited with code ${code}`);
                    this.status = 'error';
                    this.error = `FFmpeg exited with code ${code}`;
                }
                this.process = null;
                this.emit('exit', code);
            });

            // Handle spawn errors
            this.process.on('error', (err) => {
                console.error(`[TranscodeSession ${this.id}] FFmpeg error:`, err);
                this.status = 'error';
                this.error = err.message;
                this.emit('error', err);
            });

            // Save session metadata
            await this.persist();

        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
        const segmentPattern = path.join(this.dir, 'seg%04d.m4s');
        const videoMode = this.options.videoMode || 'encode';

        // Resolve 'auto' encoder to detected hardware, fallback to software
        let encoder = this.options.hwEncoder || 'software';
        if (encoder === 'auto') {
            const hwCaps = hwDetect.getCapabilities();
            encoder = hwCaps?.recommended || 'software';
            console.log(`[TranscodeSession ${this.id}] Auto encoder resolved to: ${encoder}`);
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
        ];

        // Add hardware acceleration input options based on encoder (only if encoding)
        if (videoMode === 'encode') {
            this.addHwAccelInputArgs(args, encoder);
        }

        // Input options (common)
        args.push(
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3'
        );

        args.push('-i', this.url);

        // Add seek offset if specified (as output option to avoid Range requests)
        if (this.options.seekOffset > 0) {
            args.push('-ss', String(this.options.seekOffset));
        }

        // Map streams
        args.push('-map', '0:v:0');
        args.push('-map', '0:a:0?');

        // Add video encoder and filters based on selected encoder OR copy
        if (videoMode === 'copy') {
            args.push('-c:v', 'copy');

            // Critical for MKV/MP4 -> TS copy: Convert bitstream from AVCC/HVCC to Annex B
            if (this.options.videoCodec === 'hevc' || this.options.videoCodec === 'h265') {
                args.push('-bsf:v', 'hevc_mp4toannexb');
            } else if (this.options.videoCodec === 'h264' || this.options.videoCodec === 'avc') {
                args.push('-bsf:v', 'h264_mp4toannexb');
            } else {
                // Fallback (e.g. unknown codec), try strict extraction
                args.push('-bsf:v', 'dump_extra');
            }
        } else {
            this.addVideoEncoderArgs(args, encoder);
        }

        // Audio: Apply mix preset
        const audioCodec = this.options.audioCodec?.toLowerCase() || 'unknown';
        const audioChannels = this.options.audioChannels || 0;
        const audioMixPreset = this.options.audioMixPreset || 'auto';
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2;

        // Define pan filter presets for 5.1 -> Stereo downmix
        const AUDIO_MIX_FILTERS = {
            // ITU-R BS.775 Standard: Mathematically balanced, transparent
            itu: 'pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE',
            // Night Mode: Heavy dialogue boost, reduced bass/surrounds for quiet viewing
            night: 'pan=stereo|FL=0.5*FL+1.2*FC+0.3*BL+0.1*LFE|FR=0.5*FR+1.2*FC+0.3*BR+0.1*LFE',
            // Cinematic: Wide soundstage, immersive (original "dialogue boost" mix)
            cinematic: 'pan=stereo|FL=FC+0.80*FL+0.60*BL+0.5*LFE|FR=FC+0.80*FR+0.60*BR+0.5*LFE'
        };

        if (audioMixPreset === 'passthrough') {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            args.push('-c:a', 'copy');
        } else if (audioMixPreset === 'auto' && isStereoAac) {
            // Auto + Stereo AAC source: Smart copy
            console.log(`[TranscodeSession ${this.id}] Audio: Auto (Smart Copy) - Source is Stereo AAC`);
            args.push('-c:a', 'copy');
        } else {
            // Transcode to AAC with selected mix preset (default to ITU for 'auto')
            const mixPreset = (audioMixPreset === 'auto') ? 'itu' : audioMixPreset;
            const panFilter = AUDIO_MIX_FILTERS[mixPreset] || AUDIO_MIX_FILTERS.itu;

            console.log(`[TranscodeSession ${this.id}] Audio: ${mixPreset.toUpperCase()} mix (${audioCodec} ${audioChannels}ch -> Stereo AAC)`);
            args.push(
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '192k',
                '-af', `${panFilter},aresample=async=1`
            );
        }

        // HLS output options
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', '0', // Keep all segments in playlist
            '-hls_flags', 'independent_segments+append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts'),
            this.playlistPath
        );

        return args;
    }

    /**
     * Add hardware acceleration input arguments
     */
    addHwAccelInputArgs(args, encoder) {
        switch (encoder) {
            case 'nvenc':
                // NVIDIA CUDA/NVDEC hardware decoding
                args.push(
                    '-hwaccel', 'cuda',
                    '-hwaccel_output_format', 'cuda'
                );
                break;
            case 'vaapi':
                // VAAPI hardware decoding (Linux)
                args.push(
                    '-hwaccel', 'vaapi',
                    '-hwaccel_device', '/dev/dri/renderD128',
                    '-hwaccel_output_format', 'vaapi'
                );
                break;
            case 'qsv':
                // Intel QuickSync hardware decoding
                args.push(
                    '-hwaccel', 'qsv',
                    '-hwaccel_output_format', 'qsv'
                );
                break;
            case 'amf':
                // AMD AMF (no hwaccel input, AMF is encode-only)
                // Decode on CPU, encode on GPU
                break;
            case 'software':
            case 'auto':
            default:
                // No hardware acceleration for input
                break;
        }
    }

    /**
     * Add video encoder arguments based on selected encoder
     */
    addVideoEncoderArgs(args, encoder) {
        const resolution = this.getTargetHeight();
        const quality = this.options.quality || 'medium';

        // Quality presets mapping
        const qualityPresets = {
            'high': { nvenc: 18, vaapi: 18, qsv: 18, amf: 18, software: 18 },
            'medium': { nvenc: 24, vaapi: 24, qsv: 24, amf: 24, software: 23 },
            'low': { nvenc: 30, vaapi: 30, qsv: 30, amf: 30, software: 28 }
        };
        const qp = qualityPresets[quality] || qualityPresets.medium;

        switch (encoder) {
            case 'nvenc':
                this.addNvencEncoderArgs(args, resolution, qp.nvenc);
                break;
            case 'amf':
                this.addAmfEncoderArgs(args, resolution, qp.amf);
                break;
            case 'vaapi':
                this.addVaapiEncoderArgs(args, resolution, qp.vaapi);
                break;
            case 'qsv':
                this.addQsvEncoderArgs(args, resolution, qp.qsv);
                break;
            case 'software':
            case 'auto':
            default:
                this.addSoftwareEncoderArgs(args, resolution, qp.software);
                break;
        }
    }

    /**
     * Get target height based on maxResolution setting
     */
    getTargetHeight() {
        const resolutionMap = {
            '4k': 2160,
            '1080p': 1080,
            '720p': 720,
            '480p': 480
        };
        return resolutionMap[this.options.maxResolution] || 1080;
    }

    /**
     * NVIDIA NVENC encoder arguments
     */
    addNvencEncoderArgs(args, height, qp) {
        // Video filter for scaling on GPU
        args.push('-vf', `scale_cuda=-2:${height}:interp_algo=lanczos`);

        // NVENC encoder with quality settings
        // Using portable options that work across FFmpeg builds
        args.push(
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',           // Balanced preset (p1=fastest, p7=best)
            '-rc', 'constqp',          // Constant QP mode
            '-qp', String(qp),
            '-bf', '3'                 // B-frames for better compression
        );
    }

    /**
     * AMD AMF encoder arguments
     */
    addAmfEncoderArgs(args, height, qp) {
        // CPU decoding + software scale + AMF encode
        args.push('-vf', `scale=-2:${height}`);

        args.push(
            '-c:v', 'h264_amf',
            '-quality', 'quality',     // Quality preset
            '-rc', 'cqp',              // Constant QP
            '-qp_i', String(qp),
            '-qp_p', String(qp + 2),
            '-qp_b', String(qp + 4)
        );
    }

    /**
     * VAAPI encoder arguments (Linux)
     */
    addVaapiEncoderArgs(args, height, qp) {
        // VAAPI filter chain:
        // 1. scale_vaapi to resize on GPU
        // 2. Ensure output format is nv12 for maximum encoder compatibility
        // The format is handled automatically when using -hwaccel_output_format vaapi
        args.push('-vf', `scale_vaapi=w=-2:h=${height}:format=nv12`);

        // VAAPI encoder with quality setting
        // Note: -global_quality is the portable way to set quality for VAAPI
        args.push(
            '-c:v', 'h264_vaapi',
            '-profile:v', 'main',      // Use main profile for compatibility
            '-global_quality', String(qp),
            '-bf', '3'
        );
    }

    /**
     * Intel QuickSync encoder arguments
     */
    addQsvEncoderArgs(args, height, qp) {
        // Scale on QSV
        args.push('-vf', `scale_qsv=w=-2:h=${height}`);

        args.push(
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', String(qp),
            '-look_ahead', '1',
            '-look_ahead_depth', '40'
        );
    }

    /**
     * Software encoder arguments (fallback)
     */
    addSoftwareEncoderArgs(args, height, crf) {
        // Software scaling
        args.push('-vf', `scale=-2:${height}`);

        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Fast for real-time
            '-crf', String(crf),
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility (fixes 10-bit input errors)
        );
    }

    /**
     * Stop the transcoding process
     */
    stop() {
        if (this.process) {
            console.log(`[TranscodeSession ${this.id}] Stopping FFmpeg process`);
            this.process.kill('SIGTERM');
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
            }, 2000);
        }
        this.status = 'stopped';
    }

    /**
     * Update last access time (prevents cleanup)
     */
    touch() {
        this.lastAccess = Date.now();
    }

    /**
     * Check if playlist exists and is ready
     */
    async isPlaylistReady() {
        try {
            await fs.access(this.playlistPath);
            const content = await fs.readFile(this.playlistPath, 'utf8');
            // Check if playlist has at least one segment
            return content.includes('.ts');
        } catch {
            return false;
        }
    }

    /**
     * Wait for playlist to be ready (with timeout)
     */
    async waitForPlaylist(timeoutMs = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (await this.isPlaylistReady()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return false;
    }

    /**
     * Get the HLS playlist content
     */
    async getPlaylist() {
        this.touch();
        try {
            return await fs.readFile(this.playlistPath, 'utf8');
        } catch (err) {
            return null;
        }
    }

    /**
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        const segmentPath = path.join(this.dir, segmentName);
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Save session metadata to disk for recovery
     */
    async persist() {
        const metadata = {
            id: this.id,
            url: this.url,
            status: this.status,
            startTime: this.startTime,
            lastAccess: this.lastAccess,
            options: this.options,
            seekOffset: this.options.seekOffset
        };
        const metaPath = path.join(this.dir, 'session.json');
        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Restore a session from disk metadata
     */
    static async restore(sessionDir) {
        const metaPath = path.join(sessionDir, 'session.json');
        try {
            const data = await fs.readFile(metaPath, 'utf8');
            const metadata = JSON.parse(data);
            const session = new TranscodeSession(metadata.url, metadata.options);
            session.id = metadata.id;
            session.dir = sessionDir;
            session.playlistPath = path.join(sessionDir, 'stream.m3u8');
            session.startTime = metadata.startTime;
            session.lastAccess = metadata.lastAccess;
            session.status = 'stopped'; // Not running after restart
            return session;
        } catch (err) {
            console.error(`Failed to restore session from ${sessionDir}:`, err.message);
            return null;
        }
    }

    /**
     * Delete session directory and all segments
     */
    async cleanup() {
        this.stop();
        try {
            await fs.rm(this.dir, { recursive: true, force: true });
            console.log(`[TranscodeSession ${this.id}] Cleaned up session directory`);
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Failed to cleanup:`, err.message);
        }
    }
}

/**
 * Session Manager
 */

/**
 * Create a new transcode session
 */
async function createSession(url, options = {}) {
    await ensureCacheDir();
    const session = new TranscodeSession(url, options);
    sessions.set(session.id, session);
    return session;
}

/**
 * Get an existing session by ID
 */
function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.touch();
    }
    return session;
}

/**
 * Get or create a session for a URL (reuses existing if still valid)
 */
async function getOrCreateSession(url, options = {}) {
    // Check for existing session with same URL
    for (const session of sessions.values()) {
        if (session.url === url && session.status === 'running') {
            session.touch();
            return session;
        }
    }
    // Create new session
    return createSession(url, options);
}

/**
 * Stop and remove a session
 */
async function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        await session.cleanup();
        sessions.delete(sessionId);
    }
}

/**
 * Cleanup stale sessions (idle for too long)
 */
async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            await removeSession(id);
        }
    }
}

/**
 * Recover sessions from disk after server restart
 */
async function recoverSessions() {
    try {
        await fs.access(CACHE_DIR);
        const dirs = await fs.readdir(CACHE_DIR, { withFileTypes: true });

        for (const dirent of dirs) {
            if (dirent.isDirectory()) {
                const sessionDir = path.join(CACHE_DIR, dirent.name);
                const session = await TranscodeSession.restore(sessionDir);
                if (session) {
                    sessions.set(session.id, session);
                    console.log(`[TranscodeSession] Recovered session ${session.id}`);
                }
            }
        }
    } catch (err) {
        // Cache dir doesn't exist yet, that's fine
        if (err.code !== 'ENOENT') {
            console.error('[TranscodeSession] Error recovering sessions:', err.message);
        }
    }
}

/**
 * Start cleanup interval
 */
let cleanupInterval = null;
function startCleanupInterval() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref(); // Don't prevent process exit
    }
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getAllSessions() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        url: s.url,
        status: s.status,
        startTime: s.startTime,
        lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess
    }));
}

module.exports = {
    TranscodeSession,
    createSession,
    getSession,
    getOrCreateSession,
    removeSession,
    cleanupStaleSessions,
    recoverSessions,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION
};
