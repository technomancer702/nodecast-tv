/**
 * Video Player Component
 * Handles HLS video playback with custom controls
 */

// Check if device is mobile
function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

class VideoPlayer {
    constructor() {
        this.video = document.getElementById('video-player');

        // iOS: ensure inline playback (not fullscreen by default)
        if (this.video) {
            this.video.setAttribute('playsinline', '');
            this.video.setAttribute('webkit-playsinline', '');
        }

        this.container = document.querySelector('.video-container');
        this.overlay = document.getElementById('player-overlay');
        this.nowPlaying = document.getElementById('now-playing');
        this.hls = null;
        this.currentChannel = null;
        this.overlayTimer = null;
        this.overlayDuration = 5000; // 5 seconds
        this.isUsingProxy = false;
        this.currentUrl = null;
        this.settingsLoaded = false;

        // Settings - start with defaults, load from server async
        this.settings = this.getDefaultSettings();

        // Load settings from server, then init
        this.loadSettingsFromServer().then(() => {
            this.init();
        });
    }

    /**
     * Default settings
     */
    getDefaultSettings() {
        return {
            arrowKeysChangeChannel: true,
            overlayDuration: 5,
            defaultVolume: 80,
            rememberVolume: true,
            lastVolume: 80,
            autoPlayNextEpisode: false,
            forceProxy: false,
            forceTranscode: false,
            forceRemux: false,
            autoTranscode: true,
            streamFormat: 'm3u8',
            epgRefreshInterval: '24'
        };
    }

    /**
     * Load settings from server API
     */
    async loadSettingsFromServer() {
        try {
            const serverSettings = await API.settings.get();
            this.settings = { ...this.getDefaultSettings(), ...serverSettings };
            this.settingsLoaded = true;
            console.log('[Player] Settings loaded from server');
        } catch (err) {
            console.warn('[Player] Failed to load settings from server, using defaults:', err.message);
            // Fall back to localStorage for backwards compatibility
            try {
                const saved = localStorage.getItem('nodecast_tv_player_settings');
                if (saved) {
                    this.settings = { ...this.getDefaultSettings(), ...JSON.parse(saved) };
                    console.log('[Player] Settings loaded from localStorage (fallback)');
                }
            } catch (localErr) {
                console.error('[Player] Error loading localStorage settings:', localErr);
            }
        }
    }

    /**
     * Save settings to server API
     */
    async saveSettings() {
        try {
            await API.settings.update(this.settings);
            console.log('[Player] Settings saved to server');
        } catch (err) {
            console.error('[Player] Error saving settings to server:', err);
            // Also save to localStorage as backup
            try {
                localStorage.setItem('nodecast_tv_player_settings', JSON.stringify(this.settings));
            } catch (localErr) {
                console.error('[Player] Error saving to localStorage:', localErr);
            }
        }
    }

    /**
     * Legacy sync method for compatibility - calls async version
     */
    loadSettings() {
        return this.settings;
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
            // Audio settings - prevent glitches during stream transitions
            // Higher drift tolerance = less aggressive correction = fewer glitches
            maxAudioFramesDrift: 8,        // Allow ~185ms audio drift before correction (was 4)
            // Disable progressive/streaming mode for stability with discontinuities
            progressive: false,
            // Stall recovery settings
            nudgeOffset: 0.2,              // Larger nudge steps for recovery (default 0.1)
            nudgeMaxRetry: 6,              // More retry attempts (default 3)
            // Faster recovery from errors
            levelLoadingMaxRetry: 4,
            manifestLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 6,
            // Low latency mode off for more stable audio
            lowLatencyMode: false,
            // Caption/Subtitle settings
            enableCEA708Captions: true,    // Enable CEA-708 closed captions
            enableWebVTT: true,            // Enable WebVTT subtitles
            renderTextTracksNatively: true // Use native browser rendering for text tracks
        };
    }

    /**
     * Initialize custom video controls for mobile
     */
    /**
     * Initialize custom video controls
     */
    initCustomControls() {
        // Elements
        this.controlsOverlay = document.getElementById('player-controls-overlay');
        this.loadingSpinner = document.getElementById('player-loading');

        // iOS Safari: detect and compensate for floating bottom toolbar
        const updateIosUiBottom = () => {
            let uiBottom = 0;
            if (window.visualViewport) {
                const vv = window.visualViewport;
                uiBottom = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
            }
            document.documentElement.style.setProperty('--ios-ui-bottom', uiBottom + 'px');
        };

        updateIosUiBottom();

        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateIosUiBottom);
            window.visualViewport.addEventListener('scroll', updateIosUiBottom);
        } else {
            window.addEventListener('resize', updateIosUiBottom);
        }

        // iOS: use custom --vh unit to avoid 100vh issues with dynamic toolbar
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
        if (isIOS && this.container) {
            const vh = window.innerHeight * 0.01;
            document.documentElement.style.setProperty('--vh', `${vh}px`);
            this.container.style.height = 'calc(var(--vh) * 100)';
        }

        // Apply safe area + iOS toolbar padding to controls overlay
        if (this.controlsOverlay) {
            this.controlsOverlay.style.paddingBottom = 'calc(env(safe-area-inset-bottom, 0px) + var(--ios-ui-bottom, 0px) + 12px)';
        }

        const btnPlay = document.getElementById('btn-play');
        const btnMute = document.getElementById('btn-mute');
        const btnFullscreen = document.getElementById('btn-fullscreen');
        const volumeSlider = document.getElementById('player-volume');
        const channelNameEl = document.getElementById('player-channel-name');

        if (!this.controlsOverlay) return;

        // Disable native controls
        this.video.controls = false;

        // Initial State: Hide all overlay elements until content is loaded
        this.loadingSpinner?.classList.remove('show');
        this.controlsOverlay?.classList.add('hidden');

        // Play/Pause toggle
        const togglePlay = () => {
            if (this.video.paused) {
                this.video.play();
            } else {
                this.video.pause();
            }
        };

        btnPlay?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Center play button (large button shown when paused)
        const centerPlayBtn = document.getElementById('player-center-play');
        centerPlayBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Click on video to toggle play/pause
        this.video?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePlay();
        });

        // Update play/pause UI
        const updatePlayUI = () => {
            const isPaused = this.video.paused;
            const hasVideo = this.video.src && this.video.src !== '' && this.video.readyState > 0;

            // Bottom bar button
            const iconPlay = btnPlay?.querySelector('.icon-play');
            const iconPause = btnPlay?.querySelector('.icon-pause');

            if (iconPlay && iconPause) {
                iconPlay.classList.toggle('hidden', !isPaused);
                iconPause.classList.toggle('hidden', isPaused);
            }

            // Center play button - show only when paused AND video is loaded
            if (centerPlayBtn) {
                centerPlayBtn.classList.toggle('show', isPaused && hasVideo);
            }
        };

        this.video.addEventListener('play', updatePlayUI);
        this.video.addEventListener('pause', updatePlayUI);

        // Loading spinner
        this.video.addEventListener('waiting', () => {
            this.loadingSpinner?.classList.add('show');
        });

        this.video.addEventListener('canplay', () => {
            this.loadingSpinner?.classList.remove('show');
        });

        // Mute/Volume
        const updateVolumeUI = () => {
            const isMuted = this.video.muted || this.video.volume === 0;
            const iconVol = btnMute?.querySelector('.icon-vol');
            const iconMuted = btnMute?.querySelector('.icon-muted');

            if (iconVol && iconMuted) {
                iconVol.classList.toggle('hidden', isMuted);
                iconMuted.classList.toggle('hidden', !isMuted);
            }

            if (volumeSlider) {
                volumeSlider.value = this.video.muted ? 0 : Math.round(this.video.volume * 100);
            }
        };

        btnMute?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.video.muted) {
                this.video.muted = false;
                this.video.volume = (parseInt(volumeSlider?.value || 80) / 100) || 0.8;
            } else {
                this.video.muted = true;
            }
            updateVolumeUI();
        });

        volumeSlider?.addEventListener('input', (e) => {
            e.stopPropagation();
            const val = parseInt(e.target.value);
            this.video.volume = val / 100;
            this.video.muted = val === 0;
            updateVolumeUI();
        });

        this.video.addEventListener('volumechange', updateVolumeUI);

        // Captions
        this.captionsBtn = document.getElementById('player-captions-btn');
        this.captionsMenu = document.getElementById('player-captions-menu');
        this.captionsList = document.getElementById('player-captions-list');
        this.captionsMenuOpen = false;

        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen &&
                !this.captionsMenu.contains(e.target) &&
                !this.captionsBtn.contains(e.target)) {
                this.closeCaptionsMenu();
            }
        });

        // Fullscreen
        btnFullscreen?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFullscreen();
        });

        // Picture-in-Picture
        const btnPip = document.getElementById('btn-pip');
        btnPip?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePictureInPicture();
        });

        // Overflow Menu
        const btnOverflow = document.getElementById('btn-overflow');
        const overflowMenu = document.getElementById('player-overflow-menu');

        btnOverflow?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const btnCopyUrl = document.getElementById('btn-copy-url');
        btnCopyUrl?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== btnOverflow) {
                overflowMenu.classList.add('hidden');
            }
        });

        this.container.addEventListener('dblclick', () => this.toggleFullscreen());

        // Overlay Auto-hide Logic
        let overlayTimeout;
        const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

        const showOverlay = () => {
            this.controlsOverlay.classList.remove('hidden');
            this.container.style.cursor = 'default';
            sidebarExpandBtn?.classList.add('visible');
            resetOverlayTimer();
        };

        const hideOverlay = () => {
            if (!this.video.paused) {
                this.controlsOverlay.classList.add('hidden');
                this.container.style.cursor = 'none';
                sidebarExpandBtn?.classList.remove('visible');
            }
        };

        const resetOverlayTimer = () => {
            clearTimeout(overlayTimeout);
            if (!this.video.paused) {
                overlayTimeout = setTimeout(hideOverlay, 3000);
            }
        };

        this.container.addEventListener('mousemove', showOverlay);
        this.container.addEventListener('click', (e) => {
            showOverlay();
            // Only toggle play if clicking directly on video or container (not controls)
            if (e.target === this.video || e.target === this.container || e.target.classList.contains('watch-overlay')) {
                togglePlay();
            }
        });
        this.container.addEventListener('touchstart', showOverlay);

        this.video.addEventListener('play', resetOverlayTimer);
        this.video.addEventListener('pause', showOverlay);

        // Update Title when channel changes
        window.addEventListener('channelChanged', (e) => {
            if (channelNameEl && e.detail) {
                channelNameEl.textContent = e.detail.name || e.detail.tvgName || 'Live TV';
            }
            showOverlay();
        });

        // Initial state
        updatePlayUI();
        updateVolumeUI();
    }

    /**
     * Toggle fullscreen mode (cross-browser including Safari)
     */
    toggleFullscreen() {
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        } else {
            const element = this.container;
            if (element.requestFullscreen) {
                element.requestFullscreen().catch(err => console.error('Fullscreen error:', err));
            } else if (element.webkitRequestFullscreen) {
                element.webkitRequestFullscreen();
            } else if (this.video.webkitEnterFullscreen) {
                // iOS Safari: use native video fullscreen
                this.video.webkitEnterFullscreen();
            }
        }
    }

    /**
     * Toggle Picture-in-Picture mode (cross-browser including Safari)
     */
    async togglePictureInPicture() {
        try {
            // Standard PiP API (Chrome, Edge, Firefox)
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
            // Safari fallback using webkitPresentationMode
            else if (typeof this.video.webkitSetPresentationMode === 'function') {
                const mode = this.video.webkitPresentationMode;
                this.video.webkitSetPresentationMode(mode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
            }
        } catch (err) {
            if (err.name !== 'NotAllowedError') {
                console.error('Picture-in-Picture error:', err);
            }
        }
    }

    /**
     * Copy current stream URL to clipboard
     */
    copyStreamUrl() {
        if (!this.currentUrl) {
            console.warn('[Player] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        navigator.clipboard.writeText(streamUrl).then(() => {
            // Show brief feedback
            const btn = document.getElementById('btn-copy-url');
            if (btn) {
                const originalText = btn.textContent;
                btn.textContent = '✓ Copied!';
                setTimeout(() => {
                    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                }, 1500);
            }
            console.log('[Player] Stream URL copied:', streamUrl);
        }).catch(() => {
            prompt('Copy this URL:', streamUrl);
        });
    }


    /**
     * Toggle captions menu visibility
     */
    toggleCaptionsMenu() {
        if (!this.captionsMenu) return;

        this.captionsMenuOpen = !this.captionsMenuOpen;

        if (this.captionsMenuOpen) {
            this.updateCaptionsTracks();
            this.captionsMenu.classList.remove('hidden');
        } else {
            this.captionsMenu.classList.add('hidden');
        }
    }

    /**
     * Close captions menu
     */
    closeCaptionsMenu() {
        if (!this.captionsMenu) return;
        this.captionsMenuOpen = false;
        this.captionsMenu.classList.add('hidden');
    }

    /**
     * Update available caption tracks in the menu
     */
    updateCaptionsTracks() {
        if (!this.captionsList) return;

        // Clear existing list (keep only Off option)
        this.captionsList.innerHTML = '<button class="captions-option" data-index="-1">Off</button>';

        // Add tracks
        if (this.video.textTracks && this.video.textTracks.length > 0) {
            let hasActiveTrack = false;

            for (let i = 0; i < this.video.textTracks.length; i++) {
                const track = this.video.textTracks[i];
                const btn = document.createElement('button');
                btn.className = 'captions-option';
                btn.textContent = track.label || `Track ${i + 1} (${track.language || 'unknown'})`;
                btn.dataset.index = i;

                if (track.mode === 'showing') {
                    btn.classList.add('active');
                    // Add checkmark
                    btn.innerHTML += ' <span style="float: right;">✓</span>';
                    hasActiveTrack = true;
                }

                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(i);
                };

                this.captionsList.appendChild(btn);
            }

            // Handle "Off" button state
            const offBtn = this.captionsList.querySelector('[data-index="-1"]');
            if (offBtn) {
                if (!hasActiveTrack) {
                    offBtn.classList.add('active');
                    offBtn.innerHTML += ' <span style="float: right;">✓</span>';
                }
                offBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.selectCaptionTrack(-1);
                };
            }
        }
    }

    /**
     * Select a caption track
     */
    selectCaptionTrack(index) {
        if (!this.video.textTracks) return;

        // Turn off all tracks
        for (let i = 0; i < this.video.textTracks.length; i++) {
            this.video.textTracks[i].mode = 'hidden'; // or 'disabled'
        }

        // Turn on selected track
        if (index >= 0 && index < this.video.textTracks.length) {
            this.video.textTracks[index].mode = 'showing';
        }

        this.closeCaptionsMenu();
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

        // Setup custom video controls
        this.initCustomControls();

        // Detect video resolution when metadata loads (works for all streams)
        this.video.addEventListener('loadedmetadata', () => {
            if (this.video.videoHeight > 0) {
                this.currentStreamInfo = {
                    width: this.video.videoWidth,
                    height: this.video.videoHeight
                };
                this.updateQualityBadge();
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

                    // Track consecutive media errors for escalated recovery
                    if (timeSinceLastRecovery < 5000) {
                        this.mediaErrorCount = (this.mediaErrorCount || 0) + 1;
                    } else {
                        this.mediaErrorCount = 1;
                    }

                    // Only attempt recovery if more than 2 seconds since last attempt
                    if (timeSinceLastRecovery > 2000) {
                        console.log(`Non-fatal media error (${this.mediaErrorCount}x):`, data.details, '- attempting recovery');
                        this.lastRecoveryAttempt = now;

                        // If repeated errors, try swapAudioCodec which can fix audio glitches
                        if (this.mediaErrorCount >= 3) {
                            console.log('[HLS] Multiple errors detected, trying swapAudioCodec...');
                            this.hls.swapAudioCodec();
                            this.mediaErrorCount = 0;
                        }

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

            // Listen for subtitle track updates
            this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
                console.log('Subtitle tracks updated:', data.subtitleTracks);
                // Wait a moment for native text tracks to populate
                setTimeout(() => this.updateCaptionsTracks(), 100);
            });

            this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
                console.log('Subtitle track switched:', data);
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
     * Start a HLS transcode session
     */
    async startTranscodeSession(url, options = {}) {
        try {
            console.log('[Player] Starting HLS transcode session...', options);
            const res = await fetch('/api/transcode/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, ...options })
            });
            if (!res.ok) throw new Error('Failed to start session');
            const session = await res.json();
            this.currentSessionId = session.sessionId;
            return session.playlistUrl;
        } catch (err) {
            console.error('[Player] Session start failed:', err);
            // Fallback to direct transcode if session fails
            return `/api/transcode?url=${encodeURIComponent(url)}`;
        }
    }

    /**
     * Stop and cleanup current transcode session
     */
    async stopTranscodeSession() {
        if (this.currentSessionId) {
            console.log('[Player] Stopping transcode session:', this.currentSessionId);
            try {
                // Fire and forget cleanup
                fetch(`/api/transcode/${this.currentSessionId}`, { method: 'DELETE' });
            } catch (err) {
                console.error('Failed to stop session:', err);
            }
            this.currentSessionId = null;
        }
    }

    /**
     * Play a channel
     */
    async play(channel, streamUrl) {
        this.currentChannel = channel;

        try {
            // Stop any WatchPage playback (movies/series) before starting Live TV
            window.app?.pages?.watch?.stop?.();

            // Stop current playback
            this.stop();
            this.updateTranscodeStatus('hidden');

            // Hide "select a channel" overlay
            this.overlay.classList.add('hidden');

            // Show custom controls overlay
            this.controlsOverlay?.classList.remove('hidden');
            this.loadingSpinner?.classList.add('show');

            // Determine if HLS or direct stream
            this.currentUrl = streamUrl;

            // CHECK: Auto Transcode (Smart) - probe first, then decide
            if (this.settings.autoTranscode) {
                console.log('[Player] Auto Transcode enabled. Probing stream...');
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    console.log(`[Player] Probe result: video=${info.video}, audio=${info.audio}, ${info.width}x${info.height}, compatible=${info.compatible}`);

                    // Store probe result for quality badge display
                    this.currentStreamInfo = info;
                    this.updateQualityBadge();

                    // Handle subtitles from probe result
                    // Clear existing remote tracks (from previous streams)
                    const oldTracks = this.video.querySelectorAll('track');
                    oldTracks.forEach(t => t.remove());

                    if (info.subtitles && info.subtitles.length > 0) {
                        console.log(`[Player] Found ${info.subtitles.length} subtitle tracks`);
                        info.subtitles.forEach(sub => {
                            const track = document.createElement('track');
                            track.kind = 'subtitles';
                            track.label = sub.title;
                            track.srclang = sub.language;
                            track.src = `/api/subtitle?url=${encodeURIComponent(streamUrl)}&index=${sub.index}`;
                            this.video.appendChild(track);
                        });

                        // Force update of captions menu if it's open
                        if (this.captionsMenuOpen) {
                            this.updateCaptionsTracks();
                        }
                    }

                    if (info.needsTranscode || this.settings.upscaleEnabled) {
                        // Incompatible audio (AC3/EAC3/DTS) or Upscaling enabled - use transcode session
                        console.log(`[Player] Auto: Using HLS transcode session (${this.settings.upscaleEnabled ? 'Upscaling' : 'Incompatible audio/video'})`);

                        // Heuristic: If video is h264, it's likely compatible, so only copy video (audio transcode only)
                        // BUT: If upscaling is enabled, we MUST encode.
                        const videoMode = (info.video && info.video.includes('h264') && !this.settings.upscaleEnabled) ? 'copy' : 'encode';
                        const statusText = videoMode === 'copy' ? 'Transcoding (Audio)' : (this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)');
                        const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';

                        this.updateTranscodeStatus(statusMode, statusText);
                        const playlistUrl = await this.startTranscodeSession(streamUrl, {
                            videoMode,
                            videoCodec: info.video,
                            audioCodec: info.audio,
                            audioChannels: info.audioChannels
                        });
                        this.currentUrl = playlistUrl; // Update currentUrl for HLS reload

                        this.playHls(playlistUrl);

                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    } else if (info.needsRemux) {
                        // Raw .ts container - use remux
                        console.log('[Player] Auto: Using remux (.ts container)');
                        this.updateTranscodeStatus('remuxing', 'Remux (Auto)');
                        const remuxUrl = `/api/remux?url=${encodeURIComponent(streamUrl)}`;
                        this.currentUrl = remuxUrl;
                        this.video.src = remuxUrl;
                        this.video.play().catch(e => {
                            if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                        });
                        this.updateNowPlaying(channel);
                        this.showNowPlayingOverlay();
                        this.fetchEpgData(channel);
                        window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                        return;
                    }
                    // Compatible - fall through to normal HLS.js path
                    console.log('[Player] Auto: Using HLS.js (compatible)');
                } catch (err) {
                    console.warn('[Player] Probe failed, using normal playback:', err.message);
                    // Continue with normal playback on probe failure
                }
            }

            // CHECK: Force Video Transcode (Full) or Upscaling
            if (this.settings.forceVideoTranscode || this.settings.upscaleEnabled) {
                const statusText = this.settings.upscaleEnabled ? 'Upscaling' : 'Transcoding (Video)';
                const statusMode = this.settings.upscaleEnabled ? 'upscaling' : 'transcoding';
                console.log(`[Player] ${statusText} enabled. Starting session (encode)...`);
                this.updateTranscodeStatus(statusMode, statusText);
                const playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'encode' });
                this.currentUrl = playlistUrl;

                // Load HLS
                this.updateNowPlaying(channel, 'Transcoding (Video)');
                // ... (rest is same logic flow, simplified by just falling through to playHls call if I refactored)
                // But for minimize drift, I'll copy the block logic for HLS playback init
                // Actually, I can just fall through if I set looksLikeHls = true?
                // No, play logic is sequential.
                if (Hls.isSupported()) {
                    // Start HLS
                    // ... this repeats code. I should probably just set currentUrl and let HLS block handle?
                    // But HLS block is lower down.
                    // I will just execute the HLS init here as before.

                    // Actually, easiest way is to re-assign streamUrl and goto start? No.
                    // Copy existing forceTranscode block logic
                    if (this.hls) {
                        this.hls.destroy();
                    }
                    this.hls = new Hls();
                    this.hls.loadSource(playlistUrl);
                    this.hls.attachMedia(this.video);
                    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        this.video.play().catch(console.error);
                    });
                    // Handle errors
                    this.hls.on(Hls.Events.ERROR, (event, data) => {
                        if (data.fatal) {
                            console.log('[Player] HLS fatal error');
                            this.hls.destroy();
                        }
                    });

                    return; // Exit
                }
            }

            // CHECK: Force Audio Transcode (Copy Video) - legacy forceTranscode setting
            if (this.settings.forceTranscode) {
                console.log('[Player] Force Audio Transcode enabled. Starting session (copy)...');
                this.updateTranscodeStatus('transcoding', 'Transcoding (Audio)');

                // Probe to get video codec for HEVC tag handling
                let videoCodec = 'unknown';
                try {
                    const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(streamUrl)}`);
                    const info = await probeRes.json();
                    videoCodec = info.video;
                } catch (e) { console.warn('Probe failed for force audio, assuming h264'); }

                const playlistUrl = await this.startTranscodeSession(streamUrl, { videoMode: 'copy', videoCodec });
                this.currentUrl = playlistUrl;

                console.log('[Player] Playing transcoded HLS stream:', playlistUrl);
                this.playHls(playlistUrl);

                // Update UI and dispatch events
                this.updateNowPlaying(channel);
                this.showNowPlayingOverlay();
                this.fetchEpgData(channel);
                window.dispatchEvent(new CustomEvent('channelChanged', { detail: channel }));
                return; // Exit early
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
                this.updateTranscodeStatus('remuxing', 'Remux (Force)');
                const remuxUrl = this.getRemuxUrl(streamUrl);
                this.video.src = remuxUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('[Player] Autoplay prevented:', e);
                });

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
                this.updateTranscodeStatus('direct', 'Direct HLS');

                // Use playHls helper logic here (or extract it)
                // For now, let's just use existing logic but wrapped/modularized if possible?
                // The HLS init logic is quite complex with error handling
                // I'll inline the Hls init here as per original but mindful of proxy vs local

                this.hls = new Hls(this.getHlsConfig());
                this.hls.loadSource(finalUrl);
                this.hls.attachMedia(this.video);

                this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                    });
                });

                // Re-attach error handler for the new Hls instance
                this.hls.on(Hls.Events.ERROR, (event, data) => {
                    if (data.fatal) {
                        const isCorsLikely = data.type === Hls.ErrorTypes.NETWORK_ERROR ||
                            (data.type === Hls.ErrorTypes.MEDIA_ERROR && data.details === 'fragParsingError');

                        // Don't proxy if it's already a local API URL
                        const isLocalApi = this.currentUrl.startsWith('/api/');

                        if (isCorsLikely && !this.isUsingProxy && !isLocalApi) {
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
                this.updateTranscodeStatus('direct', 'Direct Native');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name === 'AbortError') return; // Ignore interruption by new load
                    console.log('Autoplay prevented, trying proxy if CORS error:', e);
                    if (!this.isUsingProxy) {
                        this.isUsingProxy = true;
                        this.video.src = this.getProxiedUrl(streamUrl);
                        this.video.play().catch(err => {
                            if (err.name !== 'AbortError') console.error('Proxy play failed:', err);
                        });
                    }
                });
            } else {
                // Priority 3: Try direct playback for non-HLS streams
                this.updateTranscodeStatus('direct', 'Direct Play');
                this.video.src = finalUrl;
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
                });
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
     * Helper to play HLS stream (reduces duplication)
     */
    playHls(url) {
        if (this.hls) {
            this.hls.destroy();
        }

        this.hls = new Hls(this.getHlsConfig());
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.log('Autoplay prevented:', e);
            });
        });

        this.hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                // Simple error handling for forced HLS/transcode modes
                console.error('Fatal HLS error in transcode mode:', data);
                this.hls.destroy();
            }
        });
    }

    async updateTranscodeStatus(mode, text) {
        const el = document.getElementById('player-transcode-status');
        if (!el) return;

        el.className = 'transcode-status'; // Reset classes

        if (mode === 'hidden') {
            el.classList.add('hidden');
            return;
        }

        el.textContent = text || mode;
        el.classList.add(mode);

        // Ensure it's visible
        el.classList.remove('hidden');
    }

    /**
     * Get quality label from video height
     */
    getQualityLabel(height) {
        if (height >= 2160) return '4K';
        if (height >= 1440) return '1440p';
        if (height >= 1080) return '1080p';
        if (height >= 720) return '720p';
        if (height >= 480) return '480p';
        if (height > 0) return `${height}p`;
        return null;
    }

    /**
     * Update quality badge display
     */
    updateQualityBadge() {
        const badge = document.getElementById('player-quality-badge');
        if (!badge) return;

        if (this.currentStreamInfo?.height > 0) {
            badge.textContent = this.getQualityLabel(this.currentStreamInfo.height);
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    /**
     * Fetch EPG data for current channel
     */
    async fetchEpgData(channel) {
        if (!channel || (!channel.tvgId && !channel.epg_id)) {
            this.updateNowPlaying(channel, null);
            return;
        }
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
        // Stop any running transcode session first
        this.stopTranscodeSession();

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        this.video.pause();
        this.video.src = '';
        this.video.load();

        // Reset UI to idle state
        this.overlay.classList.remove('hidden'); // Show "Select a channel"
        this.controlsOverlay?.classList.add('hidden'); // Hide controls
        this.loadingSpinner?.classList.remove('show');
        this.nowPlaying.classList.add('hidden');

        // Hide quality badge
        this.currentStreamInfo = null;
        const badge = document.getElementById('player-quality-badge');
        if (badge) badge.classList.add('hidden');
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
