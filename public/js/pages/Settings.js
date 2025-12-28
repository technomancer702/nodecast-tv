/**
 * Settings Page Controller
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll(".tabs .tab");
        this.tabContents = document.querySelectorAll(".tab-content");

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener("click", () => this.switchTab(tab.dataset.tab));
        });

        // Player settings
        this.initPlayerSettings();
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById("setting-arrow-keys");
        const overlayDurationInput = document.getElementById("setting-overlay-duration");
        const defaultVolumeSlider = document.getElementById("setting-default-volume");
        const volumeValueDisplay = document.getElementById("volume-value");
        const rememberVolumeToggle = document.getElementById("setting-remember-volume");
        const autoPlayNextToggle = document.getElementById("setting-autoplay-next");
        const forceProxyToggle = document.getElementById("setting-force-proxy");

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + "%";
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
            if (forceProxyToggle) {
                forceProxyToggle.checked = this.app.player.settings.forceProxy || false;
            }
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener("change", () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener("change", () => {
            const value = Math.min(30, Math.max(1, parseInt(overlayDurationInput.value) || 5));
            overlayDurationInput.value = value;
            this.app.player.settings.overlayDuration = value;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider?.addEventListener("input", () => {
            const value = parseInt(defaultVolumeSlider.value);
            volumeValueDisplay.textContent = value + "%";
            this.app.player.settings.defaultVolume = value;
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle?.addEventListener("change", () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle?.addEventListener("change", () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // Force proxy toggle
        forceProxyToggle?.addEventListener("change", () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById("epg-refresh-interval");
        if (epgRefreshSelect) {
            // Load saved value
            const savedInterval = localStorage.getItem("nodecast_tv_epg_refresh_interval");
            if (savedInterval) {
                epgRefreshSelect.value = savedInterval;
            }

            // Save on change
            epgRefreshSelect.addEventListener("change", () => {
                localStorage.setItem("nodecast_tv_epg_refresh_interval", epgRefreshSelect.value);
            });
        }
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle("active", c.id === `tab-${tabName}`));

        // Load content browser when switching to that tab
        if (tabName === "content") {
            this.app.sourceManager.loadContentSources();
        }
    }

    async show() {
        // Load sources when page is shown
        await this.app.sourceManager.loadSources();

        // Refresh player settings display
        const arrowKeysToggle = document.getElementById("setting-arrow-keys");
        const overlayDurationInput = document.getElementById("setting-overlay-duration");
        const forceProxyToggle = document.getElementById("setting-force-proxy");
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            if (forceProxyToggle) {
                forceProxyToggle.checked = this.app.player.settings.forceProxy || false;
            }
        }
    }

    hide() {
        // Page is hidden
    }
}

window.SettingsPage = SettingsPage;
