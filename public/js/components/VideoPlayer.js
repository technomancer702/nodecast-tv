/**
 * Video Player Component
 * Handles HLS video playback with custom controls
 */

class VideoPlayer {
    constructor() {
        this.video = document.getElementById('video-player');
        this.container = document.querySelector('.video-container');
        this.overlay = document.getElementById('player-overlay');
        this.nowPlaying = document.getElementById('now-playing');
        this.hls = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.isUsingProxy = false;
        this.currentUrl = null;

        // Settings (loaded from localStorage)
        this.settings = this.loadSettings();

        this.init();
    }

    /**
     * Load settings from localStorage
     */
    loadSettings() {
        const defaults = {
            arrowKeysChangeChannel: true, // Use arrow keys for channel navigation
            overlayDuration: 5, // Seconds
            defaultVolume: 80, // 0-100
            rememberVolume: true, // Persist volume between sessions
            lastVolume: 80, // Last used volume (if rememberVolume is true)
            autoPlayNextEpisode: false, // Auto-play next episode in series
            forceProxy: false, // Force all streams through backend proxy
            forceTranscode: false, // Force audio transcoding (fixes Dolby/AC3 audio)
            forceRemux: false // Force remux to MP4 (fixes raw .ts streams, lightweight)
        };
        try {
            const saved = localStorage.getItem('nodecast_tv_player_settings');
            if (saved) {
                return { ...defaults, ...JSON.parse(saved) };
            }
        } catch (err) {
            console.error('Error loading settings:', err);
        }
        return defaults;
    }

    /**
     * Save settings to localStorage
     */
    saveSettings() {
        try {
            localStorage.setItem('nodecast_tv_player_settings', JSON.stringify(this.settings));
        } catch (err) {
            console.error('Error saving settings:', err);
        }
    }

    /**
     * Get HLS.js configuration with buffer settings optimized for stable playback
     */
    getHlsConfig() {
        return {
            enableWorker: true,
            // Buffer settings to prevent underruns during background tab throttling
            maxBufferLength: 30,           // Buffer up to 30 seconds of content
            maxMaxBufferLength: 60,        // Absolute max buffer 60 seconds
            maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
            maxBufferHole: 1.0,            // Allow 1s holes in buffer (helps with discontinuities)
            // Live stream settings - stay further from live edge for stability
            liveSyncDurationCount: 3,      // Stay 3 segments behind live
            liveMaxLatencyDurationCount: 10, // Allow up to 10 segments behind before catching up
            liveBackBufferLength: 30,      // Keep 30s of back buffer for seeking
            // Audio discontinuity handling (fixes garbled audio during ad transitions)
            stretchShortVideoTrack: true,  // Stretch short segments to avoid gaps
            forceKeyFrameOnDiscontinuity: true, // Force keyframe sync on discontinuity
            // Audio drift tolerance - higher = less aggressive correction = fewer glitches
            // 1 frame = ~23ms at 44.1kHz, so 4 frames = ~92ms tolerance
            maxAudioFramesDrift: 4,        // Allow ~92ms audio drift before correction
            // Disable progressive/streaming mode for stability with discontinuities
            progressive: false,
            // Stall recovery settings
            nudgeOffset: 0.2,              // Larger nudge steps for recovery (default 0.1)
            nudgeMaxRetry: 6,              // More retry attempts (default 3)
            // Faster recovery from errors
            levelLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            // Caption/Subtitle settings
            enableCEA708Captions: true,    // Enable CEA-708 closed captions
            enableWebVTT: true,            // Enable WebVTT subtitles
            renderTextTracksNatively: true // Use native browser rendering for text tracks
        };
    }

    init() {
        // Apply default/remembered volume
        const volume = this.settings.rememberVolume ? this.settings.lastVolume : this.settings.defaultVolume;
        this.video.volume = volume / 100;

        // Save volume changes
        this.video.addEventListener('volumechange', () => {
            if (this.settings.rememberVolume) {
                this.settings.lastVolume = Math.round(this.video.volume * 100);
                this.saveSettings();
            }
        });

        // Initialize HLS.js if supported
        if (Hls.isSupported()) {
            this.hls = new Hls(this.getHlsConfig());
            this.lastDiscontinuity = -1; // Track discontinuity changes

            this.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data.type, data.details);
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            // Track network retry attempts
                            this.networkRetryCount = (this.networkRetryCount || 0) + 1;
                            const now = Date.now();
                            const timeSinceLastNetworkError = now - (this.lastNetworkErrorTime || 0);
                            this.lastNetworkErrorTime = now;

                            // Reset retry count if it's been more than 30 seconds since last error
                            if (timeSinceLastNetworkError > 30000) {
                                this.networkRetryCount = 1;
                            }

                            console.log(`Network error (attempt ${this.networkRetryCount}/3):`, data.details);

                            if (this.networkRetryCount <= 3 && !this.isUsingProxy) {
                                // Retry with increasing delay (1s, 2s, 3s)
                                const retryDelay = this.networkRetryCount * 1000;
                                console.log(`[HLS] Retrying in ${retryDelay}ms...`);
                                setTimeout(() => {
                                    if (this.hls) {
                                        this.hls.startLoad();
                                    }
                                }, retryDelay);
                            } else if (!this.isUsingProxy) {
                                // After 3 retries, try proxy
                                console.log('[HLS] Max retries reached, switching to proxy...');
                                this.networkRetryCount = 0;
                                this.isUsingProxy = true;
                                const proxiedUrl = this.getProxiedUrl(this.currentUrl);
                                this.hls.loadSource(proxiedUrl);
                                this.hls.startLoad();
                            } else {
                                // Already using proxy, just retry
                                console.log('[HLS] Network error on proxy, retrying...');
                                this.hls.startLoad();
                            }
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Media error, attempting recovery...');
                            this.hls.recoverMediaError();
                            break;
                        default:
                            this.stop();
                            break;
                    }
                } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Non-fatal media error - try to recover with cooldown to prevent loops
                    const now = Date.now();
                    const timeSinceLastRecovery = now - (this.lastRecoveryAttempt || 0);

                    // Only attempt recovery if more than 2 seconds since last attempt
                    if (timeSinceLastRecovery > 2000) {
                        console.log('Non-fatal media error:', data.details, '- attempting recovery');
                        this.lastRecoveryAttempt = now;
                        this.hls.recoverMediaError();

                        // If fragParsingError, also seek forward slightly to skip corrupted segment
                        if (data.details === 'fragParsingError' && !this.video.paused && this.video.currentTime > 0) {
                            console.log('[HLS] Seeking past corrupted segment...');
                            setTimeout(() => {
                                if (this.video && !this.video.paused) {
                                    this.video.currentTime += 1;
                                }
                            }, 200);
                        }
                    } else {
                        // Too many errors in quick succession - log but don't spam recovery
                        console.log('Non-fatal media error (cooldown):', data.details);
                    }
                } else if (data.details === 'bufferAppendError') {
                    // Buffer errors during ad transitions - try recovery
                    console.log('Buffer append error, recovering...');
                    this.hls.recoverMediaError();
                }
            });

            // Detect audio track switches (can cause audio glitches on some streams)
            this.hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (event, data) => {
                console.log('Audio track switched:', data);
            });

            // Detect buffer stalls which may indicate codec issues
            this.hls.on(Hls.Events.BUFFER_STALLED_ERROR, () => {
                console.log('Buffer stalled, attempting recovery...');
                this.hls.recoverMediaError();
            });

            // Detect discontinuity changes (ad transitions) and help decoder reset
            this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                const frag = data.frag;
                // Debug: log every fragment change
                console.log(`[HLS] FRAG_CHANGED: sn=${frag?.sn}, cc=${frag?.cc}, level=${frag?.level}`);

                if (frag && frag.sn !== 'initSegment') {
                    // Check if we crossed a discontinuity boundary using CC (Continuity Counter)
                    if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                        console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                        this.lastDiscontinuity = frag.cc;

                        // Small nudge to help decoder sync (only if playing)
                        if (!this.video.paused && this.video.currentTime > 0) {
                            const nudgeAmount = 0.01;
                            this.video.currentTime += nudgeAmount;
                        }
                    }
                }
            });

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.video.play().catch(e => console.log('Autoplay prevented:', e));
            });
        }

        // Keyboard controls
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Click on video shows overlay
        this.video.addEventListener('click', () => this.showNowPlayingOverlay());
    }

    /**
     * Show the now playing overlay briefly
     */
    showNowPlayingOverlay() {
        if (!this.currentChannel) return;

        // Clear existing timer
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }

        // Show overlay
        this.nowPlaying.classList.remove('hidden');

        // Hide after duration
        this.overlayTimer = setTimeout(() => {
            this.nowPlaying.classList.add('hidden');
        }, this.settings.overlayDuration * 1000);
    }

    /**
     * Hide the now playing overlay
     */
    hideNowPlayingOverlay() {
        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }
        this.nowPlaying.classList.add('hidden');
    }

    /**
     * Play a channel
     */
    async play(channel, streamUrl) {
        this.currentChannel = channel;

        try {
            // Stop current playback
            this.stop();

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Determine if HLS or direct stream
            this.currentUrl = streamUrl;

            // CHECK: Force Transcode Priority - transcoded streams bypass HLS.js
            if (this.settings.forceTranscode) {
                console.log('[Player] Force Transcode enabled. Routing through ffmpeg...');
                const transcodeUrl = this.getTranscodeUrl(streamUrl);
                this.currentUrl = transcodeUrl;

                // Transcoded streams are fragmented MP4 - play directly with <video> element
                console.log('[Player] Playing transcoded stream directly:', transcodeUrl);
                this.video.src = transcodeUrl;
                this.video.play().catch(e => console.log('[Player] Autoplay prevented:', e));

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return; // Exit early - don't use HLS.js path
            }

            // Proactively use proxy for:
            // 1. User enabled "Force Proxy" in settings
            // 2. Known CORS-restricted domains (like Pluto TV)
            // Note: Xtream sources are NOT auto-proxied because many providers IP-lock streams
            const proxyRequiredDomains = ['pluto.tv'];
            const needsProxy = this.settings.forceProxy || proxyRequiredDomains.some(domain => streamUrl.includes(domain));

            this.isUsingProxy = needsProxy;
            const finalUrl = needsProxy ? this.getProxiedUrl(streamUrl) : streamUrl;

            // Detect if this is likely an HLS stream (has .m3u8 in URL)
            const looksLikeHls = finalUrl.includes('.m3u8') || finalUrl.includes('m3u8');

            // Check if this looks like a raw stream (no HLS manifest, no common video extensions)
            // This includes .ts files AND extension-less URLs that might be TS streams
            const isRawTs = finalUrl.includes('.ts') && !finalUrl.includes('.m3u8');
            const isExtensionless = !finalUrl.includes('.m3u8') &&
                !finalUrl.includes('.mp4') &&
                !finalUrl.includes('.mkv') &&
                !finalUrl.includes('.avi') &&
                !finalUrl.includes('.ts');

            // Force Remux: Route through FFmpeg for container conversion
            // Applies to: 1) .ts streams when detected, or 2) ALL non-HLS streams when enabled
            if (this.settings.forceRemux && (isRawTs || isExtensionless)) {
                console.log('[Player] Force Remux enabled. Routing through FFmpeg remux...');
                console.log('[Player] Stream type:', isRawTs ? 'Raw TS' : 'Extension-less (assumed TS)');
                const remuxUrl = this.getRemuxUrl(streamUrl);
                this.video.src = remuxUrl;
                this.video.play().catch(e => console.log('[Player] Autoplay prevented:', e));

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return;
            }

            // If raw TS detected without Force Remux enabled, show error
            if (isRawTs && !this.settings.forceRemux) {
                console.warn('[Player] Raw MPEG-TS stream detected. Browsers cannot play .ts files directly.');
                this.showError(
                    'This stream uses raw MPEG-TS format (.ts) which browsers cannot play directly.<br><br>' +
                    '<strong>To fix this:</strong><br>' +
                    '1. Enable <strong>"Force Remux"</strong> in Settings → Streaming<br>' +
                    '2. Or configure your source to output HLS (.m3u8) format'
                );
                return;
            }

            // Priority 1: Use HLS.js for HLS streams on browsers that support it
            if (looksLikeHls && Hls.isSupported()) {
                this.hls = new Hls(this.getHlsConfig());
                this.hls.loadSource(finalUrl);
                this.hls.attachMedia(this.video);

                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.video.play().catch(e => console.log('Autoplay prevented:', e));
                });

                // Re-attach error handler for the new Hls instance
                this.hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        // CORS issues can manifest as NETWORK_ERROR or MEDIA_ERROR with fragParsingError
                        const isCorsLikely = data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                            (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.details === 'fragParsingError');

                        if (isCorsLikely && !this.isUsingProxy) {
                            console.log('CORS/Network error detected, retrying via proxy...', data.details);
                            this.isUsingProxy = true;
                            this.hls.loadSource(this.getProxiedUrl(this.currentUrl));
                            this.hls.startLoad();
                        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                            // Fatal media error - try recovery with cooldown
                            const now = Date.now();
                            if (now - (this.lastRecoveryAttempt || 0) > 2000) {
                                console.log('Fatal media error, attempting recovery...');
                                this.lastRecoveryAttempt = now;
                                this.hls.recoverMediaError();
                            }
                        } else {
                            console.error('Fatal HLS error:', data);
                        }
                    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                        // Non-fatal media error - already handled in init(), skip duplicate handling
                    }
                });

                // Detect discontinuity changes (ad transitions) for logging only
                this.lastDiscontinuity = -1;
                this.hls.on(Hls.Events.FRAG_CHANGED, (event, data) => {
                    const frag = data.frag;
                    if (frag && frag.sn !== 'initSegment') {
                        // Log discontinuity changes for debugging
                        if (frag.cc !== undefined && frag.cc !== this.lastDiscontinuity) {
                            console.log(`[HLS] Discontinuity detected: CC ${this.lastDiscontinuity} -> ${frag.cc}`);
                            this.lastDiscontinuity = frag.cc;
                            // Note: maxAudioFramesDrift: 4 handles audio sync naturally
                            // No manual seeking needed - it can cause more issues than it solves
                        }
                    }
                });
            } else if (this.video.canPlayType('application/vnd.apple.mpegurl') === 'probably' ||
                this.video.canPlayType('application/vnd.apple.mpegurl') === 'maybe') {
                // Priority 2: Native HLS support (Safari on iOS/macOS where HLS.js may not work)
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    console.log('Autoplay prevented, trying proxy if CORS error:', e);
                    if (!this.isUsingProxy) {
                        this.isUsingProxy = true;
                        this.video.src = this.getProxiedUrl(streamUrl);
                        this.video.play().catch(err => console.error('Proxy play failed:', err));
                    }
                });
            } else {
                // Priority 3: Try direct playback for non-HLS streams
                this.video.src = finalUrl;
                this.video.play().catch(e => console.log('Autoplay prevented:', e));
            }

            // Update now playing info
            this.updateNowPlaying(channel);

            // Show the now playing overlay
            this.showNowPlayingOverlay();

            // Fetch EPG data for this channel
            this.fetchEpgData(channel);

            // Dispatch event
            window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));

        } catch (err) {
            console.error('Error playing channel:', err);
            this.showError('Failed to play channel');
        }
    }

    /**
     * Fetch EPG data for current channel
     */
    async fetchEpgData(channel) {
        try {
            // First, try to use the centralized EpgGuide data (already loaded)
            if (window.app && window.app.epgGuide && window.app.epgGuide.programmes) {
                const epgGuide = window.app.epgGuide;

                // Get current program from EpgGuide
                const currentProgram = epgGuide.getCurrentProgram(channel.tvgId, channel.name);

                if (currentProgram) {
                    // Find upcoming programs from the guide's data
                    const epgChannel = epgGuide.channelMap?.get(channel.tvgId) ||
                        epgGuide.channelMap?.get(channel.name?.toLowerCase());

                    let upcoming = [];
                    if (epgChannel) {
                        const now = Date.now();
                        upcoming = epgGuide.programmes
                            .filter(p => p.channelId === epgChannel.id && new Date(p.start).getTime() > now)
                            .slice(0, 5)
                            .map(p => ({
                                title: p.title,
                                start: new Date(p.start),
                                stop: new Date(p.stop),
                                description: p.desc || ''
                            }));
                    }

                    this.updateNowPlaying(channel, {
                        current: {
                            title: currentProgram.title,
                            start: new Date(currentProgram.start),
                            stop: new Date(currentProgram.stop),
                            description: currentProgram.desc || ''
                        },
                        upcoming
                    });
                    return; // Success, exit early
                }
            }

            // Fallback: Try to get EPG from Xtream API if available
            if (channel.sourceType === 'xtream' && channel.streamId) {
                const epgData = await API.proxy.xtream.shortEpg(channel.sourceId, channel.streamId);
                if (epgData && epgData.epg_listings && epgData.epg_listings.length > 0) {
                    const listings = epgData.epg_listings;
                    const now = Math.floor(Date.now() / 1000);

                    // Find current program
                    const current = listings.find(p => {
                        const start = parseInt(p.start_timestamp);
                        const end = parseInt(p.stop_timestamp);
                        return start <= now && end > now;
                    });

                    // Get upcoming programs
                    const upcoming = listings
                        .filter(p => parseInt(p.start_timestamp) > now)
                        .slice(0, 5)
                        .map(p => ({
                            title: this.decodeBase64(p.title),
                            start: new Date(parseInt(p.start_timestamp) * 1000),
                            stop: new Date(parseInt(p.stop_timestamp) * 1000),
                            description: this.decodeBase64(p.description)
                        }));

                    if (current) {
                        this.updateNowPlaying(channel, {
                            current: {
                                title: this.decodeBase64(current.title),
                                start: new Date(parseInt(current.start_timestamp) * 1000),
                                stop: new Date(parseInt(current.stop_timestamp) * 1000),
                                description: this.decodeBase64(current.description)
                            },
                            upcoming
                        });
                    }
                }
            }
        } catch (err) {
            console.log('EPG data not available:', err.message);
        }
    }

    /**
     * Get proxied URL for a stream
     */
    getProxiedUrl(url) {
        return `/api/proxy/stream?url=${encodeURIComponent(url)}`;
    }

    /**
     * Get transcoded URL for a stream (audio transcoding for browser compatibility)
     */
    getTranscodeUrl(url) {
        return `/api/transcode?url=${encodeURIComponent(url)}`;
    }

    /**
     * Get remuxed URL for a stream (container conversion only, no re-encoding)
     * Used for raw .ts streams that browsers can't play directly
     */
    getRemuxUrl(url) {
        return `/api/remux?url=${encodeURIComponent(url)}`;
    }

    /**
     * Decode base64 EPG data
     */
    decodeBase64(str) {
        if (!str) return '';
        try {
            return decodeURIComponent(escape(atob(str)));
        } catch {
            return str;
        }
    }

    /**
     * Stop playback
     */
    stop() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.video.pause();
        this.video.src = '';
        this.video.load();
    }

    /**
     * Update now playing display
     */
    updateNowPlaying(channel, epgData = null) {
        const channelName = this.nowPlaying.querySelector('.channel-name');
        const programTitle = this.nowPlaying.querySelector('.program-title');
        const programTime = this.nowPlaying.querySelector('.program-time');
        const upNextList = document.getElementById('up-next-list');

        channelName.textContent = channel.name || channel.tvgName || 'Unknown Channel';

        if (epgData && epgData.current) {
            programTitle.textContent = epgData.current.title;
            const start = new Date(epgData.current.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const end = new Date(epgData.current.stop).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            programTime.textContent = `${start} - ${end}`;
        } else {
            programTitle.textContent = '';
            programTime.textContent = '';
        }

        // Update up next
        upNextList.innerHTML = '';
        if (epgData && epgData.upcoming) {
            epgData.upcoming.slice(0, 3).forEach(prog => {
                const li = document.createElement('li');
                const time = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                li.textContent = `${time} - ${prog.title}`;
                upNextList.appendChild(li);
            });
        }
    }

    /**
     * Show error overlay
     */
    showError(message) {
        this.overlay.classList.remove('hidden');
        this.overlay.querySelector('.overlay-content').innerHTML = `<p style="color: var(--color-error);">${message}</p>`;
    }

    /**
     * Handle keyboard shortcuts
     */
    handleKeyboard(e) {
        if (document.activeElement.tagName === 'INPUT') return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.video.paused ? this.video.play() : this.video.pause();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.video.muted = !this.video.muted;
                break;
            case 'ArrowUp':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowDown':
                if (!this.settings.arrowKeysChangeChannel) {
                    e.preventDefault();
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                // If arrowKeysChangeChannel is true, let HomePage handle it
                break;
            case 'ArrowLeft':
                e.preventDefault();
                // Volume down when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.max(0, this.video.volume - 0.1);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                // Volume up when arrow keys are for channels
                if (this.settings.arrowKeysChangeChannel) {
                    this.video.volume = Math.min(1, this.video.volume + 0.1);
                }
                break;
            case 'PageUp':
            case 'ChannelUp':
                e.preventDefault();
                this.channelUp();
                break;
            case 'PageDown':
            case 'ChannelDown':
                e.preventDefault();
                this.channelDown();
                break;
            case 'i':
                // Show/hide info overlay
                e.preventDefault();
                if (this.nowPlaying.classList.contains('hidden')) {
                    this.showNowPlayingOverlay();
                } else {
                    this.hideNowPlayingOverlay();
                }
                break;
        }
    }

    /**
     * Go to previous channel
     */
    channelUp() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const prevIdx = currentIdx <= 0 ? channels.length - 1 : currentIdx - 1;
        window.app.channelList.selectChannel({ channelId: channels[prevIdx].id });
    }

    /**
     * Go to next channel
     */
    channelDown() {
        if (!window.app?.channelList) return;
        const channels = window.app.channelList.getVisibleChannels();
        if (channels.length === 0) return;

        const currentIdx = this.currentChannel
            ? channels.findIndex(c => c.id === this.currentChannel.id)
            : -1;

        const nextIdx = currentIdx >= channels.length - 1 ? 0 : currentIdx + 1;
        window.app.channelList.selectChannel({ channelId: channels[nextIdx].id });
    }

    /**
     * Toggle fullscreen
     */
    toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else if (this.container) {
            this.container.requestFullscreen();
        }
    }
}

// Export
window.VideoPlayer = VideoPlayer;
