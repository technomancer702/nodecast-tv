/**
 * M3U Playlist Parser (Streaming)
 * Parses EXTM3U format playlists and extracts channel information line-by-line
 */

const readline = require('readline');
const { Readable } = require('stream');

/**
 * Generate a simple stable ID from name and group
 * @param {string} name - Channel name
 * @param {string} group - Group title
 * @returns {string} Stable ID
 */
function generateStableId(name, group) {
    const str = `${name || 'unknown'}:${group || 'unknown'}`;
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return `m3u_${Math.abs(hash).toString(36)}`;
}

/**
 * Parse EXTINF line and extract attributes
 * @param {string} line - EXTINF line
 * @returns {Object} Parsed channel info
 */
function parseExtinf(line) {
    const info = {
        duration: -1,
        tvgId: null,
        tvgName: null,
        tvgLogo: null,
        groupTitle: null,
        name: null
    };

    // Extract duration and rest
    const match = line.match(/#EXTINF:(-?\d+\.?\d*)\s*(.*)/);
    if (!match) return info;

    info.duration = parseFloat(match[1]);
    const rest = match[2];

    // Extract attributes using regex
    const attrPatterns = {
        tvgId: /tvg-id="([^"]*)"/i,
        tvgName: /tvg-name="([^"]*)"/i,
        tvgLogo: /tvg-logo="([^"]*)"/i,
        groupTitle: /group-title="([^"]*)"/i
    };

    for (const [key, pattern] of Object.entries(attrPatterns)) {
        const attrMatch = rest.match(pattern);
        if (attrMatch) {
            info[key] = attrMatch[1];
        }
    }

    // Extract channel name (after the comma)
    const commaIndex = rest.lastIndexOf(',');
    if (commaIndex !== -1) {
        info.name = rest.substring(commaIndex + 1).trim();
    } else {
        // Fallback: use tvg-name or the whole rest
        info.name = info.tvgName || rest.trim();
    }

    // Generate ID if not present
    if (!info.tvgId) {
        info.tvgId = info.name ? info.name.toLowerCase().replace(/\s+/g, '_') : `channel_${Date.now()}`;
    }

    return info;
}

/**
 * Parse M3U content (Stream or String)
 * @param {Readable|string} input - M3U content as Stream or String
 * @returns {Promise<{ channels: Array, groups: Array }>}
 */
async function parse(input) {
    const channels = [];
    const groupsSet = new Set();
    let currentInfo = null;
    let currentGroup = null;

    let inputStream;
    if (typeof input === 'string') {
        inputStream = Readable.from([input]);
    } else {
        inputStream = input;
    }

    const rl = readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('#EXTINF:')) {
            // Parse EXTINF line
            currentInfo = parseExtinf(trimmed);
            if (currentInfo.groupTitle) {
                groupsSet.add(currentInfo.groupTitle);
                currentGroup = currentInfo.groupTitle;
            }
        } else if (trimmed.startsWith('#EXTGRP:')) {
            // Parse EXTGRP line (alternative group specification)
            currentGroup = trimmed.substring(8).trim();
            groupsSet.add(currentGroup);
            if (currentInfo) {
                currentInfo.groupTitle = currentGroup;
            }
        } else if (!trimmed.startsWith('#')) {
            // This is a stream URL
            if (currentInfo) {
                const groupTitle = currentInfo.groupTitle || currentGroup || 'Uncategorized';
                // Generate a stable ID: use tvgId if present, otherwise hash name+group
                const stableId = currentInfo.tvgId || generateStableId(currentInfo.name, groupTitle);

                channels.push({
                    ...currentInfo,
                    id: stableId,
                    url: trimmed,
                    groupTitle: groupTitle
                });
                currentInfo = null;
            }
        }
    }

    // Convert groups to array of objects
    const groups = Array.from(groupsSet).map((name, index) => ({
        id: `group_${index}`,
        name,
        channelCount: channels.filter(c => c.groupTitle === name).length
    }));

    return { channels, groups };
}

/**
 * Fetch and parse M3U from URL
 * @param {string} url - M3U playlist URL
 * @returns {Promise<{ channels: Array, groups: Array }>}
 */
async function fetchAndParse(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
    }

    // Check if body is a Node.js stream (undici/node-fetch) or web stream
    let stream;
    if (response.body && typeof response.body.pipe === 'function') {
        stream = response.body;
    } else if (response.body) {
        // Convert Web Stream to Node Readable for readline
        stream = Readable.fromWeb(response.body);
    } else {
        // Fallback for empty body
        stream = Readable.from([]);
    }

    return parse(stream);
}

module.exports = { parse, parseExtinf, fetchAndParse };
