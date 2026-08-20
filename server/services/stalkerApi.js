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

// Real STB clients handshake once at boot and reuse that token for hours across
// many channel changes. Re-authenticating on every single stream request looks
// like abuse to most portals/anti-fraud proxies and gets rate-limited/403'd, so
// we cache the session per (portal, mac) and only re-handshake when it's missing,
// expired, or a request comes back unauthorized.
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const sessionCache = new Map();

function sessionKey(baseUrl, mac) {
    return `${baseUrl.toLowerCase()}|${mac.toUpperCase()}`;
}

class StalkerApi {
    constructor(baseUrl, mac, portalPath = null) {
        // Clean up base URL
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.mac = mac;
        this.portalPath = portalPath || null;
        this.token = null;
        this.sessionKey = sessionKey(this.baseUrl, this.mac);
    }

    /**
     * Adopt a still-fresh cached session (token + portalPath) if one exists.
     */
    restoreSession() {
        const cached = sessionCache.get(this.sessionKey);
        if (!cached || cached.expiresAt < Date.now()) {
            return false;
        }
        this.token = cached.token;
        this.portalPath = cached.portalPath;
        return true;
    }

    saveSession() {
        sessionCache.set(this.sessionKey, {
            token: this.token,
            portalPath: this.portalPath,
            expiresAt: Date.now() + SESSION_TTL_MS
        });
    }

    invalidateSession() {
        sessionCache.delete(this.sessionKey);
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
     * Complete auth sequence: handshake + get_profile. Reuses a cached session
     * when available instead of re-authenticating with the portal.
     */
    async authenticate({ force = false } = {}) {
        if (!force && this.restoreSession()) {
            return { token: this.token, portalPath: this.portalPath, profile: null, cached: true };
        }
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
        this.saveSession();
        return { token: this.token, portalPath: this.portalPath, profile };
    }

    /**
     * Generic authenticated request. Reuses a cached session when possible and
     * transparently re-handshakes once if the portal rejects the token (e.g. it
     * was revoked server-side before our local TTL expired).
     */
    async request(type, action, params = {}, _retried = false) {
        if (!this.token || !this.portalPath) {
            if (!this.restoreSession()) {
                await this.handshake();
                this.saveSession();
            }
        }
        try {
            return await this.rawRequest(this.portalPath, { type, action, ...params });
        } catch (err) {
            if (!_retried && /Stalker portal HTTP (401|403)/.test(err.message)) {
                this.invalidateSession();
                await this.handshake();
                this.saveSession();
                return this.request(type, action, params, true);
            }
            throw err;
        }
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
        let js;
        try {
            js = await this.request('itv', 'create_link', {
                cmd,
                forced_storage: 'undefined',
                disable_ad: 0,
                JsHttpRequest: '1-xml'
            });
        } catch (err) {
            // Some portals hand out a `cmd` from get_all_channels that's already a
            // fully-resolved, playable URL (real host + mac + play_token) rather than
            // a "ffmpeg http://localhost/ch/..._" template. Their create_link handler
            // then rejects it as an invalid CMD since there's nothing left to resolve.
            // Fall back to using the original cmd directly in that case.
            if (/^ffmpeg\s+https?:\/\//i.test(cmd)) {
                return cmd.replace(/^ffmpeg\s+/i, '').trim();
            }
            throw err;
        }
        const resolved = js.cmd || cmd;
        // Portal often prefixes the resolved command with "ffmpeg "
        const url = resolved.replace(/^ffmpeg\s+/i, '').trim();

        // Some portals echo back an unresolved URL template (e.g.
        // ".../play/live.php?mac=...&stream=&extension=ts&play_token=...")
        // when the cmd we sent doesn't map to a valid channel/session. Feeding
        // that straight to ffmpeg just burns a transcode attempt on a
        // guaranteed 5xx from the origin, so fail fast with a clear reason.
        if (/[?&]stream=(&|$)/.test(url)) {
            throw new Error(`Stalker portal returned an unresolved stream URL (empty "stream" id) for cmd "${cmd}"`);
        }

        return url;
    }

    /**
     * Full flow: authenticate then resolve a channel cmd into a stream URL
     */
    async resolveStreamUrl(cmd) {
        await this.authenticate();
        return this.createLink(cmd);
    }

    /**
     * Full flow: authenticate, fetch a fresh copy of a channel's `cmd` straight
     * from the portal, and resolve it into a playable stream URL. Some portals
     * embed a short-lived play_token directly in `cmd`, so a value cached from a
     * prior sync can already be stale by playback time - real STB clients always
     * pull the channel list fresh right before playing, so we mirror that here.
     * Falls back to `fallbackCmd` (e.g. the last-synced DB value) if the live
     * channel list can't be fetched or no longer contains this channel.
     */
    async resolveChannelStreamUrl(channelId, fallbackCmd = null) {
        await this.authenticate();
        let cmd = fallbackCmd;
        try {
            const channels = await this.getAllChannels();
            const channel = channels.find(ch => String(ch.id) === String(channelId));
            if (channel && channel.cmd) {
                cmd = channel.cmd;
            }
        } catch (err) {
            if (!cmd) throw err;
        }
        if (!cmd) {
            throw new Error(`Channel ${channelId} not found on portal`);
        }
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
 * Static authenticate for testing a portal/mac combination. Always does a live
 * handshake (bypassing any cached session) since this backs the "test connection" UI.
 */
async function authenticate(url, mac) {
    const api = new StalkerApi(url, mac);
    const result = await api.authenticate({ force: true });
    return { ...result, portalPath: api.portalPath };
}

module.exports = { StalkerApi, createFromSource, authenticate };
