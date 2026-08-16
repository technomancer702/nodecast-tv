/**
 * Multi-view page: four independent live players with shared channel picker.
 */
class MultiViewPage {
    constructor(app) {
        this.app = app;
        this.grid = document.getElementById('multiview-grid');
        this.picker = document.getElementById('multiview-picker');
        this.results = document.getElementById('multiview-channel-results');
        this.sourceFilter = document.getElementById('multiview-source-filter');
        this.groupFilter = document.getElementById('multiview-group-filter');
        this.searchInput = document.getElementById('multiview-search');
        this.sources = [];
        this.channels = [];
        this.channelMap = new Map();
        this.activeSlot = null;
        this.initialized = false;
        this.loadingChannels = null;
        const savedScreenCount = Number.parseInt(localStorage.getItem('nodecast_multiview_screen_count'), 10);
        this.screenCount = savedScreenCount >= 1 && savedScreenCount <= 4 ? savedScreenCount : 4;
        this.slots = Array.from({ length: 4 }, () => ({
            hls: null,
            channel: null,
            generation: 0,
            proxyRetried: false
        }));

        this.renderTiles();
        this.bindEvents();
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    renderTiles() {
        if (!this.grid) return;

        this.grid.innerHTML = this.slots.map((_, index) => `
            <article class="multiview-tile ${index >= this.screenCount ? 'is-hidden' : ''}" data-slot="${index}">
                <video class="multiview-video" playsinline muted></video>
                <div class="multiview-empty">
                    <span class="multiview-slot-number">Tela ${index + 1}</span>
                    <button class="btn btn-primary" data-action="choose">Escolher canal</button>
                </div>
                <div class="multiview-loading" aria-hidden="true">
                    <div class="loading-spinner"></div>
                </div>
                <div class="multiview-tile-topbar">
                    <div class="multiview-channel-title">Nenhum canal</div>
                    <button class="multiview-icon-btn" data-action="close" title="Fechar canal">&times;</button>
                </div>
                <div class="multiview-tile-controls">
                    <button class="multiview-control-btn" data-action="choose">Trocar</button>
                    <button class="multiview-control-btn" data-action="audio">Ativar som</button>
                    <button class="multiview-control-btn" data-action="fullscreen">Tela cheia</button>
                </div>
                <button class="multiview-exit-fullscreen" data-action="exit-fullscreen" aria-label="Sair da tela cheia">
                    Sair da tela cheia
                </button>
                <div class="multiview-error"></div>
            </article>
        `).join('');
        this.applyScreenCount();
    }

    bindEvents() {
        this.grid?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            const tile = event.target.closest('.multiview-tile');
            if (!button || !tile) return;

            const slotIndex = Number(tile.dataset.slot);
            switch (button.dataset.action) {
                case 'choose':
                    this.openPicker(slotIndex);
                    break;
                case 'close':
                    this.stopSlot(slotIndex, true);
                    break;
                case 'audio':
                    this.toggleAudio(slotIndex);
                    break;
                case 'fullscreen':
                    this.enterFullscreen(slotIndex);
                    break;
                case 'exit-fullscreen':
                    this.exitFullscreen();
                    break;
            }
        });

        document.getElementById('multiview-stop-all')?.addEventListener('click', () => this.stopAll(true));
        document.querySelector('.multiview-screen-count')?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-screen-count]');
            if (button) this.setScreenCount(Number(button.dataset.screenCount));
        });
        document.getElementById('multiview-picker-close')?.addEventListener('click', () => this.closePicker());
        this.picker?.addEventListener('click', (event) => {
            if (event.target === this.picker) this.closePicker();
        });

        this.sourceFilter?.addEventListener('change', () => {
            this.updateGroupFilter();
            this.renderPickerResults();
        });
        this.groupFilter?.addEventListener('change', () => this.renderPickerResults());
        this.searchInput?.addEventListener('input', () => this.renderPickerResults());

        this.results?.addEventListener('click', (event) => {
            const item = event.target.closest('[data-channel-key]');
            if (!item) return;
            const channel = this.channelMap.get(item.dataset.channelKey);
            if (channel && this.activeSlot !== null) {
                const slotIndex = this.activeSlot;
                this.closePicker();
                this.playChannel(slotIndex, channel);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.picker?.classList.contains('active')) {
                this.closePicker();
            }
        });
    }

    async show() {
        // Avoid hidden playback consuming provider connections.
        this.app.player?.stop?.();
        this.app.pages.watch?.stop?.();

        if (!this.initialized) {
            this.initialized = true;
            await this.loadChannels();
        }
    }

    hide() {
        this.closePicker();
        this.stopAll(true);
    }

    setScreenCount(count) {
        if (!Number.isInteger(count) || count < 1 || count > 4 || count === this.screenCount) return;

        if (count < this.screenCount) {
            for (let index = count; index < this.slots.length; index += 1) {
                this.stopSlot(index, true);
            }
        }

        this.screenCount = count;
        localStorage.setItem('nodecast_multiview_screen_count', String(count));
        this.applyScreenCount();
    }

    applyScreenCount() {
        if (!this.grid) return;
        this.grid.classList.remove('screens-1', 'screens-2', 'screens-3', 'screens-4');
        this.grid.classList.add(`screens-${this.screenCount}`);

        this.slots.forEach((_slot, index) => {
            this.getTile(index)?.classList.toggle('is-hidden', index >= this.screenCount);
        });

        document.querySelectorAll('[data-screen-count]').forEach(button => {
            const active = Number(button.dataset.screenCount) === this.screenCount;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    async loadChannels() {
        if (this.loadingChannels) return this.loadingChannels;

        this.loadingChannels = (async () => {
            this.setPickerMessage('Carregando canais...');
            this.sources = (await API.sources.getAll()).filter(source => source.enabled && ['xtream', 'm3u'].includes(source.type));

            const sourceResults = await Promise.all(this.sources.map(async (source) => {
                try {
                    const [categories, streams] = await Promise.all([
                        API.proxy.xtream.liveCategories(source.id),
                        API.proxy.xtream.liveStreams(source.id)
                    ]);
                    const categoryNames = new Map(categories.map(category => [String(category.category_id), category.category_name]));

                    return streams.map(stream => ({
                        key: `${source.id}:${stream.stream_id}`,
                        sourceId: source.id,
                        sourceName: source.name,
                        sourceType: source.type,
                        streamId: stream.stream_id,
                        name: stream.name || 'Canal sem nome',
                        logo: stream.stream_icon || '',
                        url: stream.stream_url || '',
                        group: categoryNames.get(String(stream.category_id)) || 'Sem categoria'
                    }));
                } catch (error) {
                    console.warn(`[MultiView] Falha ao carregar a fonte ${source.name}:`, error.message);
                    return [];
                }
            }));

            this.channels = sourceResults.flat().sort((a, b) => a.name.localeCompare(b.name));
            this.channelMap = new Map(this.channels.map(channel => [channel.key, channel]));
            this.populateSourceFilter();
            this.updateGroupFilter();
            this.renderPickerResults();
        })().finally(() => {
            this.loadingChannels = null;
        });

        return this.loadingChannels;
    }

    populateSourceFilter() {
        if (!this.sourceFilter) return;
        this.sourceFilter.innerHTML = '<option value="">Todas as fontes</option>' + this.sources.map(source =>
            `<option value="${this.escapeHtml(source.id)}">${this.escapeHtml(source.name)}</option>`
        ).join('');
    }

    updateGroupFilter() {
        if (!this.groupFilter) return;
        const sourceId = this.sourceFilter?.value || '';
        const groups = [...new Set(this.channels
            .filter(channel => !sourceId || String(channel.sourceId) === sourceId)
            .map(channel => channel.group))]
            .sort((a, b) => a.localeCompare(b));

        const previousValue = this.groupFilter.value;
        this.groupFilter.innerHTML = '<option value="">Todas as categorias</option>' + groups.map(group =>
            `<option value="${this.escapeHtml(group)}">${this.escapeHtml(group)}</option>`
        ).join('');
        if (groups.includes(previousValue)) this.groupFilter.value = previousValue;
    }

    openPicker(slotIndex) {
        this.activeSlot = slotIndex;
        this.picker?.classList.add('active');
        this.picker?.setAttribute('aria-hidden', 'false');
        this.searchInput?.focus();

        if (this.channels.length === 0) {
            this.loadChannels();
        } else {
            this.renderPickerResults();
        }
    }

    closePicker() {
        this.picker?.classList.remove('active');
        this.picker?.setAttribute('aria-hidden', 'true');
        this.activeSlot = null;
    }

    getFilteredChannels() {
        const sourceId = this.sourceFilter?.value || '';
        const group = this.groupFilter?.value || '';
        const query = (this.searchInput?.value || '').trim().toLocaleLowerCase();

        return this.channels.filter(channel => {
            if (sourceId && String(channel.sourceId) !== sourceId) return false;
            if (group && channel.group !== group) return false;
            if (query && !`${channel.name} ${channel.group}`.toLocaleLowerCase().includes(query)) return false;
            return true;
        });
    }

    renderPickerResults() {
        if (!this.results) return;
        const filtered = this.getFilteredChannels();
        const visible = filtered.slice(0, 200);
        const count = document.getElementById('multiview-picker-count');
        if (count) {
            count.textContent = filtered.length > visible.length
                ? `${filtered.length.toLocaleString()} canais — refine a busca para ver mais`
                : `${filtered.length.toLocaleString()} canais`;
        }

        if (visible.length === 0) {
            this.setPickerMessage(this.channels.length ? 'Nenhum canal encontrado.' : 'Nenhum canal disponível.');
            return;
        }

        this.results.innerHTML = visible.map(channel => `
            <button class="multiview-channel-option" data-channel-key="${this.escapeHtml(channel.key)}">
                <img src="${this.escapeHtml(Security.imageUrl(channel.logo))}" alt="">
                <span>
                    <strong>${this.escapeHtml(channel.name)}</strong>
                    <small>${this.escapeHtml(channel.group)} · ${this.escapeHtml(channel.sourceName)}</small>
                </span>
            </button>
        `).join('');
    }

    setPickerMessage(message) {
        if (this.results) {
            this.results.innerHTML = `<div class="multiview-picker-empty">${this.escapeHtml(message)}</div>`;
        }
    }

    async resolveStreamUrl(channel) {
        if (channel.sourceType === 'xtream') {
            const format = this.app.player?.settings?.streamFormat || 'm3u8';
            const result = await API.proxy.xtream.getStreamUrl(
                channel.sourceId,
                channel.streamId,
                'live',
                format
            );
            return result.url;
        }
        return channel.url;
    }

    async playChannel(slotIndex, channel) {
        this.stopSlot(slotIndex, true);
        const slot = this.slots[slotIndex];
        const generation = slot.generation;
        slot.channel = channel;
        slot.proxyRetried = false;
        this.updateTile(slotIndex, 'loading');

        try {
            const streamUrl = await this.resolveStreamUrl(channel);
            if (!streamUrl) throw new Error('O canal não possui uma URL de reprodução.');
            if (slot.generation !== generation) return;

            const tile = this.getTile(slotIndex);
            const video = tile?.querySelector('video');
            if (!video) return;

            video.muted = true;
            video.volume = 1;
            video.onerror = () => this.showTileError(slotIndex, 'Não foi possível reproduzir este canal.');

            const initialUrl = this.getProxiedUrl(streamUrl);
            const looksLikeHls = streamUrl.includes('.m3u8') || streamUrl.toLowerCase().includes('m3u8');

            if (looksLikeHls && window.Hls?.isSupported()) {
                const hls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: false,
                    maxBufferLength: 20,
                    manifestLoadingMaxRetry: 2,
                    fragLoadingMaxRetry: 3
                });
                slot.hls = hls;
                slot.proxyRetried = true;
                hls.loadSource(initialUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (slot.generation !== generation) return;
                    this.updateTile(slotIndex, 'playing');
                    video.play().catch(error => {
                        if (error.name !== 'AbortError') this.showTileError(slotIndex, 'Clique em ativar som ou tente novamente.');
                    });
                });
                hls.on(Hls.Events.ERROR, (_event, data) => {
                    if (!data.fatal || slot.generation !== generation) return;
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !slot.proxyRetried) {
                        slot.proxyRetried = true;
                        hls.loadSource(this.getProxiedUrl(streamUrl));
                        hls.startLoad();
                        return;
                    }
                    this.showTileError(slotIndex, 'Falha no canal ou limite de conexões atingido.');
                });
            } else {
                video.src = initialUrl;
                await video.play();
                if (slot.generation === generation) this.updateTile(slotIndex, 'playing');
            }
        } catch (error) {
            if (slot.generation === generation) {
                this.showTileError(slotIndex, error.message || 'Falha ao iniciar o canal.');
            }
        }
    }

    getProxiedUrl(url) {
        if (typeof url === 'string' && url.startsWith('/api/')) return url;
        const safe = Security.safeUrl(url);
        return safe ? `/api/proxy/stream?url=${encodeURIComponent(safe)}` : '';
    }

    getTile(slotIndex) {
        return this.grid?.querySelector(`[data-slot="${slotIndex}"]`);
    }

    updateTile(slotIndex, state) {
        const tile = this.getTile(slotIndex);
        const slot = this.slots[slotIndex];
        if (!tile) return;

        tile.classList.toggle('has-channel', Boolean(slot.channel));
        tile.classList.toggle('is-loading', state === 'loading');
        tile.classList.toggle('has-error', state === 'error');
        tile.querySelector('.multiview-channel-title').textContent = slot.channel?.name || 'Nenhum canal';
        if (state !== 'error') tile.querySelector('.multiview-error').textContent = '';
        this.updateAudioButtons();
    }

    showTileError(slotIndex, message) {
        const tile = this.getTile(slotIndex);
        if (!tile) return;
        tile.querySelector('.multiview-error').textContent = message;
        this.updateTile(slotIndex, 'error');
    }

    toggleAudio(slotIndex) {
        const tile = this.getTile(slotIndex);
        const video = tile?.querySelector('video');
        if (!video || !this.slots[slotIndex].channel) return;

        const shouldEnable = video.muted;
        this.slots.forEach((_slot, index) => {
            const otherVideo = this.getTile(index)?.querySelector('video');
            if (otherVideo) otherVideo.muted = true;
        });
        video.muted = !shouldEnable;
        if (shouldEnable) video.play().catch(() => {});
        this.updateAudioButtons();
    }

    updateAudioButtons() {
        this.slots.forEach((_slot, index) => {
            const tile = this.getTile(index);
            const video = tile?.querySelector('video');
            const button = tile?.querySelector('[data-action="audio"]');
            if (!video || !button) return;
            const enabled = !video.muted && Boolean(this.slots[index].channel);
            tile.classList.toggle('audio-active', enabled);
            button.textContent = enabled ? 'Som ativo' : 'Ativar som';
        });
    }

    enterFullscreen(slotIndex) {
        const tile = this.getTile(slotIndex);
        if (!tile || !this.slots[slotIndex].channel) return;
        const request = tile.requestFullscreen || tile.webkitRequestFullscreen;
        if (!request) return;
        Promise.resolve(request.call(tile)).catch(() => {});
    }

    exitFullscreen() {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!exit || (!document.fullscreenElement && !document.webkitFullscreenElement)) return;
        Promise.resolve(exit.call(document)).catch(() => {});
    }

    stopSlot(slotIndex, clearChannel = false) {
        const slot = this.slots[slotIndex];
        slot.generation += 1;
        slot.hls?.destroy();
        slot.hls = null;

        const video = this.getTile(slotIndex)?.querySelector('video');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.muted = true;
        }

        if (clearChannel) slot.channel = null;
        this.updateTile(slotIndex, 'idle');
    }

    stopAll(clearChannels = false) {
        this.slots.forEach((_slot, index) => this.stopSlot(index, clearChannels));
    }
}

window.MultiViewPage = MultiViewPage;
