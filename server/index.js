const express = require('express');
const path = require('path');
const passport = require('passport');

// Initialize database
require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy headers (X-Forwarded-Proto, X-Forwarded-For, etc.)
// Required for correct protocol detection behind reverse proxies (nginx, Caddy, etc.)
app.set('trust proxy', true);

// Middleware
app.use(express.json({ limit: '50mb' }));

// Initialize Passport
app.use(passport.initialize());

app.use(express.static(path.join(__dirname, '..', 'public')));

// FFMPEG Configuration (optional - for transcoding support)
// Priority: 1. System FFmpeg (better Docker DNS support), 2. ffmpeg-static npm package
const { execSync } = require('child_process');

function findFFmpeg() {
    // Try system FFmpeg first (better Docker compatibility)
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        console.log('FFmpeg binary configured at: ffmpeg (system)');
        return 'ffmpeg';
    } catch (e) {
        // System FFmpeg not found, try ffmpeg-static
    }

    // Try ffmpeg-static npm package
    try {
        let ffmpegPath = require('ffmpeg-static');
        // In packaged Electron apps, ffmpeg-static returns path inside .asar archive
        // but the binary is actually unpacked to app.asar.unpacked
        if (ffmpegPath && ffmpegPath.includes('app.asar')) {
            ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
        }
        console.log('FFmpeg binary configured at:', ffmpegPath);
        return ffmpegPath;
    } catch (err) {
        console.warn('FFmpeg not available - transcoding/remuxing will be disabled.');
        console.warn('Install FFmpeg via your package manager or npm install ffmpeg-static');
        return null;
    }
}

app.locals.ffmpegPath = findFFmpeg();

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/proxy', require('./routes/proxy'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/transcode', require('./routes/transcode'));
app.use('/api/remux', require('./routes/remux'));
app.use('/api/settings', require('./routes/settings'));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`NodeCast TV server running on http://localhost:${PORT}`);
});
