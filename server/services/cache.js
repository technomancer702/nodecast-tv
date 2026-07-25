/**
 * File-based Cache Service
 * Stores cached data as JSON files in data/cache/
 */

const fs = require('fs');
const path = require('path');

// Cache directory
const cacheDir = path.join(__dirname, '..', '..', 'data', 'cache');

const CACHE_TYPES = ['epg', 'm3u', 'xtream'];

/**
 * Resolve the directory for one source's cache of one type.
 * `sourceId` reaches here URL-decoded from a route param, so a value like
 * `../../..` would escape cacheDir and hand fs.rmSync an arbitrary directory.
 * Throw rather than clamp: a traversal attempt is never a legitimate call.
 */
function resolveSourceDir(type, sourceId) {
    if (!CACHE_TYPES.includes(type)) {
        throw new Error(`Unknown cache type: ${type}`);
    }

    const dir = path.resolve(cacheDir, type, String(sourceId));
    const root = path.resolve(cacheDir, type);

    if (dir !== root && !dir.startsWith(root + path.sep)) {
        throw new Error(`Invalid cache source id: ${sourceId}`);
    }

    return dir;
}

// Ensure cache directories exist
function ensureCacheDir(type, sourceId) {
    const dir = resolveSourceDir(type, sourceId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Get cache file path
function getCachePath(type, sourceId, key) {
    const dir = ensureCacheDir(type, sourceId);
    // Sanitize key for filename
    const safeKey = String(key || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safeKey}.json`);
}

/**
 * Get cached data if not expired
 * @param {string} type - Cache type (epg, m3u, xtream)
 * @param {number|string} sourceId - Source ID
 * @param {string} key - Cache key (e.g., action name)
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {any|null} - Cached data or null if expired/missing
 */
function get(type, sourceId, key, maxAgeMs) {
    try {
        const cachePath = getCachePath(type, sourceId, key);

        if (!fs.existsSync(cachePath)) {
            return null;
        }

        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const age = Date.now() - cached.timestamp;

        if (age > maxAgeMs) {
            return null; // Expired
        }

        return cached.data;
    } catch (err) {
        console.warn(`Cache read error for ${type}/${sourceId}/${key}:`, err.message);
        return null;
    }
}

/**
 * Store data in cache
 * @param {string} type - Cache type
 * @param {number|string} sourceId - Source ID
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function set(type, sourceId, key, data) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        const cached = {
            timestamp: Date.now(),
            data: data
        };
        fs.writeFileSync(cachePath, JSON.stringify(cached));
    } catch (err) {
        console.error(`Cache write error for ${type}/${sourceId}/${key}:`, err.message);
    }
}

/**
 * Clear specific cache entry
 */
function clear(type, sourceId, key) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
        }
    } catch (err) {
        console.warn(`Cache clear error:`, err.message);
    }
}

/**
 * Clear all cache for a source
 */
function clearSource(sourceId) {
    // Resolve every path first so a traversal attempt throws to the caller before
    // anything is deleted, rather than being swallowed after a partial wipe.
    const dirs = CACHE_TYPES.map(type => resolveSourceDir(type, sourceId));

    for (const dir of dirs) {
        try {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true });
            }
        } catch (err) {
            console.warn(`Cache clear source error:`, err.message);
        }
    }
}

/**
 * Clear all cache
 */
function clearAll() {
    try {
        if (fs.existsSync(cacheDir)) {
            fs.rmSync(cacheDir, { recursive: true });
        }
    } catch (err) {
        console.warn(`Cache clear all error:`, err.message);
    }
}

/**
 * Get cache info for debugging
 */
function getInfo(type, sourceId, key) {
    try {
        const cachePath = getCachePath(type, sourceId, key);
        if (!fs.existsSync(cachePath)) {
            return null;
        }
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        const stats = fs.statSync(cachePath);
        return {
            timestamp: cached.timestamp,
            age: Date.now() - cached.timestamp,
            size: stats.size
        };
    } catch (err) {
        return null;
    }
}

module.exports = {
    get,
    set,
    clear,
    clearSource,
    clearAll,
    getInfo
};
