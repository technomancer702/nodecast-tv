/**
 * EPG Guide Component
 * Cable TV-style program guide grid
 */

class EpgGuide {
    constructor() {
        this.container = document.getElementById('epg-grid');
        this.dateDisplay = document.getElementById('guide-date');
        this.prevBtn = document.getElementById('guide-prev');
        this.nextBtn = document.getElementById('guide-next');
        this.nextBtn = document.getElementById('guide-next');
        this.groupSelect = document.getElementById('epg-group-select');
        this.searchInput = document.getElementById('epg-search');

        this.channels = [];
        this.programmes = [];
        this.currentDate = new Date();
        this.timeOffset = 0; // Hours offset from now
        this.pixelsPerMinute = 6.67; // Width scaling (30min = 200px)
        this.favorites = new Set(); // Set<"sourceId:channelId">
        this.selectedGroup = 'Favorites'; // Default to Favorites

        // Virtual scrolling properties
        this.filteredChannels = [];
        this.rowHeight = 60; // Height of each channel row in pixels
        this.bufferRows = 5; // Extra rows to render above/below viewport
        this.startTime = null;
        this.endTime = null;
        this.epgContainer = null;
        this.epgSpacer = null;
        this.scrollContainer = null;
        this.visibleRows = new Map(); // Map<index, rowElement>
        this._scrollHandler = null;
        this._lastVisibleStart = -1;
        this._lastVisibleEnd = -1;

        this.init();
    }

    /**
     * Get proxied image URL to avoid mixed content errors on HTTPS
     * Only proxies HTTP URLs when on HTTPS page
     */
    getProxiedImageUrl(url) {
        if (!url || url.length === 0) return '/img/placeholder.png';
        // Only proxy if we're on HTTPS and the image is HTTP
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return `/api/proxy/image?url=${encodeURIComponent(url)}`;
        }
        return url;
    }

    init() {
        this.prevBtn.addEventListener('click', () => this.navigate(-2));
        this.nextBtn.addEventListener('click', () => this.navigate(2));

        // Group filter change
        this.groupSelect?.addEventListener('change', () => {
            this.selectedGroup = this.groupSelect.value;
            this.render();
        });

        // Search input
        if (this.searchInput) {
            this.searchInput.addEventListener('input', this.debounce(() => {
                this.render();
            }, 300));
        }

        // Update current time indicator every minute
        setInterval(() => this.updateNowIndicator(), 60000);

        this.initResizer();
    }

    /**
     * Initialize sidebar resizer
     */
    initResizer() {
        let isResizing = false;
        let startX, startWidth;

        document.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('resize-handle')) {
                isResizing = true;
                startX = e.clientX;
                const sidebar = document.querySelector('.epg-channel-info');
                startWidth = sidebar.getBoundingClientRect().width;
                e.target.classList.add('active');
                document.body.style.cursor = 'col-resize';
                e.preventDefault(); // Prevent text selection
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const diff = e.clientX - startX;
            const newWidth = Math.max(150, Math.min(500, startWidth + diff)); // Min 150px, Max 500px

            document.documentElement.style.setProperty('--epg-sidebar-width', `${newWidth}px`);
            this.updateNowIndicator(); // Update line position
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.querySelectorAll('.resize-handle').forEach(h => h.classList.remove('active'));
                document.body.style.cursor = '';
            }
        });
    }

    /**
     * Navigate time
     */
    navigate(hours) {
        this.timeOffset += hours;
        this.render();
    }

    /**
     * Start background EPG display refresh timer
     * This only refreshes the UI from cached server data.
     * The actual sync runs on the server independently.
     */
    startBackgroundRefresh() {
        // Clear any existing timer
        this.stopBackgroundRefresh();

        // Refresh display from cache every 5 minutes to pick up server-side sync results
        const refreshIntervalMs = 5 * 60 * 1000; // 5 minutes

        console.log('[EPG] Starting display refresh timer: every 5 minutes');

        this._backgroundRefreshTimer = setInterval(async () => {
            console.log('[EPG] Refreshing EPG display from cache');
            try {
                await this.fetchEpgData(false); // Fetch cached data (no force refresh)

                // Update channel list program info if visible
                if (window.app?.channelList) {
                    window.app.channelList.clearProgramInfoCache();
                    window.app.channelList.updateVisibleEpgInfo?.();
                }
            } catch (err) {
                console.error('[EPG] Display refresh failed:', err);
            }
        }, refreshIntervalMs);
    }

    /**
     * Stop background EPG refresh timer
     */
    stopBackgroundRefresh() {
        if (this._backgroundRefreshTimer) {
            clearInterval(this._backgroundRefreshTimer);
            this._backgroundRefreshTimer = null;
            console.log('[EPG] Background refresh timer stopped');
        }
    }

    /**
     * Get last refresh time for display
     */
    getLastRefreshTime() {
        return this.lastRefreshTime || null;
    }

    /**
     * Load EPG data (server-side caching)
     */
    async loadEpg(forceRefresh = false) {
        try {
            this.container.innerHTML = '<div class="loading"></div>';
            await this.fetchEpgData(forceRefresh);
            this.lastRefreshTime = new Date();
            this.render();

            // Start background refresh timer after initial load
            // This ensures EPG data stays fresh while the app is open
            this.startBackgroundRefresh();
        } catch (err) {
            console.error('Error loading EPG:', err);
            this.container.innerHTML = `
        <div class="empty-state">
          <p>Error loading EPG</p>
          <p class="hint">${err.message}</p>
        </div>
      `;
        }
    }

    /**
     * Fetch EPG data from sources
     */
    async fetchEpgData(forceRefresh = false) {
        // Get ALL sources and filter for EPG-capable types
        const allSources = await API.sources.getAll();
        const sources = allSources.filter(s => (s.type === 'epg' || s.type === 'xtream') && s.enabled);

        if (sources.length === 0) {
            throw new Error('No EPG sources or Xtream accounts configured');
        }

        // Build query params for server-side caching
        // Sync interval is controlled by server, we just hint at max cache age
        const maxAge = 24; // hours - server controls actual refresh
        const queryParams = forceRefresh ? '?refresh=1' : `?maxAge=${maxAge}`;

        // Load EPG from ALL sources in parallel
        const fetchPromises = sources.map(async (source) => {
            try {
                const response = await fetch(`/api/proxy/epg/${source.id}${queryParams}`);
                if (!response.ok) throw new Error(`Status ${response.status}`);
                return await response.json();
            } catch (e) {
                console.warn(`Failed to load EPG for source ${source.name}:`, e);
                return null;
            }
        });

        const results = await Promise.all(fetchPromises);

        // Merge results
        this.channels = [];
        this.programmes = [];

        let hasData = false;
        results.forEach(data => {
            if (data) {
                if (data.channels && data.channels.length > 0) {
                    this.channels = this.channels.concat(data.channels);
                }
                if (data.programmes && data.programmes.length > 0) {
                    this.programmes = this.programmes.concat(data.programmes);
                }
                if (data.channels || data.programmes) {
                    hasData = true;
                }
            }
        });

        if (!hasData) {
            throw new Error('Failed to load EPG data from any source');
        }

        // Build secondary indexes for faster lookup
        this.channelMap = new Map();
        // Index by ID
        this.channels.forEach(ch => {
            this.channelMap.set(ch.id, ch);
            // Also index by name (normalized) for fallback matching
            if (ch.name) {
                this.channelMap.set(ch.name.toLowerCase(), ch);
            }
        });

        // Load favorites
        const favs = await API.favorites.getAll();
        this.favorites = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
    }

    /**
     * Get current program for a channel
     * @param {string} tvgId - The EPG channel ID (tvg-id)
     * @param {string} channelName - The channel name (for fallback)
     * @returns {object|null} Program object with title, start, stop
     */
    getCurrentProgram(tvgId, channelName) {
        if (!this.programmes || this.programmes.length === 0) return null;

        // Find EPG channel using fast map lookup
        let epgChannel = null;
        if (tvgId && this.channelMap && this.channelMap.has(tvgId)) {
            epgChannel = this.channelMap.get(tvgId);
        } else if (channelName && this.channelMap) {
            epgChannel = this.channelMap.get(channelName.toLowerCase());
        } else {
            // Fallback to slow search if map fails or not built yet
            epgChannel = this.channels.find(epg =>
                (tvgId && epg.id === tvgId) || epg.name === channelName
            );
        }

        if (!epgChannel) return null;

        const now = new Date();
        const nowTime = now.getTime();

        // Filter programs for this channel
        const current = this.programmes.find(p => {
            if (p.channelId !== epgChannel.id) return false;
            const start = new Date(p.start).getTime();
            const stop = new Date(p.stop).getTime();
            return nowTime >= start && nowTime < stop;
        });

        return current ? {
            title: current.title,
            start: current.start,
            stop: current.stop,
            description: current.description
        } : null;
    }

    /**
     * Update filtered channels based on search or group
     */
    updateFilteredChannels() {
        const searchTerm = this.searchInput ? this.searchInput.value.toLowerCase().trim() : '';

        // SEARCH MODE: Filter all channels by name
        if (searchTerm) {
            this.filteredChannels = this.allMatchedChannels.filter(ch => {
                const name = (ch.sourceChannel?.name || '').toLowerCase();
                return name.includes(searchTerm);
            });
            return;
        }

        // GROUP MODE (Default)
        if (this.selectedGroup === 'Favorites') {
            this.filteredChannels = this.allMatchedChannels.filter(m =>
                this.favorites.has(`${m.sourceChannel.sourceId}:${m.sourceChannel.id}`)
            );
            return;
        }

        if (!this.selectedGroup || this.selectedGroup === 'All') {
            this.filteredChannels = [...this.allMatchedChannels];
        } else {
            this.filteredChannels = this.allMatchedChannels.filter(m =>
                (m.sourceChannel.groupTitle || 'Uncategorized') === this.selectedGroup
            );
        }
    }

    /**
     * Render the EPG grid
     */
    render() {
        // Get channel list instance
        const channelList = window.app?.channelList;
        if (!channelList) return;

        // Get channels and filter out hidden ones (always enforce hidden in EPG)
        // Note: We only check individual channel visibility, not group visibility
        // A group is implicitly visible if it has any visible children
        const playableChannels = (channelList.channels || []).filter(ch => {
            // Use streamId (raw ID) for hidden check since that's what SourceManager stores
            const rawChannelId = ch.streamId || ch.id;
            const isChannelHidden = channelList.isHidden('channel', ch.sourceId, rawChannelId);
            return !isChannelHidden;
        });



        if (playableChannels.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state">
                    <p>No visible channels available</p>
                    <p class="hint">Check your content settings or add a source</p>
                </div>
            `;
            return;
        }

        // Match ALL playable channels with optional EPG data
        const allChannels = playableChannels.map(sourceChannel => {
            // Try to find matching EPG channel by tvgId or name
            const epgChannel = this.channels.find(epg =>
                epg.id === sourceChannel.tvgId || epg.name === sourceChannel.name
            );
            return { epgChannel, sourceChannel };
        });

        // Collect unique groups from ALL playable channels
        const groups = [...new Set(allChannels.map(m => m.sourceChannel.groupTitle || 'Uncategorized'))].sort();

        // Add Favorites at the top if there are any
        const hasFavorites = this.favorites.size > 0;

        // Only rebuild dropdown if groups have changed (performance optimization)
        const groupsKey = groups.join('|') + (hasFavorites ? '|FAV' : '');
        if (this.groupSelect && this._lastGroupsKey !== groupsKey) {
            this._lastGroupsKey = groupsKey;
            const currentValue = this.selectedGroup;
            let optionsHtml = '';

            if (hasFavorites) {
                optionsHtml += `<option value="Favorites" ${currentValue === 'Favorites' ? 'selected' : ''}>Favorites</option>`;
            }

            optionsHtml += `<option value="" ${currentValue === '' ? 'selected' : ''}>All Groups</option>`;
            optionsHtml += groups.map(g => `<option value="${g}" ${g === currentValue ? 'selected' : ''}>${g}</option>`).join('');

            this.groupSelect.innerHTML = optionsHtml;
        } else if (this.groupSelect) {
            // Just update the selected value without rebuilding
            this.groupSelect.value = this.selectedGroup;
        }

        // Handle case where we defaulted to Favorites but user has none
        if (this.selectedGroup === 'Favorites' && !hasFavorites) {
            this.selectedGroup = ''; // Fallback to 'All Groups'
            if (this.groupSelect) this.groupSelect.value = '';
        }

        // Store all channels (matched with EPG data) for filtering
        this.allMatchedChannels = allChannels;
        this.updateFilteredChannels();

        // Calculate time range and store for batch rendering
        this.startTime = new Date();
        this.startTime.setHours(this.startTime.getHours() + this.timeOffset);
        this.startTime.setMinutes(0, 0, 0);

        this.endTime = new Date(this.startTime);
        this.endTime.setHours(this.endTime.getHours() + 24); // Show 24 hours of programming

        // Update date display
        this.updateDateDisplay(this.startTime);

        // Generate time slots
        const timeSlots = this.generateTimeSlots(this.startTime, this.endTime);

        // Calculate total height for virtual scrolling
        const totalHeight = this.filteredChannels.length * this.rowHeight;

        // Build HTML structure - header is INSIDE scroll container for natural sync
        this.container.innerHTML = `
      <div class="epg-container" style="position: relative;">
        <div class="epg-scroll-container" style="overflow: auto; max-height: calc(100vh - 200px);">
          <div class="epg-time-header">
            <div class="epg-header-corner"></div>
            <div class="epg-time-slots">
              ${timeSlots.map(slot => `
                <div class="epg-time-slot" style="width: ${30 * this.pixelsPerMinute}px;">
                  ${slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              `).join('')}
            </div>
          </div>
          <div class="epg-spacer" style="height: ${totalHeight}px; position: relative;">
            <div class="epg-channel-rows" style="position: absolute; top: 0; left: 0; right: 0;"></div>
          </div>
        </div>
      </div>
    `;

        // Get references for virtual scrolling
        this.scrollContainer = this.container.querySelector('.epg-scroll-container');
        this.epgSpacer = this.container.querySelector('.epg-spacer');
        this.epgContainer = this.container.querySelector('.epg-channel-rows');

        // Clear visible rows cache
        this.visibleRows.clear();
        this._lastVisibleStart = -1;
        this._lastVisibleEnd = -1;

        // Remove old scroll handler if exists
        if (this._scrollHandler) {
            this.scrollContainer?.removeEventListener('scroll', this._scrollHandler);
        }
        if (this._hScrollHandler) {
            this.scrollContainer?.removeEventListener('scroll', this._hScrollHandler);
        }

        // Get reference to time slots container for horizontal scroll sync
        this.timeSlotsContainer = this.container.querySelector('.epg-time-slots');

        // Set up scroll handler for virtual scrolling (debounced for performance)
        this._scrollHandler = this.debounce(() => this.updateVisibleRows(), 16); // ~60fps
        this.scrollContainer.addEventListener('scroll', this._scrollHandler);

        // No need for horizontal scroll sync anymore - header is inside scroll container

        // Initial render of visible rows
        this.updateVisibleRows();

        // Sync header corner width with actual sidebar width (handles CSS overrides)
        this.syncHeaderCornerWidth();

        // Add now indicator and set up periodic refresh
        this.updateNowIndicator();
        // Clear any existing interval
        if (this._nowIndicatorInterval) {
            clearInterval(this._nowIndicatorInterval);
        }
        // Update indicator every 60 seconds
        this._nowIndicatorInterval = setInterval(() => this.updateNowIndicator(), 60000);
    }

    /**
     * Sync header corner width with actual sidebar width
     * This handles cases where CSS variables are overridden on mobile
     */
    syncHeaderCornerWidth() {
        const sidebar = this.container.querySelector('.epg-channel-info');
        const headerCorner = this.container.querySelector('.epg-header-corner');
        if (sidebar && headerCorner) {
            const actualWidth = sidebar.offsetWidth;
            headerCorner.style.width = `${actualWidth}px`;
        }
    }

    /**
     * Update visible rows based on scroll position (Virtual Scrolling)
     */
    updateVisibleRows() {
        if (!this.scrollContainer || !this.epgContainer) return;

        const scrollTop = this.scrollContainer.scrollTop;
        const viewportHeight = this.scrollContainer.clientHeight;

        // Calculate visible range
        const startIndex = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const endIndex = Math.min(
            this.filteredChannels.length - 1,
            Math.ceil((scrollTop + viewportHeight) / this.rowHeight) + this.bufferRows
        );

        // Skip if nothing changed
        if (startIndex === this._lastVisibleStart && endIndex === this._lastVisibleEnd) {
            return;
        }

        this._lastVisibleStart = startIndex;
        this._lastVisibleEnd = endIndex;

        // Determine which rows to add and remove
        const newVisibleSet = new Set();
        for (let i = startIndex; i <= endIndex; i++) {
            newVisibleSet.add(i);
        }

        // Remove rows that are no longer visible
        for (const [index, row] of this.visibleRows) {
            if (!newVisibleSet.has(index)) {
                row.remove();
                this.visibleRows.delete(index);
            }
        }

        // Add new visible rows
        for (let i = startIndex; i <= endIndex; i++) {
            if (!this.visibleRows.has(i) && i < this.filteredChannels.length) {
                const row = this.createChannelRow(i);
                this.visibleRows.set(i, row);
                this.epgContainer.appendChild(row);
            }
        }
    }

    /**
     * Create a channel row element for virtual scrolling
     */
    createChannelRow(index) {
        const { epgChannel, sourceChannel } = this.filteredChannels[index];
        const isFavorite = this.favorites.has(`${sourceChannel.sourceId}:${sourceChannel.id}`);

        // Get programs if EPG data exists
        let channelProgrammes = [];
        if (epgChannel) {
            channelProgrammes = this.programmes
                .filter(p => p.channelId === epgChannel.id)
                .filter(p => {
                    const start = new Date(p.start);
                    const stop = new Date(p.stop);
                    return start < this.endTime && stop > this.startTime;
                })
                .sort((a, b) => new Date(a.start) - new Date(b.start));
        }

        // Fallback values if EPG channel is missing
        const logo = this.getProxiedImageUrl(sourceChannel.tvgLogo || (epgChannel && epgChannel.icon));
        const name = sourceChannel.name || (epgChannel && epgChannel.name);

        const row = document.createElement('div');
        row.className = 'epg-channel-row';
        row.dataset.channelId = sourceChannel.id;
        row.dataset.sourceId = sourceChannel.sourceId;
        row.dataset.index = index;
        // Position absolutely for virtual scrolling
        row.style.position = 'absolute';
        row.style.top = `${index * this.rowHeight}px`;
        row.style.left = '0';
        row.style.right = '0';
        row.style.height = `${this.rowHeight}px`;

        row.innerHTML = `
          <div class="epg-channel-info">
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
            <img class="epg-channel-logo" src="${logo}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <span class="epg-channel-name">${name}</span>
            <div class="resize-handle"></div>
          </div>
          <div class="epg-programs">
            ${this.renderProgrammes(channelProgrammes, this.startTime, this.endTime)}
          </div>
        `;

        this.attachRowListeners(row);
        return row;
    }

    /**
     * Attach event listeners to an EPG row
     */
    attachRowListeners(row) {
        // Program click handlers
        row.querySelectorAll('.epg-program').forEach(prog => {
            prog.addEventListener('click', () => this.showProgramDetails(prog.dataset));
        });

        const info = row.querySelector('.epg-channel-info');
        if (info) {
            // Name/Logo click plays channel
            info.querySelector('.epg-channel-name')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playChannel(info.querySelector('.epg-channel-name').textContent);
            });
            info.querySelector('.epg-channel-logo')?.addEventListener('click', (e) => {
                e.stopPropagation();
                this.playChannel(info.querySelector('.epg-channel-name').textContent);
            });

            // Favorite click
            const favBtn = info.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const sourceId = parseInt(row.dataset.sourceId);
                    const channelId = row.dataset.channelId;
                    await this.toggleFavorite(sourceId, channelId);
                });
            }
        }
    }

    /**
     * Toggle favorite
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.favorites.has(key);
        const isNowFavorite = !wasFavorite;

        // 1. Optimistic Update (EPG)
        if (isNowFavorite) {
            this.favorites.add(key);
        } else {
            this.favorites.delete(key);
        }

        // Update DOM (All matching buttons in EPG)
        const rows = this.container.querySelectorAll(`.epg-channel-row[data-channel-id="${channelId}"][data-source-id="${sourceId}"]`);
        rows.forEach(row => {
            const btn = row.querySelector('.favorite-btn');
            if (btn) {
                if (isNowFavorite) {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                } else {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                }
            }
        });

        // 2. Sync Channel List State (Optimistic)
        if (window.app?.channelList) {
            window.app.channelList.syncFavorite(sourceId, channelId, isNowFavorite);
        }

        try {
            // 3. API Call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // 4. Re-render if viewing Favorites group (so new favorites appear immediately)
            if (this.selectedGroup === 'Favorites') {
                this.render();
            }
        } catch (err) {
            console.error('Error toggling favorite in EPG:', err);

            // Revert EPG
            if (wasFavorite) {
                this.favorites.add(key);
            } else {
                this.favorites.delete(key);
            }

            rows.forEach(row => {
                const btn = row.querySelector('.favorite-btn');
                if (btn) {
                    if (wasFavorite) {
                        btn.classList.add('active');
                        btn.innerHTML = Icons.favorite;
                        btn.title = 'Remove from Favorites';
                    } else {
                        btn.classList.remove('active');
                        btn.innerHTML = Icons.favoriteOutline;
                        btn.title = 'Add to Favorites';
                    }
                }
            });

            // Revert Channel List
            if (window.app?.channelList) {
                window.app.channelList.syncFavorite(sourceId, channelId, wasFavorite);
            }
        }
    }

    /**
     * Sync favorite status from external source (e.g. ChannelList) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        // Ensure consistent string format for key
        const key = `${String(sourceId)}:${String(channelId)}`;
        const currentlyFav = this.favorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.favorites.add(key);
        } else {
            this.favorites.delete(key);
        }

        // Update DOM (All instances in EPG)
        const rows = this.container.querySelectorAll(`.epg-channel-row[data-channel-id="${channelId}"][data-source-id="${sourceId}"]`);
        rows.forEach(row => {
            const btn = row.querySelector('.favorite-btn');
            if (btn) {
                if (isFavorite) {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                } else {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                }
            }
        });

        // Note: We don't call render() here - the favorites Set is updated
        // and will be used when the user navigates to Guide or switches groups
    }

    /**
     * Generate time slots
     */
    generateTimeSlots(start, end) {
        const slots = [];
        const current = new Date(start);

        while (current < end) {
            slots.push(new Date(current));
            current.setMinutes(current.getMinutes() + 30);
        }

        return slots;
    }

    /**
     * Render programmes for a channel
     */
    renderProgrammes(programmes, startTime, endTime) {
        if (programmes.length === 0) {
            const width = (endTime - startTime) / 60000 * this.pixelsPerMinute;
            return `<div class="epg-program" style="width: ${width}px;"><span class="epg-program-title">No data</span></div>`;
        }

        const now = new Date();
        let html = '';
        let currentPos = startTime.getTime();

        for (const prog of programmes) {
            const progStart = Math.max(new Date(prog.start).getTime(), startTime.getTime());
            const progEnd = Math.min(new Date(prog.stop).getTime(), endTime.getTime());

            // Fill gap if needed
            if (progStart > currentPos) {
                const gapWidth = (progStart - currentPos) / 60000 * this.pixelsPerMinute;
                html += `<div class="epg-program" style="width: ${gapWidth}px;"></div>`;
            }

            const width = (progEnd - progStart) / 60000 * this.pixelsPerMinute;
            const isCurrent = new Date(prog.start) <= now && new Date(prog.stop) > now;

            html += `
        <div class="epg-program ${isCurrent ? 'current' : ''}" 
             style="width: ${width}px;"
             data-title="${prog.title || ''}"
             data-description="${prog.description || ''}"
             data-start="${prog.start}"
             data-stop="${prog.stop}">
          <div class="epg-program-title">${prog.title || 'Unknown'}</div>
          <div class="epg-program-time">
            ${new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      `;

            currentPos = progEnd;
        }

        return html;
    }

    /**
     * Update date display
     */
    updateDateDisplay(date) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (date.toDateString() === today.toDateString()) {
            this.dateDisplay.textContent = 'Today';
        } else if (date.toDateString() === tomorrow.toDateString()) {
            this.dateDisplay.textContent = 'Tomorrow';
        } else {
            this.dateDisplay.textContent = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }
    }

    /**
     * Debounce utility
     */
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    updateNowIndicator() {
        const now = new Date();
        // Place indicator inside the spacer so it scrolls with content
        const spacer = this.container.querySelector('.epg-spacer');
        if (!spacer) return;

        // Remove existing indicator
        const existing = spacer.querySelector('.epg-now-line');
        if (existing) existing.remove();

        // Calculate position relative to EPG start time
        const minutesFromStart = (now - this.startTime) / 60000;
        if (minutesFromStart < 0 || minutesFromStart > 1440) return; // Not in visible 24h range

        // Get sidebar width to offset the indicator
        const sidebar = this.container.querySelector('.epg-channel-info');
        const sidebarWidth = sidebar ? sidebar.offsetWidth : 150;

        // Position is sidebar + time offset
        const leftPos = sidebarWidth + (minutesFromStart * this.pixelsPerMinute);

        const indicator = document.createElement('div');
        indicator.className = 'epg-now-line';
        indicator.style.left = `${leftPos}px`;
        spacer.appendChild(indicator);
    }

    /**
     * Show program details modal
     */
    showProgramDetails(data) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');

        title.textContent = data.title || 'Program Details';

        const start = new Date(data.start);
        const stop = new Date(data.stop);

        body.innerHTML = `
      <p><strong>Time:</strong> ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
      <p><strong>Description:</strong></p>
      <p>${data.description || 'No description available'}</p>
    `;

        footer.innerHTML = '<button class="btn btn-secondary" id="modal-close">Close</button>';

        modal.classList.add('active');
        document.getElementById('modal-close').onclick = () => modal.classList.remove('active');
        modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
    }

    /**
     * Play channel from EPG
     */
    async playChannel(channelName) {
        // Find channel in channel list and play
        if (window.app?.channelList) {
            const channel = window.app.channelList.channels.find(c =>
                c.name === channelName || c.tvgName === channelName
            );
            if (channel) {
                await window.app.channelList.selectChannel({ channelId: channel.id });
                // Switch to home page
                document.querySelector('[data-page="home"]').click();
            }
        }
    }
}

// Export
window.EpgGuide = EpgGuide;
