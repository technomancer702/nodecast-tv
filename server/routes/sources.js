const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const { getDb } = require('../db/sqlite');
const xtreamApi = require('../services/xtreamApi');
const syncService = require('../services/syncService');
const m3uParser = require('../services/m3uParser');
const { requireAuth, requireAdmin } = require('../auth');
const { validateExternalUrl } = require('../services/externalUrl');
const { fetchValidated } = require('../services/safeFetch');

router.use(requireAuth);

function sanitizeSource(source) {
    if (!source) return source;
    const { password, ...safe } = source;
    return { ...safe, hasPassword: Boolean(password) };
}

async function validateSourceUrls(primaryUrl, fallbackUrls = []) {
    const normalized = xtreamApi.normalizeBaseUrls(primaryUrl, fallbackUrls);
    await Promise.all(normalized.map(value => validateExternalUrl(value)));
    return normalized;
}

// Get all sources
router.get('/', async (req, res) => {
    try {
        const allSources = await sources.getAll();
        res.json(allSources.map(sanitizeSource));
    } catch (err) {
        console.error('Error getting sources:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get sync status for all sources
router.get('/status', async (req, res) => {
    try {
        const { getDb } = require('../db/sqlite');
        const db = getDb();
        const statuses = db.prepare('SELECT * FROM sync_status').all();
        res.json(statuses);
    } catch (err) {
        console.error('Error getting sync status:', err);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type);
        res.json(typeSources.map(sanitizeSource));
    } catch (err) {
        console.error('Error getting sources by type:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get single source
router.get('/:id', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }
        res.json(sanitizeSource(source));
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { type, name, url, username, password, fallbackUrls } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        const sourceData = { type, name, url, username, password };
        if (type === 'xtream') {
            const normalized = await validateSourceUrls(url, fallbackUrls);
            sourceData.url = normalized[0];
            sourceData.fallbackUrls = normalized.slice(1);
        } else {
            sourceData.url = (await validateExternalUrl(url)).href;
        }

        const source = await sources.create(sourceData);
        // Trigger Sync
        syncService.syncSource(source.id).catch(console.error);
        res.status(201).json(sanitizeSource(source));
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(400).json({ error: err.message || 'Failed to create source' });
    }
});

// Update source
router.put('/:id', requireAdmin, async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const { name, url, username, password, fallbackUrls } = req.body;
        const updates = {
            name: name || existing.name,
            url: url || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password
        };

        if (existing.type === 'xtream') {
            const normalized = await validateSourceUrls(
                updates.url,
                fallbackUrls !== undefined ? fallbackUrls : existing.fallbackUrls
            );
            updates.url = normalized[0];
            updates.fallbackUrls = normalized.slice(1);
            xtreamApi.clearPreferred(req.params.id);
        } else {
            updates.url = (await validateExternalUrl(updates.url)).href;
        }

        const updated = await sources.update(req.params.id, updates);
        // Trigger Sync (if critical fields changed? safely just trigger it)
        syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        res.json(sanitizeSource(updated));
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(400).json({ error: err.message || 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const sourceId = parseInt(req.params.id);
        const existing = await sources.getById(sourceId);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Cascade delete: Clean up SQLite data for this source
        const db = getDb();
        const deleteCategories = db.prepare('DELETE FROM categories WHERE source_id = ?');
        const deleteItems = db.prepare('DELETE FROM playlist_items WHERE source_id = ?');
        const deleteEpg = db.prepare('DELETE FROM epg_programs WHERE source_id = ?');
        const deleteSyncStatus = db.prepare('DELETE FROM sync_status WHERE source_id = ?');

        const catResult = deleteCategories.run(sourceId);
        const itemResult = deleteItems.run(sourceId);
        const epgResult = deleteEpg.run(sourceId);
        deleteSyncStatus.run(sourceId);

        console.log(`[Source] Cascade delete for source ${sourceId}: ${catResult.changes} categories, ${itemResult.changes} items, ${epgResult.changes} EPG programs`);

        // Delete source config and related hidden items (favorites handled by db.js)
        await sources.delete(sourceId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', requireAdmin, async (req, res) => {
    try {
        const updated = await sources.toggleEnabled(req.params.id);
        if (!updated) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // If enabled, trigger sync
        if (updated.enabled) {
            syncService.syncSource(parseInt(req.params.id)).catch(console.error);
        }

        res.json(sanitizeSource(updated));
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

// Manual Sync
router.post('/:id/sync', requireAdmin, async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const source = await sources.getById(id);
        if (!source) return res.status(404).json({ error: 'Source not found' });

        // Trigger sync (async)
        syncService.syncSource(id).catch(console.error);

        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        console.error('Error starting sync:', err);
        res.status(500).json({ error: 'Failed to start sync' });
    }
});

// Test source connection
router.post('/:id/test', requireAdmin, async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.type === 'xtream') {
            const api = xtreamApi.createFromSource(source);
            const result = await api.authenticate();
            res.json({ success: true, activeUrl: api.baseUrl, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetchValidated(source.url, { preferHttps: true });
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetchValidated(source.url, { preferHttps: true });
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

// Estimate M3U playlist size (for large playlist warning)
const M3U_LARGE_THRESHOLD = 50000;

// Estimate by URL (for new sources before creation)
router.post('/estimate', requireAdmin, async (req, res) => {
    try {
        const { url, type } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Only M3U sources need estimation
        if (type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for URL...`);
        const count = await m3uParser.countEntries(url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Estimate by source ID (for existing sources)
router.get('/:id/estimate', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        // Only M3U sources need estimation
        if (source.type !== 'm3u') {
            return res.json({ count: 0, needsWarning: false, threshold: M3U_LARGE_THRESHOLD });
        }

        console.log(`[Sources] Estimating M3U size for ${source.name}...`);
        const count = await m3uParser.countEntries(source.url);
        console.log(`[Sources] M3U estimate: ${count} entries`);

        res.json({
            count,
            needsWarning: count > M3U_LARGE_THRESHOLD,
            threshold: M3U_LARGE_THRESHOLD
        });
    } catch (err) {
        console.error('Error estimating M3U size:', err);
        res.status(500).json({ error: 'Failed to estimate playlist size', message: err.message });
    }
});

// Global Sync - sync all enabled sources
router.post('/sync-all', requireAdmin, async (req, res) => {
    try {
        // Trigger global sync (async - don't wait for completion)
        syncService.syncAll().catch(console.error);
        res.json({ success: true, message: 'Global sync started' });
    } catch (err) {
        console.error('Error starting global sync:', err);
        res.status(500).json({ error: 'Failed to start global sync' });
    }
});

module.exports = router;

