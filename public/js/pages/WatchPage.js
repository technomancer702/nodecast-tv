/**
 * Watch Page Controller
 * Handles VOD (Movies/Series) playback with streaming service-style UI
 */

class WatchPage {
    constructor(app) {
        this.app = app;

        // Video elements
        this.video = document.getElementById('watch-video');
        this.overlay = document.getElementById('watch-overlay');

        // Top bar
        this.backBtn = document.getElementById('watch-back-btn');
        this.titleEl = document.getElementById('watch-title');
        this.subtitleEl = document.getElementById('watch-subtitle');

        // Controls
        this.centerPlayBtn = document.getElementById('watch-center-play');
        this.playPauseBtn = document.getElementById('watch-play-pause');
        this.skipBackBtn = document.getElementById('watch-skip-back');
        this.skipFwdBtn = document.getElementById('watch-skip-fwd');
        this.muteBtn = document.getElementById('watch-mute');
        this.volumeSlider = document.getElementById('watch-volume');
        this.fullscreenBtn = document.getElementById('watch-fullscreen');
        this.progressSlider = document.getElementById('watch-progress');
        this.timeCurrent = document.getElementById('watch-time-current');
        this.timeTotal = document.getElementById('watch-time-total');
        this.scrollHint = document.getElementById('watch-scroll-hint');
        this.loadingSpinner = document.getElementById('watch-loading');

        // Next episode
        this.nextEpisodePanel = document.getElementById('watch-next-episode');
        this.nextEpisodeTitle = document.getElementById('next-episode-title');
        this.nextCountdown = document.getElementById('next-countdown');
        this.nextPlayNowBtn = document.getElementById('next-play-now');
        this.nextCancelBtn = document.getElementById('next-cancel');

        // Details section
        this.posterEl = document.getElementById('watch-poster');
        this.contentTitleEl = document.getElementById('watch-content-title');
        this.yearEl = document.getElementById('watch-year');
        this.ratingEl = document.getElementById('watch-rating');
        this.durationEl = document.getElementById('watch-duration');
        this.descriptionEl = document.getElementById('watch-description');
        this.playBtn = document.getElementById('watch-play-btn');
        this.playBtnText = document.getElementById('watch-play-btn-text');
        this.favoriteBtn = document.getElementById('watch-favorite-btn');

        // Recommended / Episodes
        this.recommendedSection = document.getElementById('watch-recommended');
        this.recommendedGrid = document.getElementById('watch-recommended-grid');
        this.episodesSection = document.getElementById('watch-episodes');
        this.seasonsContainer = document.getElementById('watch-seasons');

        // Captions
        this.captionsBtn = document.getElementById('watch-captions-btn');
        this.captionsMenu = document.getElementById('watch-captions-menu');
        this.captionsList = document.getElementById('watch-captions-list');

        // State
        this.hls = null;
        this.content = null;
        this.contentType = null; // 'movie' or 'series'
        this.seriesInfo = null;
        this.currentSeason = null;
        this.currentEpisode = null;
        this.isFavorite = false;
        this.returnPage = null;
        this.captionsMenuOpen = false;

        // Overlay timer
        this.overlayTimeout = null;
        this.overlayVisible = true;

        // Next episode
        this.nextEpisodeTimeout = null;
        this.nextEpisodeCountdown = 10;
        this.nextEpisodeInterval = null;

        this.init();
    }

    init() {
        // Back button
        this.backBtn?.addEventListener('click', () => this.goBack());

        // Play/Pause
        this.centerPlayBtn?.addEventListener('click', () => this.togglePlay());
        this.playPauseBtn?.addEventListener('click', () => this.togglePlay());
        this.video?.addEventListener('click', () => this.togglePlay());

        // Skip buttons
        this.skipBackBtn?.addEventListener('click', () => this.skip(-10));
        this.skipFwdBtn?.addEventListener('click', () => this.skip(10));

        // Volume
        this.muteBtn?.addEventListener('click', () => this.toggleMute());
        this.volumeSlider?.addEventListener('input', (e) => this.setVolume(e.target.value));

        // Fullscreen
        this.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());

        // Picture-in-Picture
        const pipBtn = document.getElementById('watch-pip');
        pipBtn?.addEventListener('click', () => this.togglePictureInPicture());

        // Overflow Menu
        const overflowBtn = document.getElementById('watch-overflow');
        const overflowMenu = document.getElementById('watch-overflow-menu');

        overflowBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowMenu?.classList.toggle('hidden');
        });

        // Copy Stream URL
        const copyUrlBtn = document.getElementById('watch-copy-url');
        copyUrlBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.copyStreamUrl();
            overflowMenu?.classList.add('hidden');
        });

        // Close overflow menu when clicking outside
        document.addEventListener('click', (e) => {
            if (overflowMenu && !overflowMenu.classList.contains('hidden') &&
                !overflowMenu.contains(e.target) && e.target !== overflowBtn) {
                overflowMenu.classList.add('hidden');
            }
        });

        // Progress bar
        this.progressSlider?.addEventListener('input', (e) => this.seek(e.target.value));

        // Video events
        this.video?.addEventListener('timeupdate', () => this.updateProgress());
        this.video?.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
        this.video?.addEventListener('play', () => this.onPlay());
        this.video?.addEventListener('pause', () => this.onPause());
        this.video?.addEventListener('ended', () => this.onEnded());
        this.video?.addEventListener('error', (e) => this.onError(e));
        this.video?.addEventListener('waiting', () => this.showLoading());
        this.video?.addEventListener('canplay', () => this.hideLoading());

        // Overlay auto-hide
        const watchSection = document.querySelector('.watch-video-section');
        watchSection?.addEventListener('mousemove', () => this.showOverlay());
        watchSection?.addEventListener('touchstart', () => this.showOverlay());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));

        // Details section buttons
        this.playBtn?.addEventListener('click', () => this.scrollToVideo());
        this.favoriteBtn?.addEventListener('click', () => this.toggleFavorite());

        // Next episode buttons
        this.nextPlayNowBtn?.addEventListener('click', () => this.playNextEpisode());
        this.nextCancelBtn?.addEventListener('click', () => this.cancelNextEpisode());

        // Captions toggle
        this.captionsBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCaptionsMenu();
        });

        // Close captions menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.captionsMenuOpen && !this.captionsMenu?.contains(e.target) && e.target !== this.captionsBtn) {
                this.closeCaptionsMenu();
            }
        });

        // Hide scroll hint after scrolling
        const watchPage = document.getElementById('page-watch');
        watchPage?.addEventListener('scroll', () => {
            if (watchPage.scrollTop > 50) {
                this.scrollHint?.classList.add('hidden');
            } else {
                this.scrollHint?.classList.remove('hidden');
            }
        });
    }

    /**
     * Main entry point - play content
     * @param {Object} content - Movie or episode info
     * @param {string} streamUrl - Stream URL
     */
    async play(content, streamUrl) {
        this.content = content;
        this.contentType = content.type;
        this.seriesInfo = content.seriesInfo || null;
        this.currentSeason = content.currentSeason || null;
        this.currentEpisode = content.currentEpisode || null;
        this.returnPage = content.type === 'movie' ? 'movies' : 'series';

        // Reset state
        this.cancelNextEpisode();

        // Navigate to watch page
        this.app.navigateTo('watch', true);

        // Scroll to top
        document.getElementById('page-watch')?.scrollTo(0, 0);

        // Update title bar
        this.titleEl.textContent = content.title || '';
        this.subtitleEl.textContent = content.subtitle || '';

        // Load video
        await this.loadVideo(streamUrl);

        // Populate details section
        this.renderDetails();

        // Load recommended (movies) or episodes (series)
        if (content.type === 'movie') {
            this.episodesSection?.classList.add('hidden');
            this.recommendedSection?.classList.remove('hidden');
            await this.loadRecommended(content.sourceId, content.categoryId);
        } else {
            this.recommendedSection?.classList.add('hidden');
            this.episodesSection?.classList.remove('hidden');
            this.renderEpisodes();
        }

        // Check favorite status
        await this.checkFavorite();

        // Show overlay initially
        this.showOverlay();
    }

    async loadVideo(url) {
        // Store the URL for copy functionality
        this.currentUrl = url;

        // Stop any existing playback
        this.stop();

        // Show loading spinner
        this.showLoading();

        // Get settings for proxy/transcode
        let settings = {};
        try {
            settings = await API.settings.get();
        } catch (e) {
            console.warn('Could not load settings');
        }

        // Detect stream type
        const looksLikeHls = url.includes('.m3u8') || url.includes('m3u8');
        const isRawTs = url.includes('.ts') && !url.includes('.m3u8');
        const isDirectVideo = url.includes('.mp4') || url.includes('.mkv') || url.includes('.avi');

        // Priority 0: Auto Transcode (Smart) - probe first, then decide
        if (settings.autoTranscode) {
            console.log('[WatchPage] Auto Transcode enabled. Probing stream...');
            try {
                const probeRes = await fetch(`/api/probe?url=${encodeURIComponent(url)}`);
                const info = await probeRes.json();
                console.log(`[WatchPage] Probe result: video=${info.video}, audio=${info.audio}, compatible=${info.compatible}`);

                if (info.needsTranscode) {
                    console.log('[WatchPage] Auto: Using transcode (incompatible audio)');
                    const finalUrl = `/api/transcode?url=${encodeURIComponent(url)}`;
                    this.video.src = finalUrl;
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                    });
                    this.setVolumeFromStorage();
                    return;
                } else if (info.needsRemux) {
                    console.log('[WatchPage] Auto: Using remux (.ts container)');
                    const finalUrl = `/api/remux?url=${encodeURIComponent(url)}`;
                    this.video.src = finalUrl;
                    this.video.play().catch(e => {
                        if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                    });
                    this.setVolumeFromStorage();
                    return;
                }
                // Compatible - fall through to normal playback
                console.log('[WatchPage] Auto: Using normal playback (compatible)');
            } catch (err) {
                console.warn('[WatchPage] Probe failed, using normal playback:', err.message);
                // Continue with normal playback on probe failure
            }
        }

        // Priority 1: Force Transcode - route through FFmpeg
        if (settings.forceTranscode) {
            console.log('[WatchPage] Force Transcode enabled');
            const finalUrl = `/api/transcode?url=${encodeURIComponent(url)}`;
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            this.setVolumeFromStorage();
            return;
        }

        // Priority 2: Force Remux for raw TS streams
        if (settings.forceRemux && isRawTs) {
            console.log('[WatchPage] Force Remux enabled');
            const finalUrl = `/api/remux?url=${encodeURIComponent(url)}`;
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
            this.setVolumeFromStorage();
            return;
        }

        // Determine if proxy is needed
        const proxyRequiredDomains = ['pluto.tv'];
        const needsProxy = settings.forceProxy || proxyRequiredDomains.some(domain => url.includes(domain));
        const finalUrl = needsProxy ? `/api/proxy/stream?url=${encodeURIComponent(url)}` : url;

        console.log('[WatchPage] Playing:', { url, needsProxy, looksLikeHls });

        // Use HLS.js for HLS streams
        if (looksLikeHls && Hls.isSupported()) {
            this.hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                startLevel: -1,
                enableWorker: true,
            });

            this.hls.loadSource(finalUrl);
            this.hls.attachMedia(this.video);

            // Listen for subtitle track updates
            this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (event, data) => {
                console.log('[WatchPage] Subtitle tracks updated:', data.subtitleTracks);
                // Wait a moment for native text tracks to populate
                setTimeout(() => this.updateCaptionsTracks(), 100);
            });

            this.hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (event, data) => {
                console.log('[WatchPage] Subtitle track switched:', data);
            });

            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                this.video.play().catch(e => {
                    if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
                });
            });

            this.hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.error('[WatchPage] HLS fatal error:', data);
                    // Try proxy on CORS error
                    if (!needsProxy && (data.type === Hls.ErrorTypes.NETWORK_ERROR)) {
                        console.log('[WatchPage] Retrying via proxy...');
                        this.hls.loadSource(`/api/proxy/stream?url=${encodeURIComponent(url)}`);
                        this.hls.startLoad();
                    } else {
                        this.hls.destroy();
                    }
                }
            });
        } else {
            // Direct playback for mp4/mkv/avi
            this.video.src = finalUrl;
            this.video.play().catch(e => {
                if (e.name !== 'AbortError') console.error('[WatchPage] Autoplay error:', e);
            });
        }

        this.setVolumeFromStorage();
    }

    setVolumeFromStorage() {
        const savedVolume = localStorage.getItem('nodecast-volume') || '80';
        this.video.volume = parseInt(savedVolume) / 100;
        if (this.volumeSlider) this.volumeSlider.value = savedVolume;
    }

    stop() {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
        if (this.video) {
            this.video.pause();
            this.video.src = '';
            this.video.load();
        }
    }

    // === Playback Controls ===

    togglePlay() {
        if (this.video.paused) {
            this.video.play().catch(console.error);
        } else {
            this.video.pause();
        }
    }

    skip(seconds) {
        if (this.video) {
            this.video.currentTime = Math.max(0, Math.min(this.video.currentTime + seconds, this.video.duration || 0));
        }
    }

    seek(percent) {
        if (this.video && this.video.duration) {
            this.video.currentTime = (percent / 100) * this.video.duration;
        }
    }

    toggleMute() {
        if (this.video) {
            this.video.muted = !this.video.muted;
            this.updateVolumeUI();
        }
    }

    setVolume(value) {
        if (this.video) {
            this.video.volume = value / 100;
            this.video.muted = false;
            localStorage.setItem('nodecast-volume', value);
            this.updateVolumeUI();
        }
    }

    toggleFullscreen() {
        const container = document.querySelector('.watch-video-section');
        if (!document.fullscreenElement) {
            container?.requestFullscreen?.() || container?.webkitRequestFullscreen?.();
        } else {
            document.exitFullscreen?.() || document.webkitExitFullscreen?.();
        }
    }

    async togglePictureInPicture() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && this.video.readyState >= 2) {
                await this.video.requestPictureInPicture();
            }
        } catch (err) {
            // Silently fail - Firefox users can use native PiP button
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
            console.warn('[WatchPage] No stream URL to copy');
            return;
        }

        let streamUrl = this.currentUrl;

        // If it's a relative URL, make it absolute
        if (streamUrl.startsWith('/')) {
            streamUrl = window.location.origin + streamUrl;
        }

        navigator.clipboard.writeText(streamUrl).then(() => {
            // Show brief feedback
            const btn = document.getElementById('watch-copy-url');
            if (btn) {
                btn.textContent = '✓ Copied!';
                setTimeout(() => {
                    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg> Copy Stream URL`;
                }, 1500);
            }
            console.log('[WatchPage] Stream URL copied:', streamUrl);
        }).catch(() => {
            prompt('Copy this URL:', streamUrl);
        });
    }

    // === UI Updates ===

    updateProgress() {
        if (!this.video || !this.video.duration) return;

        const percent = (this.video.currentTime / this.video.duration) * 100;
        this.progressSlider.value = percent;
        this.timeCurrent.textContent = this.formatTime(this.video.currentTime);
    }

    onMetadataLoaded() {
        // Duration is unreliable for transcoded streams, so we don't display it
    }

    onPlay() {
        // Update play/pause button icons
        this.playPauseBtn?.querySelector('.icon-play')?.classList.add('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.remove('hidden');
        this.centerPlayBtn?.classList.remove('show');

        // Start overlay auto-hide
        this.startOverlayTimer();
    }

    onPause() {
        this.playPauseBtn?.querySelector('.icon-play')?.classList.remove('hidden');
        this.playPauseBtn?.querySelector('.icon-pause')?.classList.add('hidden');
        this.centerPlayBtn?.classList.add('show');

        // Keep overlay visible when paused
        this.showOverlay();
        clearTimeout(this.overlayTimeout);
    }

    onEnded() {
        // For series, show next episode panel
        if (this.contentType === 'series' && this.seriesInfo) {
            const nextEp = this.getNextEpisode();
            if (nextEp) {
                this.showNextEpisodePanel(nextEp);
            }
        }
    }

    onError(e) {
        // Only log actual fatal errors, not benign stream recovery events
        const error = this.video?.error;
        if (error && error.code) {
            console.error('[WatchPage] Video error:', error.code, error.message);
        }
    }

    updateVolumeUI() {
        const isMuted = this.video?.muted || this.video?.volume === 0;
        this.muteBtn?.querySelector('.icon-vol')?.classList.toggle('hidden', isMuted);
        this.muteBtn?.querySelector('.icon-muted')?.classList.toggle('hidden', !isMuted);
    }

    formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // === Loading Spinner ===

    showLoading() {
        this.loadingSpinner?.classList.add('show');
        this.centerPlayBtn?.classList.remove('show');
    }

    hideLoading() {
        this.loadingSpinner?.classList.remove('show');
    }

    // === Captions ===

    toggleCaptionsMenu() {
        if (this.captionsMenuOpen) {
            this.closeCaptionsMenu();
        } else {
            this.updateCaptionsTracks();
            this.captionsMenu?.classList.remove('hidden');
            this.captionsMenuOpen = true;
        }
    }

    closeCaptionsMenu() {
        this.captionsMenu?.classList.add('hidden');
        this.captionsMenuOpen = false;
    }

    updateCaptionsTracks() {
        if (!this.captionsList || !this.video) return;

        // Build list of available text tracks
        const tracks = this.video.textTracks;
        let html = '<button class="captions-option" data-index="-1">Off</button>';

        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
                const label = track.label || track.language || `Track ${i + 1}`;
                const isActive = track.mode === 'showing';
                html += `<button class="captions-option ${isActive ? 'active' : ''}" data-index="${i}">${label}</button>`;
            }
        }

        // Check if any track is active, if not mark "Off" as active
        let anyActive = false;
        for (let i = 0; i < tracks.length; i++) {
            if (tracks[i].mode === 'showing') anyActive = true;
        }
        if (!anyActive) {
            html = html.replace('class="captions-option"', 'class="captions-option active"');
        }

        this.captionsList.innerHTML = html;

        // Add click handlers
        this.captionsList.querySelectorAll('.captions-option').forEach(btn => {
            btn.addEventListener('click', () => this.selectCaptionTrack(parseInt(btn.dataset.index)));
        });
    }

    selectCaptionTrack(index) {
        if (!this.video) return;

        const tracks = this.video.textTracks;

        // Disable all tracks
        for (let i = 0; i < tracks.length; i++) {
            tracks[i].mode = 'hidden';
        }

        // Enable selected track
        if (index >= 0 && index < tracks.length) {
            tracks[index].mode = 'showing';
        }

        // Update UI
        this.updateCaptionsTracks();
        this.closeCaptionsMenu();
    }

    // === Overlay Auto-Hide ===

    showOverlay() {
        this.overlay?.classList.remove('hidden');
        this.overlayVisible = true;
        this.startOverlayTimer();
    }

    hideOverlay() {
        if (!this.video?.paused) {
            this.overlay?.classList.add('hidden');
            this.overlayVisible = false;
        }
    }

    startOverlayTimer() {
        clearTimeout(this.overlayTimeout);
        this.overlayTimeout = setTimeout(() => this.hideOverlay(), 3000);
    }

    // === Keyboard Shortcuts ===

    handleKeyboard(e) {
        // Only handle when watch page is active
        const watchPage = document.getElementById('page-watch');
        if (!watchPage?.classList.contains('active')) return;

        // Don't handle if typing in input
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

        switch (e.key) {
            case ' ':
            case 'k':
                e.preventDefault();
                this.togglePlay();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.skip(-10);
                this.showOverlay();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.skip(10);
                this.showOverlay();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.setVolume(Math.min(100, parseInt(this.volumeSlider.value) + 10));
                this.volumeSlider.value = Math.min(100, parseInt(this.volumeSlider.value) + 10);
                this.showOverlay();
                break;
            case 'ArrowDown':
                e.preventDefault();
                this.setVolume(Math.max(0, parseInt(this.volumeSlider.value) - 10));
                this.volumeSlider.value = Math.max(0, parseInt(this.volumeSlider.value) - 10);
                this.showOverlay();
                break;
            case 'f':
                e.preventDefault();
                this.toggleFullscreen();
                break;
            case 'm':
                e.preventDefault();
                this.toggleMute();
                this.showOverlay();
                break;
            case 'Escape':
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    this.goBack();
                }
                break;
        }
    }

    // === Details Section ===

    renderDetails() {
        if (!this.content) return;

        this.posterEl.src = this.content.poster || '/img/placeholder.png';
        this.posterEl.alt = this.content.title || '';
        this.contentTitleEl.textContent = this.content.title || '';
        this.yearEl.textContent = this.content.year || '';
        this.ratingEl.textContent = this.content.rating ? `★ ${this.content.rating}` : '';
        this.descriptionEl.textContent = this.content.description || '';

        // Update play button text
        if (this.playBtnText) {
            this.playBtnText.textContent = 'Play';
        }
    }

    async checkFavorite() {
        if (!this.content) return;

        try {
            const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
            const itemType = this.contentType === 'movie' ? 'movie' : 'series';
            const result = await API.favorites.check(this.content.sourceId, itemId, itemType);
            this.isFavorite = result?.isFavorite || false;
            this.updateFavoriteUI();
        } catch (e) {
            console.warn('Could not check favorite status');
        }
    }

    async toggleFavorite() {
        if (!this.content) return;

        const itemId = this.contentType === 'movie' ? this.content.id : this.content.seriesId;
        const itemType = this.contentType === 'movie' ? 'movie' : 'series';

        try {
            if (this.isFavorite) {
                await API.favorites.remove(this.content.sourceId, itemId, itemType);
                this.isFavorite = false;
            } else {
                await API.favorites.add(this.content.sourceId, itemId, itemType);
                this.isFavorite = true;
            }
            this.updateFavoriteUI();
        } catch (e) {
            console.error('Error toggling favorite:', e);
        }
    }

    updateFavoriteUI() {
        const outlineIcon = this.favoriteBtn?.querySelector('.icon-fav-outline');
        const filledIcon = this.favoriteBtn?.querySelector('.icon-fav-filled');

        outlineIcon?.classList.toggle('hidden', this.isFavorite);
        filledIcon?.classList.toggle('hidden', !this.isFavorite);
    }

    scrollToVideo() {
        document.getElementById('page-watch')?.scrollTo({ top: 0, behavior: 'smooth' });
        if (this.video?.paused) {
            this.video.play().catch(console.error);
        }
    }

    // === Recommended Movies ===

    async loadRecommended(sourceId, categoryId) {
        if (!sourceId || !categoryId) {
            this.recommendedSection?.classList.add('hidden');
            return;
        }

        try {
            const movies = await API.proxy.xtream.vodStreams(sourceId, categoryId);
            if (!movies || movies.length === 0) {
                this.recommendedSection?.classList.add('hidden');
                return;
            }

            // Filter out current movie, take first 12
            const filtered = movies
                .filter(m => m.stream_id !== this.content?.id)
                .slice(0, 12);

            this.renderRecommendedGrid(filtered, sourceId);
        } catch (e) {
            console.error('Error loading recommended:', e);
            this.recommendedSection?.classList.add('hidden');
        }
    }

    renderRecommendedGrid(movies, sourceId) {
        if (!this.recommendedGrid) return;

        this.recommendedGrid.innerHTML = movies.map(movie => `
            <div class="watch-recommended-card" data-id="${movie.stream_id}" data-source="${sourceId}">
                <img src="${movie.stream_icon || movie.cover || '/img/placeholder.png'}" 
                     alt="${movie.name}" 
                     onerror="this.src='/img/placeholder.png'" loading="lazy">
                <p>${movie.name}</p>
            </div>
        `).join('');

        // Click handlers
        this.recommendedGrid.querySelectorAll('.watch-recommended-card').forEach(card => {
            card.addEventListener('click', () => this.playRecommendedMovie(card.dataset.id, parseInt(card.dataset.source)));
        });
    }

    async playRecommendedMovie(streamId, sourceId) {
        try {
            // Fetch movie details
            const movies = await API.proxy.xtream.vodStreams(sourceId);
            const movie = movies?.find(m => m.stream_id == streamId);

            if (!movie) return;

            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(sourceId, streamId, 'movie', container);

            if (result?.url) {
                this.play({
                    type: 'movie',
                    id: movie.stream_id,
                    title: movie.name,
                    poster: movie.stream_icon || movie.cover,
                    description: movie.plot || '',
                    year: movie.year,
                    rating: movie.rating,
                    sourceId: sourceId,
                    categoryId: movie.category_id
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing recommended movie:', e);
        }
    }

    // === Series Episodes ===

    renderEpisodes() {
        if (!this.seriesInfo?.episodes || !this.seasonsContainer) return;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));

        this.seasonsContainer.innerHTML = seasons.map(seasonNum => {
            const episodes = this.seriesInfo.episodes[seasonNum];
            const isCurrentSeason = parseInt(seasonNum) === parseInt(this.currentSeason);

            return `
                <div class="watch-season-group">
                    <div class="watch-season-header ${isCurrentSeason ? '' : 'collapsed'}">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="icon">
                            <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/>
                        </svg>
                        <span class="watch-season-name">Season ${seasonNum}</span>
                        <span class="watch-season-count">${episodes.length} episodes</span>
                    </div>
                    <div class="watch-episode-list">
                        ${episodes.map(ep => {
                const isActive = parseInt(seasonNum) === parseInt(this.currentSeason) &&
                    parseInt(ep.episode_num) === parseInt(this.currentEpisode);
                return `
                                <div class="watch-episode-item ${isActive ? 'active' : ''}" 
                                     data-episode-id="${ep.id}" 
                                     data-season="${seasonNum}"
                                     data-episode="${ep.episode_num}"
                                     data-container="${ep.container_extension || 'mp4'}">
                                    <span class="watch-episode-num">E${ep.episode_num}</span>
                                    <span class="watch-episode-title">${ep.title || `Episode ${ep.episode_num}`}</span>
                                    <span class="watch-episode-duration">${ep.duration || ''}</span>
                                </div>
                            `;
            }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        // Season header toggle
        this.seasonsContainer.querySelectorAll('.watch-season-header').forEach(header => {
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
            });
        });

        // Episode click handlers
        this.seasonsContainer.querySelectorAll('.watch-episode-item').forEach(ep => {
            ep.addEventListener('click', () => this.playEpisodeFromList(ep));
        });
    }

    async playEpisodeFromList(episodeEl) {
        const episodeId = episodeEl.dataset.episodeId;
        const seasonNum = episodeEl.dataset.season;
        const episodeNum = episodeEl.dataset.episode;
        const container = episodeEl.dataset.container || 'mp4';

        try {
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, episodeId, 'series', container);

            if (result?.url) {
                const episodeTitle = episodeEl.querySelector('.watch-episode-title')?.textContent || `Episode ${episodeNum}`;

                this.play({
                    type: 'series',
                    id: episodeId,
                    title: this.content.title,
                    subtitle: `S${seasonNum} E${episodeNum} - ${episodeTitle}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: seasonNum,
                    currentEpisode: episodeNum
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing episode:', e);
        }
    }

    // === Next Episode ===

    getNextEpisode() {
        if (!this.seriesInfo?.episodes || !this.currentSeason || !this.currentEpisode) return null;

        const seasons = Object.keys(this.seriesInfo.episodes).sort((a, b) => parseInt(a) - parseInt(b));
        const currentSeasonEpisodes = this.seriesInfo.episodes[this.currentSeason] || [];

        // Find next episode in current season
        const currentEpIndex = currentSeasonEpisodes.findIndex(ep =>
            parseInt(ep.episode_num) === parseInt(this.currentEpisode)
        );

        if (currentEpIndex >= 0 && currentEpIndex < currentSeasonEpisodes.length - 1) {
            return {
                ...currentSeasonEpisodes[currentEpIndex + 1],
                seasonNum: this.currentSeason
            };
        }

        // Try next season
        const currentSeasonIndex = seasons.indexOf(String(this.currentSeason));
        if (currentSeasonIndex >= 0 && currentSeasonIndex < seasons.length - 1) {
            const nextSeason = seasons[currentSeasonIndex + 1];
            const nextSeasonEpisodes = this.seriesInfo.episodes[nextSeason];
            if (nextSeasonEpisodes?.length > 0) {
                return {
                    ...nextSeasonEpisodes[0],
                    seasonNum: nextSeason
                };
            }
        }

        return null;
    }

    showNextEpisodePanel(nextEp) {
        if (!this.nextEpisodePanel) return;

        this.nextEpisodeTitle.textContent = `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`;
        this.nextEpisodePanel.classList.remove('hidden');
        this.nextEpisodePanel.nextEpisodeData = nextEp;

        // Start countdown
        this.nextEpisodeCountdown = 10;
        this.nextCountdown.textContent = this.nextEpisodeCountdown;

        this.nextEpisodeInterval = setInterval(() => {
            this.nextEpisodeCountdown--;
            this.nextCountdown.textContent = this.nextEpisodeCountdown;

            if (this.nextEpisodeCountdown <= 0) {
                this.playNextEpisode();
            }
        }, 1000);
    }

    async playNextEpisode() {
        this.cancelNextEpisode();

        const nextEp = this.nextEpisodePanel?.nextEpisodeData;
        if (!nextEp) return;

        try {
            const container = nextEp.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(this.content.sourceId, nextEp.id, 'series', container);

            if (result?.url) {
                this.play({
                    type: 'series',
                    id: nextEp.id,
                    title: this.content.title,
                    subtitle: `S${nextEp.seasonNum} E${nextEp.episode_num} - ${nextEp.title || `Episode ${nextEp.episode_num}`}`,
                    poster: this.content.poster,
                    description: this.content.description,
                    year: this.content.year,
                    rating: this.content.rating,
                    sourceId: this.content.sourceId,
                    seriesId: this.content.seriesId,
                    seriesInfo: this.seriesInfo,
                    currentSeason: nextEp.seasonNum,
                    currentEpisode: nextEp.episode_num
                }, result.url);
            }
        } catch (e) {
            console.error('Error playing next episode:', e);
        }
    }

    cancelNextEpisode() {
        clearInterval(this.nextEpisodeInterval);
        this.nextEpisodePanel?.classList.add('hidden');
        if (this.nextEpisodePanel) {
            this.nextEpisodePanel.nextEpisodeData = null;
        }
    }

    // === Navigation ===

    goBack() {
        this.stop();
        this.cancelNextEpisode();

        // Navigate to the page we came from (stored in returnPage)
        // We don't use history.back() because we used replaceHistory when navigating here
        this.app.navigateTo(this.returnPage || 'movies');
    }

    show() {
        // Called when page becomes visible
    }

    hide() {
        // Called when page becomes hidden
        this.stop();
        this.cancelNextEpisode();
    }
}

window.WatchPage = WatchPage;
