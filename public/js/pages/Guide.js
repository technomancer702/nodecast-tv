/**
 * Guide Page Controller
 */

class GuidePage {
    constructor(app) {
        this.app = app;
    }

    async init() {
        // EPG guide will lazy load when shown
    }

    async show() {
        // Ensure channel data is loaded before rendering EPG
        // This fixes a race condition where navigating directly to the Guide page
        // before visiting Live TV would result in an empty EPG.
        const channelList = this.app.channelList;
        if (!channelList.channels || channelList.channels.length === 0) {
            await channelList.loadSources();
            await channelList.loadChannels();
        }

        // Only load EPG data if not already loaded.
        // Checks fullEpgLoaded, not programmes.length - startup populates the
        // now-playing set only, which is not enough to render the guide grid.
        if (!this.app.epgGuide.fullEpgLoaded) {
            await this.app.epgGuide.loadEpg();
        } else {
            // Just re-render with existing data (updates time position)
            this.app.epgGuide.render();
        }
    }

    hide() {
        // Page is hidden
    }
}

window.GuidePage = GuidePage;
