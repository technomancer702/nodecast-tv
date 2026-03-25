/**
 * Xtream Codes API v2 Client
 * Handles authentication and API calls to Xtream servers
 */

const { normalizeSourceUrl } = require('./urlNormalizer');


class XtreamApi {
    constructor(baseUrl, username, password) {
        // Clean up base URL
                this.baseUrl = normalizeSourceUrl(baseUrl);
        this.username = username;
        this.password = password;
    }

    /**
     * Build API URL with authentication
     */
    buildApiUrl(action, params = {}) {
        const url = new URL(`${this.baseUrl}/player_api.php`);
        url.searchParams.set('username', this.username);
        url.searchParams.set('password', this.password);
        if (action) {
            url.searchParams.set('action', action);
        }
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }


    /**
     * Make API request
     */
    async request(action, params = {}) {
        const url = this.buildApiUrl(action, params);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Authenticate and get server/user info
     */
    async authenticate() {
        const data = await this.request(null);
        if (!data.user_info) {
            throw new Error('Invalid credentials or server response');
        }
        return data;
    }

    /**
     * Get live channel categories
     */
    async getLiveCategories() {
        return this.request('get_live_categories');
    }

    /**
     * Get live streams, optionally filtered by category
     */
    async getLiveStreams(categoryId = null) {
        return this.request('get_live_streams', { category_id: categoryId });
    }

    /**
     * Get VOD categories
     */
    async getVodCategories() {
        return this.request('get_vod_categories');
    }

    /**
     * Get VOD streams, optionally filtered by category
     */
    async getVodStreams(categoryId = null) {
        return this.request('get_vod_streams', { category_id: categoryId });
    }

    /**
     * Get VOD info
     */
    async getVodInfo(vodId) {
        return this.request('get_vod_info', { vod_id: vodId });
    }

    /**
     * Get series categories
     */
    async getSeriesCategories() {
        return this.request('get_series_categories');
    }

    /**
     * Get series, optionally filtered by category
     */
    async getSeries(categoryId = null) {
        return this.request('get_series', { category_id: categoryId });
    }

    /**
     * Get series info
     */
    async getSeriesInfo(seriesId) {
        return this.request('get_series_info', { series_id: seriesId });
    }

    /**
     * Get short EPG for a stream
     */
    async getShortEpg(streamId, limit = 10) {
        return this.request('get_short_epg', { stream_id: streamId, limit });
    }

    /**
     * Get full EPG for a stream
     */
    async getSimpleDateTable(streamId) {
        return this.request('get_simple_data_table', { stream_id: streamId });
    }

    /**
     * Build stream URL for playback
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        const typeMap = {
            live: 'live',
            vod: 'movie',
            series: 'series'
        };
        const streamType = typeMap[type] || 'live';
        return `${this.baseUrl}/${streamType}/${this.username}/${this.password}/${streamId}.${container}`;
    }

    /**
     * Get XMLTV EPG URL
     */
    getXmltvUrl() {
        return `${this.baseUrl}/xmltv.php?username=${this.username}&password=${this.password}`;
    }
}

/**
 * Factory function to create API instance from source
 */
function createFromSource(source) {
    return new XtreamApi(source.url, source.username, source.password);
}

/**
 * Static authenticate for testing
 */
async function authenticate(url, username, password) {
    const api = new XtreamApi(url, username, password);
    return api.authenticate();
}

module.exports = { XtreamApi, createFromSource, authenticate };
