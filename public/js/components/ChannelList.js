/**
 * Channel List Component
 * Handles the sidebar channel list
 */

class ChannelList {
    constructor() {
        this.container = document.getElementById('channel-list');
        this.searchInput = document.getElementById('channel-search');
        this.sourceSelect = document.getElementById('source-select');
        this.showHiddenCheckbox = document.getElementById('show-hidden');
        this.toggleGroupsBtn = document.getElementById('toggle-groups');
        this.contextMenu = document.getElementById('context-menu');

        this.channels = [];
        this.groups = [];
        this.hiddenItems = new Set(); // Set<"type:sourceId:itemId">
        this.collapsedGroups = new Set(); // Track collapsed groups
        this._userExpandedGroups = new Set(); // Track groups user has explicitly expanded
        this.favorites = []; // Array of favorite objects
        this.visibleFavorites = new Set(); // Set<"sourceId:channelId">
        this.currentChannel = null;
        this.sources = [];
        this.isLoading = false;
        this.renderedChannels = [];

        this.loadCollapsedState();
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

    /**
     * Load collapsed state from localStorage
     */
    loadCollapsedState() {
        try {
            const saved = localStorage.getItem('nodecast_tv_collapsed_groups');
            if (saved) {
                this.collapsedGroups = new Set(JSON.parse(saved));
                this._hasCollapsedState = true;
            } else {
                this._hasCollapsedState = false; // First load - will collapse all by default
            }
        } catch (err) {
            console.error('Error loading collapsed state:', err);
            this._hasCollapsedState = false;
        }
    }

    /**
     * Save collapsed state to localStorage
     */
    saveCollapsedState() {
        try {
            localStorage.setItem('nodecast_tv_collapsed_groups', JSON.stringify([...this.collapsedGroups]));
        } catch (err) {
            console.error('Error saving collapsed state:', err);
        }
    }

    /**
     * Toggle group collapsed state
     */
    toggleGroup(groupName) {
        if (this.collapsedGroups.has(groupName)) {
            this.collapsedGroups.delete(groupName);
            // Track that user explicitly expanded this group
            this._userExpandedGroups.add(groupName);
        } else {
            this.collapsedGroups.add(groupName);
            // User collapsed it, remove from expanded tracking
            this._userExpandedGroups.delete(groupName);
        }
        this.saveCollapsedState();
    }

    /**
     * Expand all groups
     */
    expandAll() {
        this.collapsedGroups.clear();
        this.saveCollapsedState();

        // Expand all and render channels for empty containers
        this.container.querySelectorAll('.group-header.collapsed').forEach(h => {
            h.classList.remove('collapsed');
            const groupName = h.dataset.group;
            const groupEl = h.closest('.channel-group');
            const channelsContainer = groupEl?.querySelector('.group-channels');
            if (channelsContainer && channelsContainer.children.length === 0) {
                this.renderGroupChannels(groupName, channelsContainer);
            }
        });

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.collapseAll;
            this.toggleGroupsBtn.title = 'Collapse All';
        }
    }

    /**
     * Collapse all groups
     */
    collapseAll() {
        this.container.querySelectorAll('.group-header').forEach(h => {
            const groupName = h.dataset.group;
            this.collapsedGroups.add(groupName);
            h.classList.add('collapsed');
        });
        this.saveCollapsedState();

        // Update toggle button
        if (this.toggleGroupsBtn) {
            this.toggleGroupsBtn.innerHTML = Icons.expandAll;
            this.toggleGroupsBtn.title = 'Expand All';
        }
    }

    /**
     * Toggle between expand/collapse all
     */
    toggleAllGroups() {
        const allHeaders = this.container.querySelectorAll('.group-header');
        const allCollapsed = [...allHeaders].every(h => h.classList.contains('collapsed'));

        if (allCollapsed) {
            this.expandAll();
        } else {
            this.collapseAll();
        }
    }

    init() {
        // Search handler (debounced)
        let searchTimeout;
        this.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                this.render();
            }, 300);
        });

        // Source filter handler
        this.sourceSelect.addEventListener('change', () => this.loadChannels());

        // Show hidden toggle
        if (this.showHiddenCheckbox) {
            this.showHiddenCheckbox.addEventListener('change', () => this.render());
        }

        // Context menu handlers
        document.addEventListener('click', (e) => {
            // Don't close if clicking inside context menu
            if (!this.contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        });

        this.contextMenu.querySelectorAll('.context-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent document click from firing
                this.handleContextAction(e);
            });
        });

        // Intersection Observer for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                this.renderNextBatch();
            }
        }, { rootMargin: '100px' });

        // Start EPG refresh timer (updates visible program info every 60 seconds)
        this.startEpgRefreshTimer();
    }

    /**
     * Start timer to refresh EPG info in visible channel items
     * Updates every 60 seconds to keep "Now Playing" program info current
     */
    startEpgRefreshTimer() {
        // Clear any existing timer
        if (this._epgRefreshTimer) {
            clearInterval(this._epgRefreshTimer);
        }

        // Refresh every 60 seconds
        this._epgRefreshTimer = setInterval(() => {
            this.updateVisibleEpgInfo();
        }, 60000);
    }

    /**
     * Update EPG info for visible channel items without full re-render
     * Only updates the program text, not the entire channel item
     */
    updateVisibleEpgInfo() {
        if (!window.app || !window.app.epgGuide) return;

        // Clear the cache so we get fresh data
        this.clearProgramInfoCache();

        // Find all visible channel items and update their program info
        const channelItems = this.container.querySelectorAll('.channel-item');
        channelItems.forEach(item => {
            const channelId = item.dataset.channelId;
            const sourceId = item.dataset.sourceId;

            // Find the channel data
            const channel = this.channels.find(c =>
                String(c.id) === String(channelId) &&
                String(c.sourceId) === String(sourceId)
            );

            if (channel) {
                const programInfo = this.getProgramInfo(channel);
                const programElement = item.querySelector('.channel-program');
                if (programElement) {
                    programElement.textContent = programInfo || '';
                }
            }
        });
    }

    // ... (loadSources, loadChannels, loadAllChannels, loadXtreamChannels, loadM3uChannels, loadHiddenItems, isHidden, loadFavorites, isFavorite, toggleFavorite methods remain same)

    /**
     * Get current program info string - cached for performance
     */
    getProgramInfo(channel) {
        try {
            if (!window.app || !window.app.epgGuide) return null;

            // Cache key: channel_id + current_minute (invalidate every minute)
            const currentMinute = Math.floor(Date.now() / 60000);
            const cacheKey = `${channel.tvgId || channel.name}:${currentMinute}`;

            if (this._programInfoCache && this._programInfoCache.has(cacheKey)) {
                return this._programInfoCache.get(cacheKey);
            }

            // Clear old cache entries if minute changed
            if (!this._lastCacheMinute || this._lastCacheMinute !== currentMinute) {
                this._programInfoCache = new Map();
                this._lastCacheMinute = currentMinute;
            }

            const program = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const result = program ? program.title : null;

            this._programInfoCache.set(cacheKey, result);
            return result;
        } catch (e) {
            console.warn("Error in getProgramInfo", e);
            return null;
        }
    }

    /**
     * Clear program info cache
     * Useful when EPG data has been updated
     */
    clearProgramInfoCache() {
        if (this._programInfoCache) {
            this._programInfoCache.clear();
        }
    }

    escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    /**
     * Render channel list
     */
    render() {
        const searchTerm = this.searchInput.value.toLowerCase();
        const showHidden = this.showHiddenCheckbox ? this.showHiddenCheckbox.checked : false;

        // Reset batching
        this.currentBatch = 0;
        this.batchSize = 100; // Number of groups to render per batch (increased to handle many hidden groups)
        this.container.innerHTML = ''; // Clear container

        // Filter and Group channels
        const groupedChannels = {};

        // 1. Filter
        this.filteredChannels = this.channels;
        if (searchTerm) {
            this.filteredChannels = this.channels.filter(ch =>
                String(ch.name ?? "").toLowerCase().includes(searchTerm) ||
                String(ch.groupTitle ?? "").toLowerCase().includes(searchTerm)
            );
        }

        let filteredChannels = this.filteredChannels;

        // 2. Group
        filteredChannels.forEach(ch => {
            const groupKey = ch.groupTitle || 'Uncategorized';
            if (!groupedChannels[groupKey]) {
                groupedChannels[groupKey] = [];
            }
            groupedChannels[groupKey].push(ch);
        });

        // 3. Add Favorites
        const favoritedChannels = this.channels.filter(ch => this.isFavorite(ch.sourceId, ch.id));
        if (favoritedChannels.length > 0) {
            favoritedChannels.sort((a, b) => a.name.localeCompare(b.name));
            groupedChannels['Favorites'] = favoritedChannels;
        }

        // 4. Sort Groups and filter to only those with visible channels
        const allGroups = Object.keys(groupedChannels).sort((a, b) => {
            if (a === 'Favorites') return -1;
            if (b === 'Favorites') return 1;
            return a.localeCompare(b);
        });

        // Pre-filter to only include groups with visible channels (so hidden groups don't consume batch slots)
        this.sortedGroups = allGroups.filter(groupName => {
            if (groupName === 'Favorites') return true;
            const channels = groupedChannels[groupName];
            // Check if any channel in this group is visible
            return channels.some(channel => {
                const rawChannelId = channel.streamId || channel.id;
                const isHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !isHidden || showHidden;
            });
        });

        this.groupedChannels = groupedChannels;
        this.showHidden = showHidden;

        // Collapse all groups by default on first load (for large playlists)
        // This prevents rendering 100K+ channel items on initial load
        if (!this._hasCollapsedState && this.sortedGroups.length > 0) {
            this.sortedGroups.forEach(groupName => {
                if (groupName !== 'Favorites') {
                    this.collapsedGroups.add(groupName);
                }
            });
            this._hasCollapsedState = true;
            this.saveCollapsedState();
        }

        // Build rendered channel list for navigation (matches visual order)
        this.renderedChannels = [];
        this.sortedGroups.forEach(groupName => {
            const channels = this.groupedChannels[groupName];
            const isFavoritesGroup = groupName === 'Favorites';

            const visibleChannels = channels.filter(channel => {
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !channelHidden || this.showHidden;
            });

            // Assign unique render IDs for linear navigation
            visibleChannels.forEach(ch => {
                // We clone the object for the rendered list to attach the unique ID
                // ensuring no side effects on the main channel object
                const renderedCh = {
                    ...ch,
                    _renderId: `rid_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    _renderGroup: groupName // Track visual group for navigation
                };
                this.renderedChannels.push(renderedCh);
            });
        });

        // Empty State
        if (this.sortedGroups.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <p>${searchTerm ? 'No channels match your search' : 'No channels loaded'}</p>
          <p class="hint">${searchTerm ? 'Try a different search term' : 'Add a source in Settings to get started'}</p>
        </div>
      `;
            return;
        }

        // Wrap container content in a specific list div to append to
        this.listContainer = document.createElement('div');
        this.listContainer.className = 'channel-list-content';
        this.container.appendChild(this.listContainer);

        // Add loader element at bottom
        this.loader = document.createElement('div');
        this.loader.className = 'batch-loader';
        this.loader.innerHTML = '<div class="loading-spinner"></div>';
        this.loader.style.opacity = '0'; // Hide initially
        this.container.appendChild(this.loader);

        // Render initial batches - load just enough to fill visible area + buffer
        // Reduced from 10 to 2 to significantly speed up initial load time for large lists
        const maxInitialBatches = 2;
        for (let i = 0; i < maxInitialBatches; i++) {
            if (this.currentBatch * this.batchSize >= this.sortedGroups.length) break;
            this.renderNextBatch();
        }

        // Start observing loader for additional batches
        this.observer.observe(this.loader);
    }

    /**
     * Render next batch of groups
     */
    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const groupsToRender = this.sortedGroups.slice(start, end);

        if (groupsToRender.length === 0) {
            // No more groups
            this.loader.style.display = 'none';
            return;
        }

        this.loader.style.opacity = '1';
        let html = '';

        let renderIndex = start; // Keep track of global index for mapping to renderedChannels

        for (const groupName of groupsToRender) {
            const channels = this.groupedChannels[groupName];
            if (channels.length === 0) continue;

            const isFavoritesGroup = groupName === 'Favorites';

            // Pre-filter visible channels for this group
            const visibleChannels = channels.filter(channel => {
                if (isFavoritesGroup) return true;
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
                return !channelHidden || this.showHidden;
            });

            // Skip group if no visible channels (derived visibility)
            if (visibleChannels.length === 0) continue;

            // Default new groups to collapsed (except Favorites)
            // This handles groups loaded via scroll that weren't in the initial collapse
            if (!isFavoritesGroup && !this.collapsedGroups.has(groupName) && !this._userExpandedGroups?.has(groupName)) {
                this.collapsedGroups.add(groupName);
            }

            html += `
        <div class="channel-group">
          <div class="group-header ${this.collapsedGroups.has(groupName) ? 'collapsed' : ''} ${isFavoritesGroup ? 'favorites-group' : ''}" data-group="${groupName}">
            <span class="group-toggle">${Icons.chevronDown}</span>
            <span class="group-name">${groupName}</span>
            <span class="group-count">${visibleChannels.length}</span>
          </div>
          <div class="group-channels">
      `;

            // Skip rendering channel items if group is collapsed (major performance optimization)
            // Channels will be rendered when user expands the group
            if (this.collapsedGroups.has(groupName)) {
                html += '</div></div>';
                continue;
            }


            for (const channel of visibleChannels) {
                // Check hidden again for styling (showHidden mode)
                const rawChannelId = channel.streamId || channel.id;
                const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);

                const isActive = this.currentChannel?.id === channel.id;
                // Check if this specific instance is the "active" one for navigation purposes
                const isRenderActive = this.currentRenderId && this.renderedChannels[renderIndex]?._renderId === this.currentRenderId;

                const isFavorite = this.isFavorite(channel.sourceId, channel.id);
                const renderId = this.renderedChannels[renderIndex]?._renderId || '';
                const renderGroup = this.renderedChannels[renderIndex]?._renderGroup || groupName;
                renderIndex++;

                html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${isRenderActive ? 'nav-active' : ''} ${channelHidden ? 'hidden' : ''}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
            }
            html += '</div></div>';
        }

        // Append to list container
        // Use temp div to parse HTML string
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;

        while (tempDiv.firstElementChild) {
            const groupEl = tempDiv.firstElementChild;
            this.attachGroupListeners(groupEl);
            this.listContainer.appendChild(groupEl);
        }

        this.currentBatch++;

        // Hide loader if we might be done (next batch check will confirm)
        if (end >= this.sortedGroups.length) {
            this.loader.style.display = 'none';
        }
    }

    attachGroupListeners(groupEl) {
        const header = groupEl.querySelector('.group-header');
        if (header) {
            header.addEventListener('click', () => {
                const groupName = header.dataset.group;
                const isCollapsed = header.classList.contains('collapsed');

                header.classList.toggle('collapsed');
                this.toggleGroup(groupName);

                // If expanding, render channels if they weren't rendered initially
                if (isCollapsed) {
                    const channelsContainer = groupEl.querySelector('.group-channels');
                    if (channelsContainer && channelsContainer.children.length === 0) {
                        // Channels weren't rendered - render them now
                        this.renderGroupChannels(groupName, channelsContainer);
                    }
                }
            });
            header.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'group', header.dataset));
        }

        groupEl.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Render channels for a specific group (called when expanding a collapsed group)
     */
    renderGroupChannels(groupName, container) {
        const channels = this.groupedChannels[groupName];
        if (!channels || channels.length === 0) return;

        const isFavoritesGroup = groupName === 'Favorites';

        // Filter visible channels
        const visibleChannels = channels.filter(channel => {
            if (isFavoritesGroup) return true;
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = this.isHidden('channel', channel.sourceId, rawChannelId);
            return !channelHidden || this.showHidden;
        });

        let html = '';
        for (const channel of visibleChannels) {
            const rawChannelId = channel.streamId || channel.id;
            const channelHidden = !isFavoritesGroup && this.isHidden('channel', channel.sourceId, rawChannelId);
            const isActive = this.currentChannel?.id === channel.id;
            const isFavorite = this.isFavorite(channel.sourceId, channel.id);

            // Find the matching rendered channel to get its unique IDs
            const renderedChannel = this.renderedChannels.find(rc =>
                rc.id === channel.id && rc.sourceId === channel.sourceId && rc._renderGroup === groupName
            );
            const renderId = renderedChannel?._renderId || '';
            const renderGroup = renderedChannel?._renderGroup || groupName;

            html += `
          <div class="channel-item ${isActive ? 'active' : ''} ${channelHidden ? 'hidden' : ''}" 
               data-channel-id="${channel.id}"
               data-source-id="${channel.sourceId}"
               data-source-type="${channel.sourceType}"
               data-stream-id="${channel.streamId || ''}"
               data-url="${channel.url || ''}"
               data-render-id="${renderId}"
               data-render-group="${renderGroup}">
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.escapeHtml(this.getProgramInfo(channel) || '')}</div>
            </div>
            <button class="favorite-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}">
              ${isFavorite ? Icons.favorite : Icons.favoriteOutline}
            </button>
          </div>
        `;
        }

        container.innerHTML = html;

        // Attach listeners to the new channel items
        container.querySelectorAll('.channel-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) return;
                this.selectChannel(item.dataset);
            });
            item.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', item.dataset));

            const favBtn = item.querySelector('.favorite-btn');
            if (favBtn) {
                favBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFavorite(parseInt(item.dataset.sourceId), item.dataset.channelId);
                });
            }
        });
    }

    /**
     * Load sources into dropdown
     */
    async loadSources() {
        try {
            this.sources = await API.sources.getAll();
            console.log('[ChannelList] loadSources: Got', this.sources?.length || 0, 'sources');
            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);

            if (xtreamSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'Xtream';
                xtreamSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `xtream:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }

            if (m3uSources.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = 'M3U';
                m3uSources.forEach(s => {
                    const option = document.createElement('option');
                    option.value = `m3u:${s.id}`;
                    option.textContent = s.name;
                    optgroup.appendChild(option);
                });
                this.sourceSelect.appendChild(optgroup);
            }
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Load channels from selected source
     */
    async loadChannels() {
        if (this.isLoading) return;
        this.isLoading = true;
        this.currentRenderId = null; // Reset render tracking

        const sourceValue = this.sourceSelect.value;
        const self = this;

        if (!sourceValue) {
            // Load from all sources
            await this.loadAllChannels();
            this.isLoading = false;
            return;
        }

        const [type, id] = sourceValue.split(':');

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            if (type === 'xtream') {
                await this.loadXtreamChannels(parseInt(id));
            } else if (type === 'm3u') {
                await this.loadM3uChannels(parseInt(id));
            }

            // Load hidden items and favorites
            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites()
            ]);

            this.render();
        } catch (err) {
            console.error('Error loading channels:', err);
            this.container.innerHTML = `<div class="empty-state"><p>Error loading channels</p><p class="hint">${err.message}</p></div>`;
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * Load channels from all enabled sources
     */
    async loadAllChannels() {
        this.channels = [];
        this.groups = [];

        try {
            this.container.innerHTML = '<div class="loading"></div>';

            const xtreamSources = this.sources.filter(s => s.type === 'xtream' && s.enabled);
            const m3uSources = this.sources.filter(s => s.type === 'm3u' && s.enabled);
            console.log('[ChannelList] loadAllChannels: xtream=', xtreamSources.length, 'm3u=', m3uSources.length);

            for (const source of xtreamSources) {
                await this.loadXtreamChannels(source.id, true);
            }

            for (const source of m3uSources) {
                await this.loadM3uChannels(source.id, true);
            }

            await Promise.all([
                this.loadHiddenItems(),
                this.loadFavorites()
            ]);
            this.render();
        } catch (err) {
            console.error('Error loading all channels:', err);
        }
    }

    /**
     * Load Xtream channels
     */
    async loadXtreamChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await API.proxy.xtream.liveStreams(sourceId);

        // Map categories to groups
        const categoryGroups = categories.map(cat => ({
            id: `xtream_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'xtream'
        }));

        this.groups = this.groups.concat(categoryGroups);

        // Map streams to channels
        const channelList = streams.map(stream => ({
            id: `xtream_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            groupId: `xtream_${sourceId}_${stream.category_id}`,
            // Use string comparison to handle type mismatches (number vs string category_id)
            groupTitle: categories.find(c => String(c.category_id) === String(stream.category_id))?.category_name || 'Uncategorized',
            sourceId,
            sourceType: 'xtream'
        }));

        this.channels = this.channels.concat(channelList);
    }

    /**
     * Load M3U channels
     * Now uses unified Xtream-style API endpoints (backend supports both source types)
     */
    async loadM3uChannels(sourceId, append = false) {
        if (!append) {
            this.channels = [];
            this.groups = [];
        }

        // Use Xtream API endpoints - backend now supports M3U sources too
        const categories = await API.proxy.xtream.liveCategories(sourceId);
        const streams = await API.proxy.xtream.liveStreams(sourceId);

        // Map categories to groups (keeping m3u sourceType for downstream compatibility)
        const m3uGroups = categories.map(cat => ({
            id: `m3u_${sourceId}_${cat.category_id}`,
            name: cat.category_name,
            sourceId,
            sourceType: 'm3u'
        }));

        this.groups = this.groups.concat(m3uGroups);

        // Map streams to channels
        const channelList = streams.map(stream => ({
            id: `m3u_${sourceId}_${stream.stream_id}`,
            streamId: stream.stream_id,
            name: stream.name,
            tvgId: stream.epg_channel_id,
            tvgLogo: stream.stream_icon,
            url: stream.stream_url, // M3U has direct URLs
            groupId: `m3u_${sourceId}_${stream.category_id}`,
            groupTitle: categories.find(c => String(c.category_id) === String(stream.category_id))?.category_name || 'Uncategorized',
            sourceId,
            sourceType: 'm3u'
        }));

        this.channels = this.channels.concat(channelList);
    }

    /**
     * Load hidden items
     */
    async loadHiddenItems() {
        try {
            const items = await API.channels.getHidden();
            this.hiddenItems = new Set(items.map(i => `${i.item_type}:${i.source_id}:${i.item_id}`));
        } catch (err) {
            console.error('Error loading hidden items:', err);
        }
    }

    /**
     * Check if item is hidden
     */
    isHidden(type, sourceId, itemId) {
        return this.hiddenItems.has(`${type}:${sourceId}:${itemId}`);
    }

    /**
     * Load favorites
     */
    async loadFavorites() {
        try {
            // Get all favorites (filtered for channels or legacy items without type)
            const allFavs = await API.favorites.getAll();
            const channelFavs = allFavs.filter(f => !f.item_type || f.item_type === 'channel');

            this.visibleFavorites = new Set(
                channelFavs.map(f => `${f.source_id}:${f.item_id || f.channel_id}`)
            );
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }

    /**
     * Check if channel is favorite
     */
    isFavorite(sourceId, channelId) {
        return this.visibleFavorites.has(`${sourceId}:${channelId}`);
    }

    /**
     * Toggle favorite status
     */
    async toggleFavorite(sourceId, channelId) {
        const key = `${sourceId}:${channelId}`;
        const wasFavorite = this.visibleFavorites.has(key);

        // Find all buttons for this channel in the DOM (it may appear in multiple groups)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        try {
            // Optimistic update
            if (wasFavorite) {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                    btn.title = 'Add to Favorites';
                });
            } else {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                    btn.title = 'Remove from Favorites';
                });
            }

            // Updates Favorites Group DOM
            const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
            if (channel) {
                this.updateFavoritesGroup(channel, !wasFavorite);
            }
            // Do NOT call this.render() - it causes lag

            // Perform API call
            if (wasFavorite) {
                await API.favorites.remove(sourceId, channelId, 'channel');
            } else {
                await API.favorites.add(sourceId, channelId, 'channel');
            }

            // Sync to EPG Guide
            if (window.app?.epgGuide) {
                window.app.epgGuide.syncFavorite(sourceId, channelId, !wasFavorite);
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (wasFavorite) {
                this.visibleFavorites.add(key);
                btns.forEach(btn => {
                    btn.classList.add('active');
                    btn.innerHTML = Icons.favorite;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, true);
            } else {
                this.visibleFavorites.delete(key);
                btns.forEach(btn => {
                    btn.classList.remove('active');
                    btn.innerHTML = Icons.favoriteOutline;
                });
                // Revert group update
                const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
                if (channel) this.updateFavoritesGroup(channel, false);
            }
        }
    }

    /**
     * Update Favorites group in DOM and data
     */
    updateFavoritesGroup(channel, isAdded) {
        // 1. Update Data
        if (!this.groupedChannels['Favorites']) {
            this.groupedChannels['Favorites'] = [];
        }

        const favArray = this.groupedChannels['Favorites'];
        const existingIdx = favArray.findIndex(c => c.id === channel.id && c.sourceId === channel.sourceId);

        if (isAdded) {
            if (existingIdx === -1) favArray.push(channel);
        } else {
            if (existingIdx !== -1) favArray.splice(existingIdx, 1);
        }

        // 2. Update DOM
        const groupHeader = this.listContainer.querySelector('.group-header[data-group="Favorites"]');

        if (!groupHeader) {
            // If group doesn't exist and we're adding, we ideally should create it
            // For now, simpler to just return. User will see it on next refresh.
            // Or we could force a re-render if it's the first favorite? 
            if (isAdded && favArray.length === 1) {
                this.render(); // This is the one case where full render is worth it
            }
            return;
        }

        const groupChannels = groupHeader.nextElementSibling; // .group-channels
        const countSpan = groupHeader.querySelector('.group-count');

        if (isAdded) {
            // Check if already in DOM (to avoid dupes)
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (!existingEl) {
                const newEl = this.createChannelElement(channel);
                groupChannels.appendChild(newEl);
            }
        } else {
            const existingEl = groupChannels.querySelector(`.channel-item[data-channel-id="${channel.id}"][data-source-id="${channel.sourceId}"]`);
            if (existingEl) {
                existingEl.remove();
            }
        }

        // Update count
        if (countSpan) countSpan.textContent = favArray.length;

        // Hide/Show group if empty?
        if (favArray.length === 0) {
            groupHeader.classList.add('hidden'); // Or remove
            groupHeader.style.display = 'none';
        } else {
            groupHeader.classList.remove('hidden');
            groupHeader.style.display = '';
        }
    }

    createChannelElement(channel) {
        const div = document.createElement('div');
        const isActive = this.currentChannel?.id === channel.id;
        // In Favorites group, it IS a favorite
        const isFavorite = true;

        div.className = `channel-item ${isActive ? 'active' : ''}`;
        div.dataset.channelId = channel.id;
        div.dataset.sourceId = channel.sourceId;
        div.dataset.sourceType = channel.sourceType;
        div.dataset.streamId = channel.streamId || '';
        div.dataset.url = channel.url || '';

        div.innerHTML = `
            <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                 alt="" onerror="this.onerror=null;this.src='/img/placeholder.png'">
            <div class="channel-info">
              <div class="channel-name">${this.escapeHtml(channel.name)}</div>
              <div class="channel-program">${this.getProgramInfo(channel) || ''}</div>
            </div>
            <button class="favorite-btn active" title="Remove from Favorites">
              ❤️
            </button>
        `;

        // Attach listeners
        div.addEventListener('click', (e) => {
            if (e.target.closest('.favorite-btn')) return;
            // Pass the render ID from the dataset
            this.selectChannel({ ...div.dataset, renderId: div.dataset.renderId });
        });
        div.addEventListener('contextmenu', (e) => this.showContextMenu(e, 'channel', div.dataset));

        const favBtn = div.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(parseInt(div.dataset.sourceId), div.dataset.channelId);
            });
        }

        return div;
    }

    /**
     * Select and play a channel
     */
    async selectChannel(dataset) {
        const channel = this.channels.find(c => c.id === dataset.channelId);
        if (!channel) return;

        this.currentChannel = channel;
        this.currentRenderId = dataset.renderId; // Track which visual instance is active
        this.currentRenderGroup = dataset.renderGroup; // Track which group the selection came from

        // Update active state in DOM
        this.container.querySelectorAll('.channel-item.active').forEach(el => {
            el.classList.remove('active');
            el.classList.remove('nav-active');
        });

        // Try to find specific render instance first
        let activeItem;
        activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);

        // If not found in DOM, it might be in a future batch not yet rendered
        // Render batches until we find it or run out
        if (!activeItem && this.renderedChannels.length > 0) {
            let safety = 0;
            while (!activeItem && this.currentBatch * this.batchSize < this.sortedGroups.length && safety < 20) {
                this.renderNextBatch();
                if (this.currentRenderId) {
                    activeItem = this.container.querySelector(`[data-render-id="${this.currentRenderId}"]`);
                }
                safety++;
            }
        }

        // Fallback checks if still not found
        if (!activeItem) {
            activeItem = this.container.querySelector(`[data-channel-id="${channel.id}"]`);
            // If we fell back to channel ID, update currentRenderId to match what we found
            if (activeItem && activeItem.dataset.renderId) {
                this.currentRenderId = activeItem.dataset.renderId;
            }
        }

        if (activeItem) {
            activeItem.classList.add('active');
            activeItem.classList.add('nav-active'); // Add specific class for navigation tracking

            // Handle Group Expansion & Scrolling (Focus Mode)
            const groupHeader = activeItem.closest('.channel-group')?.querySelector('.group-header');
            if (groupHeader) {
                const groupName = groupHeader.dataset.group;

                // 1. Expand current group if needed
                if (this.collapsedGroups.has(groupName)) {
                    this.collapsedGroups.delete(groupName);
                    // Update DOM directly for immediate feedback
                    groupHeader.classList.remove('collapsed');
                    this.saveCollapsedState();
                }

                // 2. Collapse ALL other groups (Focus Mode)
                document.querySelectorAll('.group-header').forEach(header => {
                    if (header !== groupHeader && !header.classList.contains('collapsed')) {
                        const otherGroup = header.dataset.group;
                        this.collapsedGroups.add(otherGroup);
                        header.classList.add('collapsed');
                    }
                });
                this.saveCollapsedState();

                // 3. Scroll Group to Top
                // Use a small timeout to allow layout updates (e.g. collapse animations) to start
                setTimeout(() => {
                    groupHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Ensure active item is visible within the group
                    setTimeout(() => {
                        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 50);
                }, 50);
            } else {
                // Fallback for non-grouped items or flat list
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // Get stream URL
        let streamUrl;
        if (channel.sourceType === 'xtream') {
            // Get stream format from player settings (server-side) or fallback
            const streamFormat = window.app?.player?.settings?.streamFormat || 'm3u8';
            const result = await API.proxy.xtream.getStreamUrl(channel.sourceId, channel.streamId, 'live', streamFormat);
            streamUrl = result.url;
        } else {
            streamUrl = channel.url;
        }

        // Play channel
        if (window.app?.player) {
            window.app.player.play(channel, streamUrl);
        }
    }

    /**
     * Show context menu
     */
    showContextMenu(e, type, data) {
        e.preventDefault();
        this.contextMenu.dataset.type = type;
        this.contextMenu.dataset.sourceId = data.sourceId;
        this.contextMenu.dataset.itemId = type === 'group' ? data.group : data.channelId;
        this.contextMenu.dataset.streamId = data.streamId || '';

        this.contextMenu.style.left = `${e.clientX}px`;
        this.contextMenu.style.top = `${e.clientY}px`;
        this.contextMenu.classList.add('active');
    }

    /**
     * Hide context menu
     */
    hideContextMenu() {
        this.contextMenu.classList.remove('active');
    }

    /**
     * Handle context menu action
     */
    async handleContextAction(e) {
        const action = e.target.dataset.action;
        const { type, sourceId, itemId, streamId } = this.contextMenu.dataset;

        switch (action) {
            case 'play':
                if (type === 'channel') {
                    const channel = this.channels.find(c => c.id === itemId);
                    if (channel) {
                        await this.selectChannel({ channelId: channel.id });
                    }
                }
                break;
            case 'hide':
                // Use streamId for hiding Xtream channels (raw ID, not composite)
                // Server expects 'channel' type, not 'live'
                const hideId = streamId || itemId;
                await API.channels.hide(parseInt(sourceId), 'channel', hideId);
                this.hiddenItems.add(`channel:${sourceId}:${hideId}`);
                this.render();
                break;
            case 'epg':
                // Show EPG info modal
                this.showEpgInfo(sourceId, itemId, streamId);
                break;
        }

        this.hideContextMenu();
    }

    /**
     * Show EPG info for a channel
     */
    showEpgInfo(sourceId, channelId, streamId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) {
            alert('Channel not found');
            return;
        }

        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modal-title');
        const modalBody = document.getElementById('modal-body');

        if (!modal || !modalTitle || !modalBody) return;

        modalTitle.textContent = `📋 ${channel.name} - EPG Info`;

        // Get current and upcoming programs
        let programsHtml = '<p class="no-programs">No EPG data available for this channel.</p>';

        if (window.app?.epgGuide) {
            const tvgKey = channel.tvgId || channel.name;
            const currentProgram = window.app.epgGuide.getCurrentProgram(channel.tvgId, channel.name);
            const programs = window.app.epgGuide.getChannelPrograms?.(tvgKey) || [];

            if (currentProgram || programs.length > 0) {
                programsHtml = '<div class="epg-program-list">';

                // Show current program
                if (currentProgram) {
                    const startTime = new Date(currentProgram.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(currentProgram.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program current">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">▶ ${this.escapeHtml(currentProgram.title)}</div>
                            ${currentProgram.description ? `<div class="epg-program-desc">${this.escapeHtml(currentProgram.description)}</div>` : ''}
                        </div>
                    `;
                }

                // Show upcoming programs (next 5)
                const now = Date.now();
                const upcoming = programs
                    .filter(p => new Date(p.start).getTime() > now)
                    .slice(0, 5);

                upcoming.forEach(prog => {
                    const startTime = new Date(prog.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const endTime = new Date(prog.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    programsHtml += `
                        <div class="epg-program">
                            <div class="epg-program-time">${startTime} - ${endTime}</div>
                            <div class="epg-program-title">${this.escapeHtml(prog.title)}</div>
                        </div>
                    `;
                });

                programsHtml += '</div>';
            }
        }

        modalBody.innerHTML = `
            <div class="epg-info-modal">
                <div class="channel-details">
                    <img class="channel-logo" src="${this.getProxiedImageUrl(channel.tvgLogo)}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" />
                    <div class="channel-meta">
                        <p><strong>Group:</strong> ${this.escapeHtml(channel.groupTitle || 'Uncategorized')}</p>
                        <p><strong>Source:</strong> ${channel.sourceType}</p>
                        ${channel.tvgId ? `<p><strong>TVG ID:</strong> ${this.escapeHtml(channel.tvgId)}</p>` : ''}
                    </div>
                </div>
                <h4>Program Schedule</h4>
                ${programsHtml}
            </div>
        `;

        modal.classList.add('active');
    }

    /**
     * Sync favorite status from external source (e.g. EPG) without API call
     */
    syncFavorite(sourceId, channelId, isFavorite) {
        const key = `${sourceId}:${channelId}`;
        const currentlyFav = this.visibleFavorites.has(key);

        if (currentlyFav === isFavorite) return; // No change needed

        // Update State
        if (isFavorite) {
            this.visibleFavorites.add(key);
        } else {
            this.visibleFavorites.delete(key);
        }

        // Update DOM (All instances)
        const btns = document.querySelectorAll(`.channel-item[data-channel-id="${channelId}"][data-source-id="${sourceId}"] .favorite-btn`);

        btns.forEach(btn => {
            if (isFavorite) {
                btn.classList.add('active');
                btn.innerHTML = '❤️';
                btn.title = 'Remove from Favorites';
            } else {
                btn.classList.remove('active');
                btn.innerHTML = '♡';
                btn.title = 'Add to Favorites';
            }
        });

        // Update Favorites Group
        const channel = this.channels.find(c => c.sourceId == sourceId && c.id == channelId);
        if (channel) {
            this.updateFavoritesGroup(channel, isFavorite);
        }
    }

    /**
     * Select next channel in the current list
     */
    selectNextChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        // Try to find by render ID first (strict visual order)
        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const nextIndex = (currentIndex + 1) % this.renderedChannels.length;
        const nextChannel = this.renderedChannels[nextIndex];

        this.selectChannel({
            channelId: nextChannel.id,
            sourceId: nextChannel.sourceId,
            sourceType: nextChannel.sourceType,
            streamId: nextChannel.streamId,
            url: nextChannel.url,
            renderId: nextChannel._renderId // Pass the unique render ID
        });
    }

    /**
     * Select previous channel in the current list
     */
    selectPrevChannel() {
        if (!this.currentChannel || !this.renderedChannels || this.renderedChannels.length === 0) return;

        let currentIndex = -1;

        if (this.currentRenderId) {
            currentIndex = this.renderedChannels.findIndex(c => c._renderId === this.currentRenderId);
        }

        // Fallback: Find matching channel ID, prioritizing same render group
        if (currentIndex === -1) {
            // First try to find in same group (for Favorites containing duplicates)
            if (this.currentRenderGroup) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId && c._renderGroup === this.currentRenderGroup
                );
            }
            // Final fallback: any matching channel
            if (currentIndex === -1) {
                currentIndex = this.renderedChannels.findIndex(c =>
                    c.id === this.currentChannel.id && c.sourceId === this.currentChannel.sourceId
                );
            }
        }

        if (currentIndex === -1) return;

        const prevIndex = (currentIndex - 1 + this.renderedChannels.length) % this.renderedChannels.length;
        const prevChannel = this.renderedChannels[prevIndex];

        this.selectChannel({
            channelId: prevChannel.id,
            sourceId: prevChannel.sourceId,
            sourceType: prevChannel.sourceType,
            streamId: prevChannel.streamId,
            url: prevChannel.url,
            renderId: prevChannel._renderId
        });
    }

    /**
     * Show EPG info for channel
     */
    async showEpgInfo(channelId) {
        const channel = this.channels.find(c => c.id === channelId);
        if (!channel) return;

        // This would show a modal with EPG info
        console.log('Show EPG for:', channel);
    }

    /**
     * Get list of visible (non-hidden) channels in display order
     */
    getVisibleChannels() {
        const showHidden = this.showHiddenCheckbox?.checked ?? false;
        return this.channels.filter(ch => {
            if (showHidden) return true;
            const channelHidden = this.isHidden('channel', ch.sourceId, ch.id);
            const groupHidden = this.isHidden('group', ch.sourceId, ch.groupTitle);
            return !channelHidden && !groupHidden;
        });
    }
}

// Export
window.ChannelList = ChannelList;
