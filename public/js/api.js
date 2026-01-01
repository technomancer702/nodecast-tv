/**
 * API Client - Frontend API wrapper for NodeCast TV
 */

const API = {
    /**
     * Make API request
     */
    async request(method, endpoint, data = null) {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        // Add authentication token if available
        const token = localStorage.getItem('authToken');
        if (token) {
            options.headers['Authorization'] = `Bearer ${token}`;
        }

        if (data) {
            options.body = JSON.stringify(data);
        }

        const response = await fetch(`/api${endpoint}`, options);

        let result;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            result = await response.json();
        } else {
            const text = await response.text();
            result = { error: text || 'API request failed' };
        }

        if (!response.ok) {
            // If unauthorized, redirect to login
            if (response.status === 401) {
                localStorage.removeItem('authToken');
                window.location.href = '/login.html';
                return;
            }
            throw new Error(result.error || `Server responded with ${response.status}`);
        }

        return result;
    },

    // Sources
    sources: {
        getAll: () => API.request('GET', '/sources'),
        getByType: (type) => API.request('GET', `/sources/type/${type}`),
        getById: (id) => API.request('GET', `/sources/${id}`),
        create: (data) => API.request('POST', '/sources', data),
        update: (id, data) => API.request('PUT', `/sources/${id}`, data),
        delete: (id) => API.request('DELETE', `/sources/${id}`),
        toggle: (id) => API.request('POST', `/sources/${id}/toggle`),
        test: (id) => API.request('POST', `/sources/${id}/test`)
    },

    // Channels (hidden items)
    channels: {
        getHidden: (sourceId = null) => API.request('GET', `/channels/hidden${sourceId ? `?sourceId=${sourceId}` : ''}`),
        hide: (sourceId, itemType, itemId) => API.request('POST', '/channels/hide', { sourceId, itemType, itemId }),
        show: (sourceId, itemType, itemId) => API.request('POST', '/channels/show', { sourceId, itemType, itemId }),
        isHidden: (sourceId, itemType, itemId) => API.request('GET', `/channels/hidden/check?sourceId=${sourceId}&itemType=${itemType}&itemId=${itemId}`),
        bulkHide: (items) => API.request('POST', '/channels/hide/bulk', { items }),
        bulkShow: (items) => API.request('POST', '/channels/show/bulk', { items })
    },

    // Favorites
    favorites: {
        getAll: (sourceId = null, itemType = null) => {
            let url = '/favorites';
            const params = [];
            if (sourceId) params.push(`sourceId=${sourceId}`);
            if (itemType) params.push(`itemType=${itemType}`);
            if (params.length) url += '?' + params.join('&');
            return API.request('GET', url);
        },
        add: (sourceId, itemId, itemType = 'channel') =>
            API.request('POST', '/favorites', { sourceId, itemId, itemType }),
        remove: (sourceId, itemId, itemType = 'channel') =>
            API.request('DELETE', '/favorites', { sourceId, itemId, itemType }),
        check: (sourceId, itemId, itemType = 'channel') =>
            API.request('GET', `/favorites/check?sourceId=${sourceId}&itemId=${itemId}&itemType=${itemType}`)
    },

    // Proxy
    proxy: {
        // Xtream
        xtream: {
            auth: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/auth`),
            liveCategories: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/live_categories`),
            liveStreams: (sourceId, categoryId = null) =>
                API.request('GET', `/proxy/xtream/${sourceId}/live_streams${categoryId ? `?category_id=${categoryId}` : ''}`),
            vodCategories: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/vod_categories`),
            vodStreams: (sourceId, categoryId = null) =>
                API.request('GET', `/proxy/xtream/${sourceId}/vod_streams${categoryId ? `?category_id=${categoryId}` : ''}`),
            seriesCategories: (sourceId) => API.request('GET', `/proxy/xtream/${sourceId}/series_categories`),
            series: (sourceId, categoryId = null) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series${categoryId ? `?category_id=${categoryId}` : ''}`),
            seriesInfo: (sourceId, seriesId) =>
                API.request('GET', `/proxy/xtream/${sourceId}/series_info?series_id=${seriesId}`),
            shortEpg: (sourceId, streamId) => API.request('GET', `/proxy/xtream/${sourceId}/short_epg?stream_id=${streamId}`),
            getStreamUrl: (sourceId, streamId, type = 'live', container = 'm3u8') =>
                API.request('GET', `/proxy/xtream/${sourceId}/stream/${streamId}/${type}?container=${container}`)
        },

        // M3U
        m3u: {
            get: (sourceId) => API.request('GET', `/proxy/m3u/${sourceId}`)
        },

        // EPG
        epg: {
            get: (sourceId) => API.request('GET', `/proxy/epg/${sourceId}`),
            getForChannels: (sourceId, channelIds) => API.request('POST', `/proxy/epg/${sourceId}/channels`, { channelIds })
        },

        // Cache management
        cache: {
            clear: (sourceId) => API.request('DELETE', `/proxy/cache/${sourceId}`)
        }
    },

    // Settings
    settings: {
        get: () => API.request('GET', '/settings'),
        update: (data) => API.request('PUT', '/settings', data),
        reset: () => API.request('DELETE', '/settings'),
        getDefaults: () => API.request('GET', '/settings/defaults')
    },

    // Users (admin only)
    users: {
        getAll: () => API.request('GET', '/auth/users'),
        create: (data) => API.request('POST', '/auth/users', data),
        update: (id, data) => API.request('PUT', `/auth/users/${id}`, data),
        delete: (id) => API.request('DELETE', `/auth/users/${id}`)
    }
};

// Make API available globally
window.API = API;
