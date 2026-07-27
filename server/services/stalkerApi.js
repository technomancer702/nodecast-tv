/**
 * Stalker/Ministra Portal API Client
 * Handles MAC-address based authentication and API calls to Stalker portals (MAG-style STB middleware)
 */

const crypto = require('crypto');

// Common load.php locations across different Stalker/Ministra portal deployments
const CANDIDATE_PATHS = [
    '/portal.php',
    '/stalker_portal/server/load.php',
    '/server/load.php',
    '/c/portal.php'
];

class StalkerApi {
    constructor(baseUrl, mac, portalPath = null) {
        // Clean up base URL
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.mac = mac;
        this.portalPath = portalPath || null;
        this.token = null;
    }

    /**
     * Deterministic device identifiers derived from the MAC address.
     * Most portals don't strictly validate these, but sending them improves compatibility.
     */
    deviceIds() {
        const hash = crypto.createHash('sha256').update(this.mac).digest('hex').toUpperCase();
        return {
            device_id: hash,
            device_id2: hash,
            sn: this.mac.replace(/:/g, '').slice(-13).toUpperCase()
        };
    }

    /**
     * Common headers required by Stalker portals
     */
    headers() {
        const h = {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'X-User-Agent': 'Model: MAG254; Link: WiFi',
            'Cookie': `mac=${this.mac}; stb_lang=en; timezone=Europe%2FLondon`,
            'Referer': `${this.baseUrl}/c/`,
            'Accept': '*/*'
        };
        if (this.token) {
            h['Authorization'] = `Bearer ${this.token}`;
        }
        return h;
    }

    buildUrl(path, params = {}) {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, value);
            }
        }
        return url.toString();
    }

    /**
     * Low level request against a specific portal path. Returns parsed js payload or throws.
     */
    async rawRequest(path, params) {
        const url = this.buildUrl(path, { JsHttpRequest: '1-xml', ...params });
        const response = await fetch(url, { headers: this.headers() });
        if (!response.ok) {
            throw new Error(`Stalker portal HTTP ${response.status} at ${path}`);
        }
        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error(`Stalker portal returned non-JSON response at ${path}`);
        }
        if (!data || typeof data.js === 'undefined') {
            throw new Error(`Stalker portal response missing 'js' payload at ${path}`);
        }
        return data.js;
    }

    /**
     * Handshake: obtain auth token. Auto-detects the working portal path if not already known.
     */
    async handshake() {
        const paths = this.portalPath ? [this.portalPath, ...CANDIDATE_PATHS.filter(p => p !== this.portalPath)] : CANDIDATE_PATHS;

        let lastError = null;
        for (const path of paths) {
            try {
                const js = await this.rawRequest(path, { type: 'stb', action: 'handshake', token: '' });
                if (js && js.token) {
                    this.portalPath = path;
                    this.token = js.token;
                    return js.token;
                }
            } catch (err) {
                lastError = err;
            }
        }
        throw new Error(`Stalker handshake failed: could not find a valid portal endpoint (${lastError ? lastError.message : 'no response'})`);
    }

    /**
     * Complete auth sequence: handshake + get_profile
     */
    async authenticate() {
        await this.handshake();
        const { device_id, device_id2, sn } = this.deviceIds();
        const profile = await this.rawRequest(this.portalPath, {
            type: 'stb',
            action: 'get_profile',
            hd: 1,
            ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Fri Jan 15 15:20:44 EET 2021; PORTAL version: 5.6.3; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
            num_banks: 2,
            sn,
            stb_type: 'MAG254',
            client_type: 'STB',
            image_version: 218,
            video_out: 'hdmi',
            device_id,
            device_id2,
            signature: '',
            auth_second_step: 1,
            hw_version: '1.7-BD-00',
            not_valid_token: 0,
            metrics: JSON.stringify({ mac: this.mac, sn }),
            hw_version_2: '',
            timestamp: Math.floor(Date.now() / 1000),
            api_signature: 262,
            prehash: ''
        });
        return { token: this.token, portalPath: this.portalPath, profile };
    }

    /**
     * Generic authenticated request (re-handshakes if no token yet)
     */
    async request(type, action, params = {}) {
        if (!this.token || !this.portalPath) {
            await this.handshake();
        }
        return this.rawRequest(this.portalPath, { type, action, ...params });
    }

    /**
     * Live TV genres (categories)
     */
    async getGenres() {
        const js = await this.request('itv', 'get_genres');
        return Array.isArray(js) ? js : (js.data || []);
    }

    /**
     * All live TV channels
     */
    async getAllChannels() {
        const js = await this.request('itv', 'get_all_channels');
        return js.data || [];
    }

    /**
     * Resolve a channel's `cmd` into a real, playable stream URL
     */
    async createLink(cmd) {
        const js = await this.request('itv', 'create_link', {
            cmd,
            forced_storage: 'undefined',
            disable_ad: 0,
            JsHttpRequest: '1-xml'
        });
        const resolved = js.cmd || cmd;
        // Portal often prefixes the resolved command with "ffmpeg "
        return resolved.replace(/^ffmpeg\s+/i, '').trim();
    }

    /**
     * Full flow: authenticate then resolve a channel cmd into a stream URL
     */
    async resolveStreamUrl(cmd) {
        await this.authenticate();
        return this.createLink(cmd);
    }
}

/**
 * Factory function to create API instance from a source record
 */
function createFromSource(source) {
    return new StalkerApi(source.url, source.mac, source.portalPath || null);
}

/**
 * Static authenticate for testing a portal/mac combination
 */
async function authenticate(url, mac) {
    const api = new StalkerApi(url, mac);
    const result = await api.authenticate();
    return { ...result, portalPath: api.portalPath };
}

module.exports = { StalkerApi, createFromSource, authenticate };
