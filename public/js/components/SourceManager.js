/**
 * Source Manager Component
 * Handles adding, editing, and deleting sources (Xtream, M3U, EPG)
 */

class SourceManager {
    constructor() {
        this.xtreamList = document.getElementById('xtream-list');
        this.m3uList = document.getElementById('m3u-list');
        this.epgList = document.getElementById('epg-list');

        // Content browser state
        this.contentType = 'channels'; // 'channels' or 'movies'
        this.treeData = null; // { type, sourceId, groups: [{ id, name, categoryId, items: [] }] }
        this.hiddenSet = new Set(); // Set of hidden item keys (current state)
        this.originalHiddenSet = new Set(); // Set of hidden item keys (state when loaded)
        this.expandedGroups = new Set(); // Set of expanded group IDs
        this.searchQuery = ''; // Search filter for content browser

        this.init();
    }

    init() {
        // Add source buttons
        document.getElementById('add-xtream').addEventListener('click', () => this.showAddModal('xtream'));
        document.getElementById('add-m3u').addEventListener('click', () => this.showAddModal('m3u'));
        document.getElementById('add-epg').addEventListener('click', () => this.showAddModal('epg'));

        // Initialize content browser
        this.initContentBrowser();

        // Start polling sync status
        this.pollSyncStatus();
    }

    /**
     * Show a styled warning modal with Cancel/Proceed buttons
     * @param {Object} options - { title, message, details, proceedText, cancelText }
     * @returns {Promise<boolean>} - Resolves true if user clicks Proceed, false if Cancel
     */
    showWarningModal({ title, message, details = '', proceedText = 'Proceed', cancelText = 'Cancel' }) {
        return new Promise((resolve) => {
            const modal = document.getElementById('modal');
            const modalTitle = document.getElementById('modal-title');
            const modalBody = document.getElementById('modal-body');
            const modalFooter = document.getElementById('modal-footer');

            modalTitle.textContent = title;

            modalBody.innerHTML = `
                <div class="warning-modal-content">
                    <div class="warning-icon">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width: 48px; height: 48px; color: var(--color-warning, #f59e0b);">
                            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                        </svg>
                    </div>
                    <p class="warning-message" style="font-size: 1rem; margin: var(--space-md) 0; color: var(--color-text-primary);">${message}</p>
                    ${details ? `<p class="warning-details" style="font-size: 0.875rem; color: var(--color-text-muted); background: var(--color-bg-tertiary); padding: var(--space-md); border-radius: var(--radius-md); text-align: left;">${details}</p>` : ''}
                </div>
            `;

            modalFooter.innerHTML = `
                <button class="btn btn-secondary" id="warning-cancel">${cancelText}</button>
                <button class="btn btn-primary" id="warning-proceed" style="background: var(--color-warning, #f59e0b); border-color: var(--color-warning, #f59e0b);">${proceedText}</button>
            `;

            modal.classList.add('active');

            const cleanup = () => {
                modal.classList.remove('active');
                modal.querySelector('.modal-close').onclick = null;
            };

            document.getElementById('warning-cancel').onclick = () => {
                cleanup();
                resolve(false);
            };

            document.getElementById('warning-proceed').onclick = () => {
                cleanup();
                resolve(true);
            };

            modal.querySelector('.modal-close').onclick = () => {
                cleanup();
                resolve(false);
            };
        });
    }

    /**
     * Poll sync status from the backend
     */
    pollSyncStatus() {
        // Implement polling logic here
        console.log('Polling sync status...');
        // Example: setInterval(() => this.updateSyncStatus(), 5000);
    }

    /**
     * Update sync status display
     */
    updateSyncStatus() {
        // Implement logic to update UI based on sync status
        console.log('Updating sync status display...');
    }

    /**
     * Load and display all sources
     */
    async loadSources() {
        try {
            const sources = await API.sources.getAll();

            this.renderSourceList(this.xtreamList, sources.filter(s => s.type === 'xtream'), 'xtream');
            this.renderSourceList(this.m3uList, sources.filter(s => s.type === 'm3u'), 'm3u');
            this.renderSourceList(this.epgList, sources.filter(s => s.type === 'epg'), 'epg');
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    /**
     * Render source list
     */
    renderSourceList(container, sources, type) {
        if (sources.length === 0) {
            container.innerHTML = `<p class="hint">No ${type.toUpperCase()} sources configured</p>`;
            return;
        }

        const icons = { xtream: Icons.live, m3u: Icons.guide, epg: Icons.series };

        container.innerHTML = sources.map(source => `
      <div class="source-item ${source.enabled ? '' : 'disabled'}" data-id="${source.id}">
        <span class="source-icon">${icons[type]}</span>
        <div class="source-info">
          <div class="source-name">${source.name}</div>
          <div class="source-url">${source.url}</div>
        </div>
        <div class="source-actions">
          <button class="btn btn-sm btn-secondary" data-action="refresh" title="Refresh Data">${Icons.refresh}</button>
          <button class="btn btn-sm btn-secondary" data-action="test" title="Test Connection">${Icons.link}</button>
          <button class="btn btn-sm btn-secondary" data-action="toggle" title="${source.enabled ? 'Disable' : 'Enable'}">
            ${source.enabled ? Icons.check : Icons.circle}
          </button>
          <button class="btn btn-sm btn-secondary" data-action="edit" title="Edit">${Icons.settings}</button>
          <button class="btn btn-sm btn-danger" data-action="delete" title="Delete">${Icons.close}</button>
        </div>
      </div>
    `).join('');

        // Attach event listeners
        container.querySelectorAll('.source-item').forEach(item => {
            const id = parseInt(item.dataset.id);

            item.querySelector('[data-action="refresh"]').addEventListener('click', () => this.refreshSource(id, type));
            item.querySelector('[data-action="test"]').addEventListener('click', () => this.testSource(id));
            item.querySelector('[data-action="toggle"]').addEventListener('click', () => this.toggleSource(id));
            item.querySelector('[data-action="edit"]').addEventListener('click', () => this.showEditModal(id, type));
            item.querySelector('[data-action="delete"]').addEventListener('click', () => this.deleteSource(id));
        });
    }

    /**
     * Show add source modal
     */
    showAddModal(type) {
        const modal = document.getElementById('modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        const footer = document.getElementById('modal-footer');

        const titles = { xtream: 'Add Xtream Connection', m3u: 'Add M3U Playlist', epg: 'Add EPG Source' };
        title.textContent = titles[type];

        body.innerHTML = this.getSourceForm(type);

        footer.innerHTML = `
      <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
      <button class="btn btn-primary" id="modal-save">Add Source</button>
    `;

        modal.classList.add('active');

        // Event listeners
        modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-save').onclick = () => this.saveNewSource(type);
    }

    /**
     * Show edit source modal
     */
    async showEditModal(id, type) {
        try {
            const source = await API.sources.getById(id);

            const modal = document.getElementById('modal');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');
            const footer = document.getElementById('modal-footer');

            title.textContent = `Edit ${type.toUpperCase()} Source`;
            body.innerHTML = this.getSourceForm(type, source);

            footer.innerHTML = `
        <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save Changes</button>
      `;

            modal.classList.add('active');

            modal.querySelector('.modal-close').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
            document.getElementById('modal-save').onclick = () => this.updateSource(id, type);
        } catch (err) {
            console.error('Error loading source:', err);
        }
    }

    /**
     * Get source form HTML
     */
    getSourceForm(type, source = {}) {
        const nameField = `
      <div class="form-group">
        <label for="source-name">Name</label>
        <input type="text" id="source-name" class="form-input" placeholder="My Source" value="${source.name || ''}">
      </div>
    `;

        const urlField = `
      <div class="form-group">
        <label for="source-url">${type === 'xtream' ? 'Server URL' : 'URL'}</label>
        <input type="text" id="source-url" class="form-input" 
               placeholder="${type === 'xtream' ? 'http://server.com:port' : 'https://example.com/playlist.m3u'}" 
               value="${source.url || ''}">
      </div>
    `;

        if (type === 'xtream') {
            return `
        ${nameField}
        ${urlField}
        <div class="form-group">
          <label for="source-username">Username</label>
          <input type="text" id="source-username" class="form-input" value="${source.username || ''}">
        </div>
        <div class="form-group">
          <label for="source-password">Password</label>
          <input type="password" id="source-password" class="form-input" 
                 value="${source.password && !source.password.includes('•') ? source.password : ''}">
        </div>
      `;
        }

        const enigmaOptions = type === 'm3u' ? `
        <div class="form-group">
            <label class="checkbox-label">
            <input type="checkbox" id="source-zap-before-streaming" ${source.zapBeforeStreaming ? 'checked' : ''}>
            Zap before streaming (Enigma2/OpenWebif)
            </label>
        </div>

        <div class="form-group">
            <label for="source-zap-delay">Zap delay (ms)</label>
            <input type="number" id="source-zap-delay" class="form-input"
                value="${source.zapDelay || 1500}" min="0" step="100">
        </div>
        ` : '';

        return nameField + urlField + enigmaOptions;
    }

    /**
     * Save new source
     */
    async saveNewSource(type) {
        const name = document.getElementById('source-name').value.trim();
        const url = document.getElementById('source-url').value.trim();
        const username = document.getElementById('source-username')?.value.trim() || null;
        const password = document.getElementById('source-password')?.value.trim() || null;
        const zapBeforeStreaming = document.getElementById('source-zap-before-streaming')?.checked || false;
        const zapDelay = parseInt(document.getElementById('source-zap-delay')?.value) || 1500;

        if (!name || !url) {
            alert('Name and URL are required');
            return;
        }

        try {
            // Check M3U size before creating (large playlist warning)
            if (type === 'm3u') {
                try {
                    const estimate = await API.sources.estimateByUrl(url, type);
                    if (estimate.needsWarning) {
                        const proceed = await this.showWarningModal({
                            title: '⚠️ Large Playlist Warning',
                            message: `This playlist contains <strong>${estimate.count.toLocaleString()}</strong> channels.`,
                            details: `Syncing may take several minutes and app performance may be impacted with large playlists.<br><br>Consider using a filtered M3U from your provider to include only channels you actually watch.`,
                            proceedText: 'Proceed Anyway',
                            cancelText: 'Cancel'
                        });
                        if (!proceed) {
                            return; // Don't create the source
                        }
                    }
                } catch (err) {
                    console.warn('[SourceManager] Could not estimate M3U size:', err.message);
                    // Continue with creation anyway
                }
            }

            await API.sources.create({ type, name, url, username, password, zapBeforeStreaming, zapDelay });
            document.getElementById('modal').classList.remove('active');
            await this.loadSources();

            // Refresh channel list
            if (window.app?.channelList) {
                await window.app.channelList.loadSources();
                await window.app.channelList.loadChannels();
            }
        } catch (err) {
            alert('Error adding source: ' + err.message);
        }
    }

    /**
     * Update existing source
     */
    async updateSource(id, type) {
        const name = document.getElementById('source-name').value.trim();
        const url = document.getElementById('source-url').value.trim();
        const username = document.getElementById('source-username')?.value.trim();
        const password = document.getElementById('source-password')?.value.trim();

        if (!name || !url) {
            alert('Name and URL are required');
            return;
        }
        console.log("[updateSource] type:",type);
        try {
            const data = { name, url };
            if (type === 'xtream') {
                data.username = username;
                if (password) data.password = password;
            }
            if (type === 'm3u') {
                data.zapBeforeStreaming = document.getElementById('source-zap-before-streaming')?.checked || false;
                data.zapDelay = parseInt(document.getElementById('source-zap-delay')?.value) || 1500;
            }
            await API.sources.update(id, data);
            document.getElementById('modal').classList.remove('active');
            await this.loadSources();
        } catch (err) {
            alert('Error updating source: ' + err.message);
        }
    }

    /**
     * Delete source
     */
    async deleteSource(id) {
        if (!confirm('Are you sure you want to delete this source?')) return;

        try {
            await API.sources.delete(id);
            await this.loadSources();

            if (window.app?.channelList) {
                await window.app.channelList.loadSources();
                await window.app.channelList.loadChannels();
            }
        } catch (err) {
            alert('Error deleting source: ' + err.message);
        }
    }

    /**
     * Toggle source enabled/disabled
     */
    async toggleSource(id) {
        try {
            await API.sources.toggle(id);
            await this.loadSources();
        } catch (err) {
            alert('Error toggling source: ' + err.message);
        }
    }

    /**
     * Test source connection
     */
    async testSource(id) {
        try {
            const result = await API.sources.test(id);
            if (result.success) {
                alert('Connection successful!');
            } else {
                alert('Connection failed: ' + (result.error || result.message));
            }
        } catch (err) {
            alert('Connection failed: ' + err.message);
        }
    }

    /**
     * Refresh source data
     */
    async refreshSource(id, type) {
        try {
            const btn = document.querySelector(`.source-item[data-id="${id}"] [data-action="refresh"]`);
            if (btn) {
                btn.disabled = true;
                const icon = btn.querySelector('.icon');
                if (icon) icon.classList.add('spin');
            }

            // Check M3U size before syncing (large playlist warning)
            if (type === 'm3u') {
                try {
                    const estimate = await API.sources.estimate(id);
                    if (estimate.needsWarning) {
                        const proceed = await this.showWarningModal({
                            title: '⚠️ Large Playlist Warning',
                            message: `This playlist contains <strong>${estimate.count.toLocaleString()}</strong> channels.`,
                            details: `Syncing may take several minutes and app performance may be impacted with large playlists.<br><br>Consider using a filtered M3U from your provider to include only channels you actually watch.`,
                            proceedText: 'Proceed Anyway',
                            cancelText: 'Cancel'
                        });
                        if (!proceed) {
                            // Reset button state
                            if (btn) {
                                btn.disabled = false;
                                const icon = btn.querySelector('.icon');
                                if (icon) icon.classList.remove('spin');
                            }
                            return;
                        }
                    }
                } catch (err) {
                    console.warn('[SourceManager] Could not estimate M3U size:', err.message);
                    // Continue with sync anyway
                }
            }

            // 1. Trigger Backend Sync
            console.log(`[SourceManager] Triggering sync for source ${id}`);
            await API.sources.sync(id);

            // 2. Poll for completion
            let retries = 0;
            const maxRetries = 60; // 60 seconds timeout

            while (retries < maxRetries) {
                await new Promise(r => setTimeout(r, 1000)); // Wait 1s
                const statuses = await API.sources.getStatus();
                const status = statuses.find(s => s.source_id === id && s.type === 'all');

                if (status && status.status === 'success') {
                    console.log('[SourceManager] Sync completed successfully');
                    break;
                } else if (status && status.status === 'error') {
                    throw new Error(`Sync failed: ${status.error}`);
                }

                // If no status found yet, or still syncing, continue
                retries++;
            }

            if (retries >= maxRetries) {
                throw new Error('Sync timed out');
            }

            // 3. Refresh UI / Cache
            // Clear cache for this source first
            await API.proxy.cache.clear(id);

            if (type === 'epg') {
                // Force refresh EPG data
                if (window.app?.epgGuide) {
                    await window.app.epgGuide.loadEpg(true);
                }
                alert('EPG data synced & refreshed!');
            } else if (type === 'xtream') {
                // Re-fetch xtream data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                alert('Xtream data synced & refreshed!');
            } else if (type === 'm3u') {
                // Re-fetch M3U data by reloading channels
                if (window.app?.channelList) {
                    await window.app.channelList.loadChannels();
                }
                alert('M3U playlist synced & refreshed!');
            }

            if (btn) {
                btn.disabled = false;
                const icon = btn.querySelector('.icon');
                if (icon) icon.classList.remove('spin');
            }
        } catch (err) {
            console.error('Error refreshing source:', err);
            alert('Refresh failed: ' + err.message);
        }
    }

    /**
     * Initialize content browser
     */
    initContentBrowser() {
        this.contentSourceSelect = document.getElementById('content-source-select');
        this.contentTree = document.getElementById('content-tree');
        this.channelsBtn = document.getElementById('content-type-channels');
        this.moviesBtn = document.getElementById('content-type-movies');
        this.seriesBtn = document.getElementById('content-type-series');

        // Content type toggle
        this.channelsBtn?.addEventListener('click', () => {
            this.contentType = 'channels';
            this.channelsBtn.classList.add('active');
            this.moviesBtn?.classList.remove('active');
            this.seriesBtn?.classList.remove('active');
            this.reloadContentTree();
        });

        this.moviesBtn?.addEventListener('click', () => {
            this.contentType = 'movies';
            this.moviesBtn.classList.add('active');
            this.channelsBtn?.classList.remove('active');
            this.seriesBtn?.classList.remove('active');
            this.reloadContentTree();
        });

        this.seriesBtn?.addEventListener('click', () => {
            this.contentType = 'series';
            this.seriesBtn.classList.add('active');
            this.channelsBtn?.classList.remove('active');
            this.moviesBtn?.classList.remove('active');
            this.reloadContentTree();
        });

        // Source selection
        this.contentSourceSelect?.addEventListener('change', () => this.reloadContentTree());

        // Show All / Hide All buttons
        document.getElementById('content-show-all')?.addEventListener('click', () => this.setAllVisibility(true));
        document.getElementById('content-hide-all')?.addEventListener('click', () => this.setAllVisibility(false));

        // Save Changes button
        document.getElementById('content-save')?.addEventListener('click', () => this.saveContentChanges());

        // Search input
        const searchInput = document.getElementById('content-search');
        const searchClear = searchInput?.parentElement?.querySelector('.search-clear');

        searchInput?.addEventListener('input', (e) => {
            this.searchQuery = e.target.value.toLowerCase().trim();
            this.renderTree();
        });

        searchClear?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
                this.searchQuery = '';
                this.renderTree();
            }
        });
    }

    /**
     * Reload content tree based on current type and source
     */
    reloadContentTree() {
        const sourceId = this.contentSourceSelect?.value;
        if (!sourceId) {
            const typeLabel = this.contentType === 'movies' ? 'movie categories' :
                this.contentType === 'series' ? 'series categories' : 'groups and channels';
            this.contentTree.innerHTML = `<p class="hint">Select a source to view ${typeLabel}</p>`;
            return;
        }

        if (this.contentType === 'movies') {
            this.loadMovieCategoriesTree(parseInt(sourceId));
        } else if (this.contentType === 'series') {
            this.loadSeriesCategoriesTree(parseInt(sourceId));
        } else {
            this.loadContentTree(parseInt(sourceId));
        }
    }

    /**
     * Load sources into content browser dropdown
     */
    async loadContentSources() {
        try {
            const sources = await API.sources.getAll();
            const select = document.getElementById('content-source-select');
            if (!select) return;

            // Keep the placeholder option
            select.innerHTML = '<option value="">Select a source...</option>';

            sources.filter(s => s.type === 'xtream' || s.type === 'm3u').forEach(source => {
                select.innerHTML += `<option value="${source.id}">${source.name} (${source.type})</option>`;
            });
        } catch (err) {
            console.error('Error loading content sources:', err);
        }
    }

    /**
     * Load content tree for a source
     * Checked = Visible, Unchecked = Hidden
     */


    /**
     * Load content tree for a source
     */
    async loadContentTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading...</p>';
        this.treeData = { type: 'channels', sourceId, groups: [] };
        this.expandedGroups.clear();

        try {
            const source = await API.sources.getById(sourceId);
            let channels = [];

            let categoryMap = {};

            if (source.type === 'xtream' || source.type === 'm3u') {
                // Use unified Xtream API endpoints - backend supports both source types
                // Use includeHidden to show ALL items in the content manager
                const categories = await API.proxy.xtream.liveCategories(sourceId, { includeHidden: true });
                const streams = await API.proxy.xtream.liveStreams(sourceId, null, { includeHidden: true });

                channels = streams;
                categories.forEach(cat => {
                    categoryMap[cat.category_id] = cat.category_name;
                });
            }

            // Get currently hidden items
            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state for diffing

            // Group channels by category
            const groupMap = {}; // key: categoryId, value: { name, categoryId, items }
            channels.forEach(ch => {
                let groupName = 'Uncategorized';
                let categoryId = ch.category_id;

                // Look up category name from map (works for both Xtream and M3U now)
                if (categoryId && categoryMap[categoryId]) {
                    groupName = categoryMap[categoryId];
                } else if (categoryId) {
                    // M3U uses category_id as the name itself
                    groupName = categoryId;
                }

                const groupKey = categoryId || groupName;
                if (!groupMap[groupKey]) {
                    groupMap[groupKey] = {
                        categoryId: categoryId,
                        name: groupName,
                        items: []
                    };
                }

                // Normalize channel object
                const channelId = ch.stream_id || ch.id || ch.url;
                const channelName = ch.name || ch.tvgName || 'Unknown';

                groupMap[groupKey].items.push({
                    id: String(channelId),
                    name: channelName,
                    original: ch,
                    type: 'channel'
                });
            });

            // Convert to array, sorted by name
            this.treeData.groups = Object.entries(groupMap)
                .sort((a, b) => a[1].name.localeCompare(b[1].name))
                .map(([key, group]) => ({
                    id: key, // Use categoryId as the group ID
                    name: group.name,
                    categoryId: group.categoryId, // Store actual category_id for API calls
                    type: 'group',
                    items: group.items
                }));

            this.renderTree();

        } catch (err) {
            console.error('Error loading content tree:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading content</p>';
        }
    }

    /**
     * Get groups filtered by search query
     */
    getFilteredGroups() {
        if (!this.treeData?.groups) return [];
        if (!this.searchQuery) return this.treeData.groups;

        return this.treeData.groups
            .map(group => {
                // Check if group name matches
                const groupMatches = group.name.toLowerCase().includes(this.searchQuery);

                // Filter items that match
                const matchingItems = group.items.filter(item =>
                    item.name.toLowerCase().includes(this.searchQuery)
                );

                // Include group if name matches OR has matching items
                if (groupMatches || matchingItems.length > 0) {
                    return { ...group, items: groupMatches ? group.items : matchingItems };
                }
                return null;
            })
            .filter(Boolean);
    }

    /**
     * Render the full tree based on current state
     */
    renderTree() {
        const groups = this.getFilteredGroups();

        if (!groups.length) {
            const msg = this.searchQuery ? 'No matches found' : 'No content found';
            this.contentTree.innerHTML = `<p class="hint">${msg}</p>`;
            return;
        }

        const html = groups.map(group => this.getGroupHtml(group)).join('');
        this.contentTree.innerHTML = html;

        // Attach event listeners
        this.attachTreeListeners(this.contentTree);
    }

    /**
     * Get HTML for a group (and its items if expanded)
     */
    getGroupHtml(group) {
        const isExpanded = this.expandedGroups.has(group.id);

        // Group checkbox is checked if ANY child is visible (derived state)
        const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));
        const checked = hasVisibleChild;

        let itemsHtml = '';
        if (isExpanded) {
            itemsHtml = `<div class="content-channels">
                ${group.items.map(item => {
                const itemHidden = this.hiddenSet.has(`${item.type}:${item.id}`);
                return `
                    <label class="checkbox-label channel-item" title="${this.escapeHtml(item.name)}">
                        <input type="checkbox" class="channel-checkbox" 
                               data-type="${item.type}" 
                               data-id="${item.id}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${!itemHidden ? 'checked' : ''}>
                        <span class="channel-name">${this.escapeHtml(item.name)}</span>
                    </label>`;
            }).join('')}
            </div>`;
        }

        return `
            <div class="content-group ${isExpanded ? '' : 'collapsed'}" data-group-id="${this.escapeHtml(group.id)}">
                <div class="content-group-header">
                    <span class="group-expander">${Icons.chevronDown}</span>
                    <label class="checkbox-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="group-checkbox" 
                               data-type="group" 
                               data-id="${this.escapeHtml(group.name)}" 
                               data-source-id="${this.treeData.sourceId}" 
                               ${checked ? 'checked' : ''}>
                        <span class="group-name">${this.escapeHtml(group.name)} (${group.items.length})</span>
                    </label>
                </div>
                ${itemsHtml}
            </div>
        `;
    }

    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    attachTreeListeners(container) {
        // Toggle group collapse
        container.querySelectorAll('.content-group-header').forEach(header => {
            header.addEventListener('click', (e) => {
                // Prevent triggering if clicking the checkbox/label directly (handled by its own listener/bubbling)
                if (e.target.closest('input') || e.target.closest('label')) return;

                const groupEl = header.closest('.content-group');
                const groupId = groupEl.dataset.groupId;
                this.toggleGroupExpand(groupId);
            });
        });

        // Toggle visibility
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                if (cb.classList.contains('group-checkbox')) {
                    this.toggleGroupChildren(cb);
                } else {
                    this.toggleVisibility(cb);
                }
            });
        });
    }

    toggleGroupExpand(groupId) {
        if (this.expandedGroups.has(groupId)) {
            this.expandedGroups.delete(groupId);
        } else {
            this.expandedGroups.add(groupId);
        }

        // Re-render only this group - use filtered groups to respect search
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
        if (groupEl) {
            const filteredGroups = this.getFilteredGroups();
            const group = filteredGroups.find(g => g.id === groupId);
            if (group) {
                const newHtml = this.getGroupHtml(group);
                groupEl.outerHTML = newHtml;

                // Re-attach listeners to the new element
                const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(groupId)}"]`);
                if (newEl) this.attachTreeListeners(newEl);
            }
        }
    }

    /**
     * Load movie categories tree for a source
     */
    async loadMovieCategoriesTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading movie categories...</p>';
        this.treeData = { type: 'movies', sourceId, groups: [] };

        try {
            const source = await API.sources.getById(sourceId);

            if (source.type !== 'xtream') {
                this.contentTree.innerHTML = '<p class="hint">Movie categories are only available for Xtream sources</p>';
                return;
            }

            const categories = await API.proxy.xtream.vodCategories(sourceId, { includeHidden: true });

            if (!categories || categories.length === 0) {
                this.contentTree.innerHTML = '<p class="hint">No movie categories found</p>';
                return;
            }

            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state

            // Create a single "Movies" group or flatten?
            // The original UI rendered a flat list of categories. 
            // Better to stick to "Group -> Items" structure, or just wrap them in a pseudo-group?
            // Original: rendered checkboxes directly.
            // Let's adopt the treeData structure but with a single root group or flat items?
            // To support generic renderTree, we can put them in a "Categories" group or just render them as items.
            // Let's update renderTree to support flat list if groups is empty? 
            // Or just put them in one "All Categories" group that is auto-expanded.

            this.treeData.groups = [{
                id: 'all_categories',
                name: 'Categories',
                type: 'group',
                items: categories.sort((a, b) => a.category_name.localeCompare(b.category_name)).map(cat => ({
                    id: String(cat.category_id),
                    name: cat.category_name,
                    type: 'vod_category',
                    original: cat
                }))
            }];

            // Auto expand
            this.expandedGroups.add('all_categories');
            this.renderTree();

        } catch (err) {
            console.error('Error loading movie categories:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading movie categories</p>';
        }
    }

    /**
     * Load series categories tree for a source
     */
    async loadSeriesCategoriesTree(sourceId) {
        this.contentTree.innerHTML = '<p class="hint">Loading series categories...</p>';
        this.treeData = { type: 'series', sourceId, groups: [] };

        try {
            const source = await API.sources.getById(sourceId);

            if (source.type !== 'xtream') {
                this.contentTree.innerHTML = '<p class="hint">Series categories are only available for Xtream sources</p>';
                return;
            }

            const categories = await API.proxy.xtream.seriesCategories(sourceId, { includeHidden: true });

            if (!categories || categories.length === 0) {
                this.contentTree.innerHTML = '<p class="hint">No series categories found</p>';
                return;
            }

            const hiddenItems = await API.channels.getHidden(sourceId);
            this.hiddenSet = new Set(hiddenItems.map(h => `${h.item_type}:${h.item_id}`));
            this.originalHiddenSet = new Set(this.hiddenSet); // Track original state

            this.treeData.groups = [{
                id: 'all_series_categories',
                name: 'Categories',
                type: 'group',
                items: categories.sort((a, b) => a.category_name.localeCompare(b.category_name)).map(cat => ({
                    id: String(cat.category_id),
                    name: cat.category_name,
                    type: 'series_category',
                    original: cat
                }))
            }];

            this.expandedGroups.add('all_series_categories');
            this.renderTree();

        } catch (err) {
            console.error('Error loading series categories:', err);
            this.contentTree.innerHTML = '<p class="hint" style="color: var(--color-error);">Error loading series categories</p>';
        }
    }

    /**
     * Toggle visibility of a single item (LOCAL STATE ONLY - use Save to persist)
     * Checked = show (remove from hidden), Unchecked = hide (add to hidden)
     */
    toggleVisibility(checkbox) {
        const itemType = checkbox.dataset.type;
        const itemId = checkbox.dataset.id;
        const isVisible = checkbox.checked;

        // Update local state only (will be persisted when Save is clicked)
        const key = `${itemType}:${itemId}`;
        if (isVisible) {
            this.hiddenSet.delete(key);
        } else {
            this.hiddenSet.add(key);
        }

        // Update parent group checkbox to reflect derived state
        const groupEl = checkbox.closest('.content-group');
        if (groupEl) {
            const groupCheckbox = groupEl.querySelector('.group-checkbox');
            if (groupCheckbox) {
                const groupId = groupEl.dataset.groupId;
                const group = this.treeData.groups.find(g => g.id === groupId);
                if (group) {
                    const hasVisibleChild = group.items.some(item => !this.hiddenSet.has(`${item.type}:${item.id}`));
                    groupCheckbox.checked = hasVisibleChild;
                }
            }
        }
    }

    /**
     * Toggle all children of a group (LOCAL STATE ONLY - use Save to persist)
     */
    toggleGroupChildren(groupCb) {
        const groupName = groupCb.dataset.id;
        const group = this.treeData.groups.find(g => g.name === groupName);
        if (!group) return;

        const isChecked = groupCb.checked;

        // Determine the correct item type for the group based on content type
        let groupItemType = 'group'; // default for live channels
        if (this.treeData.type === 'movies') {
            groupItemType = 'vod_category';
        } else if (this.treeData.type === 'series') {
            groupItemType = 'series_category';
        }

        // Update state for the GROUP itself (if it has a categoryId)
        if (group.categoryId) {
            const groupKey = `${groupItemType}:${group.categoryId}`;
            if (isChecked) {
                this.hiddenSet.delete(groupKey);
            } else {
                this.hiddenSet.add(groupKey);
            }
        }

        // Update state for all children
        group.items.forEach(item => {
            const key = `${item.type}:${item.id}`;
            if (isChecked) {
                this.hiddenSet.delete(key);
            } else {
                this.hiddenSet.add(key);
            }
        });

        // Re-render group to update all checkboxes
        const groupEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
        if (groupEl) {
            groupEl.outerHTML = this.getGroupHtml(group);
            const newEl = this.contentTree.querySelector(`.content-group[data-group-id="${CSS.escape(group.id)}"]`);
            if (newEl) this.attachTreeListeners(newEl);
        }
    }

    /**
     * Set visibility for all items and IMMEDIATELY persist to server
     * Uses fast bulk API endpoint (single SQL statement) instead of item-by-item
     */
    async setAllVisibility(visible) {
        if (!this.treeData || !this.treeData.groups) return;

        const saveBtn = document.getElementById('content-save');
        const showAllBtn = document.querySelector('.content-actions button:first-child');
        const hideAllBtn = document.querySelector('.content-actions button:nth-child(2)');

        // Disable buttons during operation
        if (showAllBtn) showAllBtn.disabled = true;
        if (hideAllBtn) hideAllBtn.disabled = true;
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = visible ? '⏳ Showing all...' : '⏳ Hiding all...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const contentType = this.treeData.type; // 'channels', 'movies', or 'series'

            // Use fast API endpoint (single SQL UPDATE statement)
            if (visible) {
                await API.channels.showAll(sourceId, contentType);
            } else {
                await API.channels.hideAll(sourceId, contentType);
            }

            // Update local state to match
            this.treeData.groups.forEach(group => {
                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    if (visible) {
                        this.hiddenSet.delete(key);
                    } else {
                        this.hiddenSet.add(key);
                    }
                });
            });

            // Update originalHiddenSet to match current state
            this.originalHiddenSet = new Set(this.hiddenSet);

            // Sync Channel List
            try {
                if (window.app?.channelList?.loadHiddenItems) {
                    await window.app.channelList.loadHiddenItems();
                    window.app.channelList.render();
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            // Re-render to reflect changes
            this.renderTree();

            if (saveBtn) {
                saveBtn.textContent = '✓ Done!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save Changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error setting all visibility:', err);
            alert('Failed: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save Changes';
                saveBtn.disabled = false;
            }
        } finally {
            if (showAllBtn) showAllBtn.disabled = false;
            if (hideAllBtn) hideAllBtn.disabled = false;
        }
    }

    /**
     * Save all content visibility changes to the server
     */
    async saveContentChanges() {
        if (!this.treeData) {
            alert('No content loaded to save');
            return;
        }

        const saveBtn = document.getElementById('content-save');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = '⏳ Saving...';
        }

        try {
            const sourceId = this.treeData.sourceId;
            const itemsToShow = [];
            const itemsToHide = [];

            // Only collect items that have CHANGED from their original state
            // Track group changes for redundancy check
            const changedGroups = new Map(); // categoryId -> isHidden

            // First pass: Identify all changed groups
            this.treeData.groups.forEach(group => {
                let groupItemType = 'group';
                if (this.treeData.type === 'movies') groupItemType = 'vod_category';
                else if (this.treeData.type === 'series') groupItemType = 'series_category';

                if (group.categoryId) {
                    const groupKey = `${groupItemType}:${group.categoryId}`;
                    const isGroupNowHidden = this.hiddenSet.has(groupKey);
                    const wasGroupHidden = this.originalHiddenSet.has(groupKey);

                    if (isGroupNowHidden !== wasGroupHidden) {
                        changedGroups.set(group.categoryId, isGroupNowHidden);
                        if (isGroupNowHidden) {
                            itemsToHide.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        } else {
                            itemsToShow.push({ sourceId, itemType: groupItemType, itemId: String(group.categoryId) });
                        }
                    }
                }
            });

            // Second pass: Process items, skipping if redundant with group change
            this.treeData.groups.forEach(group => {
                const groupIsChanging = changedGroups.has(group.categoryId);
                const groupNewState = changedGroups.get(group.categoryId); // true = hiding, false = showing

                group.items.forEach(item => {
                    const key = `${item.type}:${item.id}`;
                    const isNowHidden = this.hiddenSet.has(key);
                    const wasHidden = this.originalHiddenSet.has(key);

                    // Only send if state changed
                    if (isNowHidden !== wasHidden) {
                        // Check for redundancy:
                        // If group is changing to the SAME state as the item, skip the item
                        // The backend cascade will handle it.
                        if (groupIsChanging && groupNewState === isNowHidden) {
                            return;
                        }

                        if (isNowHidden) {
                            itemsToHide.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        } else {
                            itemsToShow.push({ sourceId, itemType: item.type, itemId: String(item.id) });
                        }
                    }
                });
            });

            // Check if there are any changes
            if (itemsToShow.length === 0 && itemsToHide.length === 0) {
                if (saveBtn) {
                    saveBtn.textContent = 'No changes';
                    setTimeout(() => {
                        saveBtn.textContent = '💾 Save Changes';
                        saveBtn.disabled = false;
                    }, 1500);
                }
                return;
            }

            console.log(`[SourceManager] Saving changes: ${itemsToShow.length} to show, ${itemsToHide.length} to hide`);

            if (itemsToHide.length > 0) {
                console.log('[SourceManager] Items to hide:', itemsToHide.map(i => `${i.itemType}:${i.itemId}`));
                // Check if any groups are being hidden
                const hiddenGroups = itemsToHide.filter(i => i.itemType === 'group' || i.itemType.includes('category'));
                if (hiddenGroups.length > 0) {
                    console.warn('[SourceManager] WARNING: Hiding groups:', hiddenGroups);
                }
            }

            // Batch large operations to avoid timeouts (5000 items per batch)
            const BATCH_SIZE = 5000;

            const processBatches = async (items, apiFn, label) => {
                for (let i = 0; i < items.length; i += BATCH_SIZE) {
                    const batch = items.slice(i, i + BATCH_SIZE);
                    console.log(`[SourceManager] ${label}: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(items.length / BATCH_SIZE)} (${batch.length} items)`);
                    await apiFn(batch);

                    // Update button with progress
                    if (saveBtn) {
                        const progress = Math.round(((i + batch.length) / items.length) * 100);
                        saveBtn.textContent = `⏳ ${progress}%`;
                    }
                }
            };

            // Process show and hide operations sequentially to avoid overwhelming the server
            if (itemsToShow.length > 0) {
                await processBatches(itemsToShow, API.channels.bulkShow, 'Showing');
            }
            if (itemsToHide.length > 0) {
                await processBatches(itemsToHide, API.channels.bulkHide, 'Hiding');
            }

            console.log('[SourceManager] Bulk operations completed');

            // Update originalHiddenSet to reflect saved state
            this.originalHiddenSet = new Set(this.hiddenSet);

            // Sync Channel List (don't block on this)
            try {
                if (window.app?.channelList) {
                    // Start with hidden items sync which is fast
                    if (window.app.channelList.loadHiddenItems) {
                        await window.app.channelList.loadHiddenItems();
                    }

                    // If we modified the currently active source, reload it fully to get fresh categories
                    if (window.app.channelList.currentSourceId &&
                        String(window.app.channelList.currentSourceId) === String(this.contentSourceSelect.value)) {
                        console.log('[SourceManager] Reloading active source in ChannelList...');
                        await window.app.channelList.loadSource(window.app.channelList.currentSourceId);
                    } else {
                        // Otherwise just render to reflect hidden item changes
                        window.app.channelList.render();
                    }
                }
            } catch (e) {
                console.warn('[SourceManager] Channel list sync failed:', e);
            }

            if (saveBtn) {
                saveBtn.textContent = '✓ Saved!';
                setTimeout(() => {
                    saveBtn.textContent = '💾 Save Changes';
                    saveBtn.disabled = false;
                }, 1500);
            }

        } catch (err) {
            console.error('Error saving content changes:', err);
            alert('Failed to save changes: ' + err.message);
            if (saveBtn) {
                saveBtn.textContent = '💾 Save Changes';
                saveBtn.disabled = false;
            }
        }
    }

    /**
     * Poll sync status periodically
     */
    async pollSyncStatus() {
        const poll = async () => {
            try {
                const statuses = await API.sources.getStatus();
                this.updateSyncStatus(statuses);
            } catch (err) {
                console.warn('Error polling sync status:', err);
            }
            // Poll every 3 seconds
            this.syncPollTimeout = setTimeout(poll, 3000);
        };
        poll();
    }

    /**
     * Update UI with sync status
     */
    updateSyncStatus(statuses) {
        if (!statuses || !Array.isArray(statuses)) return;

        // Reset all to normal state if not in status list (handled implicitly by iterating sources or statuses?)
        // Better: iterate visible source items and check against statuses

        document.querySelectorAll('.source-item').forEach(item => {
            const id = parseInt(item.dataset.id);
            const status = statuses.find(s => s.source_id === id); // We might have multiple statuses (live, vod, epg) for one source

            // Just check if ANY sync is active/failed for this source
            const sourceStatuses = statuses.filter(s => s.source_id === id);
            const isSyncing = sourceStatuses.some(s => s.status === 'syncing');
            const hasError = sourceStatuses.some(s => s.status === 'error');
            const lastSync = sourceStatuses.map(s => s.last_sync).sort().pop();

            const btn = item.querySelector('[data-action="refresh"]');
            if (btn) {
                const icon = btn.querySelector('.icon') || btn; // icon inside button or button content
                // If syncing, spin the refresh icon
                if (isSyncing) {
                    btn.disabled = true;
                    btn.classList.add('syncing'); // Custom style?
                    // Ensure spin class is added (font awesome or similar)
                    // The icon is usually SVH in `Icons.refresh`.
                    // We can add a class to the SVG parent or button
                    btn.innerHTML = `<span class="spin">${Icons.refresh}</span>`;
                    btn.title = "Syncing...";
                } else if (hasError) {
                    btn.disabled = false;
                    btn.innerHTML = Icons.refresh;
                    btn.classList.remove('syncing');
                    btn.title = "Sync Failed - Retry";
                    // Maybe show error indicator?
                } else {
                    btn.disabled = false;
                    btn.innerHTML = Icons.refresh;
                    btn.classList.remove('syncing');
                    btn.title = lastSync ? `Last Sync: ${new Date(lastSync).toLocaleString()}` : "Refresh Data";
                }
            }

            // Optional: Update status text/badge in .source-info
        });
    }
}

// Export
window.SourceManager = SourceManager;
