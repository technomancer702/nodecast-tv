/**
 * M3U Xtream Adapter
 * 
 * Makes M3U sources respond to Xtream-style API methods.
 * Queries data from SQLite (already synced during source refresh).
 */

const { getDb } = require('../db/sqlite');

class M3uXtreamAdapter {
    constructor(sourceId) {
        this.sourceId = sourceId;
    }

    /**
     * Get categories (groups) for this M3U source by type.
     * Returns Xtream-compatible format: [{ category_id, category_name, parent_id }]
     */
    _getCategoriesByType(type, includeHidden = false) {
        const db = getDb();

        let query = `
            SELECT 
                category_id,
                category_id as category_name,
                NULL as parent_id,
                COUNT(*) as channel_count
            FROM playlist_items 
            WHERE source_id = ? AND type = ?
            ${!includeHidden ? 'AND is_hidden = 0' : ''}
            GROUP BY category_id
            ORDER BY category_id ASC
        `;

        const rows = db.prepare(query).all(this.sourceId, type);

        return rows.map(row => ({
            category_id: row.category_id || 'Uncategorized',
            category_name: row.category_id || 'Uncategorized',
            parent_id: null,
            channel_count: row.channel_count
        }));
    }

    /**
     * Get streams for this M3U source by type.
     * Returns Xtream-compatible format.
     */
    _getStreamsByType(type, categoryId = null, includeHidden = false, search = null) {
        const db = getDb();

        let query = `
            SELECT 
                item_id as stream_id,
                name,
                stream_icon,
                stream_url,
                category_id,
                added_at,
                container_extension,
                rating,
                year,
                data
            FROM playlist_items 
            WHERE source_id = ? AND type = ?
            ${!includeHidden ? 'AND is_hidden = 0' : ''}
        `;

        const params = [this.sourceId, type];

        if (categoryId) {
            query += ` AND category_id = ?`;
            params.push(categoryId);
        }

        if (search) {
            query += ` AND name LIKE ?`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY name ASC`;

        const rows = db.prepare(query).all(...params);

        return rows.map(row => {
            let extra = {};
            if (row.data) {
                try { extra = JSON.parse(row.data); } catch (e) { }
            }

            return {
                stream_id: row.stream_id,
                series_id: type === 'series' ? row.stream_id : undefined,
                name: row.name,
                stream_icon: row.stream_icon,
                cover: row.stream_icon,
                category_id: row.category_id,
                added: row.added_at,
                stream_url: row.stream_url,
                container_extension: row.container_extension || 'mp4',
                rating: row.rating,
                year: row.year,
                epg_channel_id: extra.tvgId || null,
                ...extra
            };
        });
    }

    /**
     * Live methods
     */
    getLiveCategories(includeHidden = false) {
        return this._getCategoriesByType('live', includeHidden);
    }

    getLiveStreams(categoryId = null, search = null, includeHidden = false) {
        return this._getStreamsByType('live', categoryId, includeHidden, search);
    }

    /**
     * VOD methods
     */
    getVodCategories(includeHidden = false) {
        return this._getCategoriesByType('movie', includeHidden);
    }

    getVodStreams(categoryId = null, search = null, includeHidden = false) {
        return this._getStreamsByType('movie', categoryId, includeHidden, search);
    }

    /**
     * Series methods
     */
    getSeriesCategories(includeHidden = false) {
        return this._getCategoriesByType('series', includeHidden);
    }

    getSeries(categoryId = null, search = null, includeHidden = false) {
        return this._getStreamsByType('series', categoryId, includeHidden, search);
    }

    /**
     * Get series info (for M3U, we treat it as a single season with the one stream)
     * Or if we want to be fancy, we could try to group episodes by name pattern.
     */
    getSeriesInfo(seriesId) {
        const db = getDb();
        const row = db.prepare(`
            SELECT * FROM playlist_items WHERE source_id = ? AND item_id = ? AND type = 'series'
        `).get(this.sourceId, seriesId);

        if (!row) return null;

        // Fetch episodes for this series
        const episodes = db.prepare(`
            SELECT * FROM playlist_items WHERE source_id = ? AND parent_id = ? AND type = 'episode'
        `).all(this.sourceId, seriesId);

        let extra = {};
        if (row.data) {
            try { extra = JSON.parse(row.data); } catch (e) { }
        }

        const seasonMap = {};

        if (episodes.length > 0) {
            episodes.forEach(ep => {
                let epData = {};
                try { epData = JSON.parse(ep.data); } catch (e) {}
                
                const seasonNum = String(epData.season_num || 1);
                if (!seasonMap[seasonNum]) seasonMap[seasonNum] = [];
                
                seasonMap[seasonNum].push({
                    id: ep.item_id,
                    episode_num: epData.episode_num || 0,
                    title: ep.name,
                    container_extension: ep.container_extension || 'mp4',
                    info: epData
                });
            });

            // Sort episodes in each season
            Object.keys(seasonMap).forEach(s => {
                seasonMap[s].sort((a, b) => a.episode_num - b.episode_num);
            });
        } else {
            // Fallback: If no episodes found (e.g. old sync or ungrouped), treat the series itself as one episode
            seasonMap["1"] = [{
                id: row.item_id,
                episode_num: 1,
                title: row.name,
                container_extension: row.container_extension || 'mp4',
                info: {}
            }];
        }

        return {
            info: {
                name: row.name,
                cover: row.stream_icon,
                plot: extra.plot || '',
                genre: extra.genre || '',
                releaseDate: row.year || '',
                rating: row.rating || ''
            },
            episodes: seasonMap
        };
    }

    /**
     * Build stream URL for playback.
     */
    buildStreamUrl(streamId, type = 'live', container = 'ts') {
        const db = getDb();

        const row = db.prepare(`
            SELECT stream_url FROM playlist_items 
            WHERE source_id = ? AND item_id = ?
        `).get(this.sourceId, streamId);

        return row?.stream_url || null;
    }

    /**
     * Get XMLTV EPG URL
     */
    getXmltvUrl() {
        return null;
    }
}

/**
 * Factory function to create adapter from source ID
 */
function createFromSourceId(sourceId) {
    return new M3uXtreamAdapter(sourceId);
}

module.exports = { M3uXtreamAdapter, createFromSourceId };
