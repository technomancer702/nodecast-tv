/**
 * Xtream Codes API v2 Client
 * Handles authentication and API calls to Xtream servers
 */

const DEFAULT_TIMEOUT_MS = 8000;
const preferredUrls = new Map();
const { fetchValidated } = require('./safeFetch');

function normalizeBaseUrls(primaryUrl, fallbackUrls = []) {
    const values = [primaryUrl];

    if (Array.isArray(fallbackUrls)) {
        values.push(...fallbackUrls);
    } else if (typeof fallbackUrls === 'string') {
        values.push(...fallbackUrls.split(/[\r\n,]+/));
    }

    return [...new Set(values
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim().replace(/\/+$/, '')))];
}

class XtreamApi {
    constructor(baseUrls, username, password, options = {}) {
        const urls = Array.isArray(baseUrls)
            ? normalizeBaseUrls(baseUrls[0], baseUrls.slice(1))
            : normalizeBaseUrls(baseUrls);

        if (urls.length === 0) {
            throw new Error('At least one Xtream server URL is required');
        }

        const preferredUrl = options.preferredUrl?.replace(/\/+$/, '');
        if (preferredUrl && urls.includes(preferredUrl)) {
            urls.splice(urls.indexOf(preferredUrl), 1);
            urls.unshift(preferredUrl);
        }

        this.baseUrls = urls;
        this.baseUrl = urls[0];
        this.username = username;
        this.password = password;
        this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        this.onSuccess = options.onSuccess;
        this.allowPrivate = options.allowPrivate;
    }

    /**
     * Build API URL with authentication
     */
    buildApiUrl(action, params = {}, baseUrl = this.baseUrl) {
        const url = new URL(`${baseUrl}/player_api.php`);
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
    async request(action, params = {}, validate = null) {
        const errors = [];

        for (const baseUrl of this.baseUrls) {
            const url = this.buildApiUrl(action, params, baseUrl);

            try {
                const response = await fetchValidated(url, {
                    signal: AbortSignal.timeout(this.timeoutMs),
                    preferHttps: true,
                    allowPrivate: this.allowPrivate
                });
                if (!response.ok) {
                    throw new Error(`${response.status} ${response.statusText}`);
                }

                const data = await response.json();
                if (validate && !validate(data)) {
                    throw new Error('Invalid credentials or server response');
                }

                this.baseUrl = baseUrl;
                this.onSuccess?.(baseUrl);
                return data;
            } catch (error) {
                errors.push(`${baseUrl}: ${error.message}`);
            }
        }

        throw new Error(`All Xtream DNS servers failed (${errors.join(' | ')})`);
    }

    /**
     * Authenticate and get server/user info
     */
    async authenticate() {
        return this.request(null, {}, data => Boolean(data?.user_info));
    }

    /**
     * Select the first responsive server before returning a direct stream URL.
     */
    async selectAvailable() {
        await this.authenticate();
        return this.baseUrl;
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
    const baseUrls = normalizeBaseUrls(source.url, source.fallbackUrls);
    const preferredUrl = preferredUrls.get(String(source.id));

    return new XtreamApi(baseUrls, source.username, source.password, {
        preferredUrl,
        onSuccess: (url) => preferredUrls.set(String(source.id), url)
    });
}

/**
 * Static authenticate for testing
 */
async function authenticate(url, username, password, fallbackUrls = []) {
    const api = new XtreamApi(normalizeBaseUrls(url, fallbackUrls), username, password);
    return api.authenticate();
}

function clearPreferred(sourceId) {
    preferredUrls.delete(String(sourceId));
}

module.exports = {
    XtreamApi,
    createFromSource,
    authenticate,
    normalizeBaseUrls,
    clearPreferred
};
