/**
 * Home Page Controller
 */

class LivePage {
    constructor(app) {
        this.app = app;
        this.handleKeydown = this.handleKeydown.bind(this);
    }

    async init() {
        // Load sources and channels on initial page load
        await this.app.channelList.loadSources();
        await this.app.channelList.loadChannels();

        // Silently fetch EPG data for sidebar info
        try {
            await this.app.epgGuide.fetchEpgData();

            // Clear cache so we don't get stale "null" results from initial render
            this.app.channelList.clearProgramInfoCache();

            // Update program info in existing DOM elements without re-rendering
            this.updateProgramInfo();
        } catch (err) {
            console.warn('Background EPG fetch failed:', err);
        }
    }

    /**
     * Update "Now Playing" info in existing channel elements without blocking UI
     */
    updateProgramInfo() {
        const channelItems = Array.from(document.querySelectorAll('.channel-item'));
        if (channelItems.length === 0) return;

        // Build a map for O(1) channel lookups
        const channelMap = new Map();
        this.app.channelList.channels.forEach(c => channelMap.set(c.id, c));

        // Process in small batches to avoid blocking UI
        const BATCH_SIZE = 50;
        let index = 0;

        const processBatch = () => {
            const end = Math.min(index + BATCH_SIZE, channelItems.length);

            for (let i = index; i < end; i++) {
                const item = channelItems[i];
                const channelId = item.dataset.channelId;
                const channel = channelMap.get(channelId);

                if (channel) {
                    const programDiv = item.querySelector('.channel-program');
                    if (programDiv) {
                        const programTitle = this.app.channelList.getProgramInfo(channel);
                        programDiv.textContent = programTitle || '';
                    }
                }
            }

            index = end;
            if (index < channelItems.length) {
                // Yield to browser before next batch
                requestAnimationFrame(processBatch);
            }
        };

        // Start processing
        requestAnimationFrame(processBatch);
    }

    handleKeydown(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key) {
            case 'ArrowUp':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectPrevChannel();
                break;
            case 'ArrowDown':
                // Check if player handles arrows for volume
                if (this.app.player && !this.app.player.settings.arrowKeysChangeChannel) return;

                e.preventDefault();
                this.app.channelList.selectNextChannel();
                break;
        }
    }

    async show() {
        document.addEventListener('keydown', this.handleKeydown);

        // Only reload if channels aren't already loaded
        if (this.app.channelList.channels.length === 0) {
            await this.app.channelList.loadSources();
            await this.app.channelList.loadChannels();
        }
    }

    hide() {
        document.removeEventListener('keydown', this.handleKeydown);
    }
}

window.LivePage = LivePage;
