const express = require('express');
const router = express.Router();
const { sources } = require('../db');
const xtreamApi = require('../services/xtreamApi');

// Get all sources
router.get('/', async (req, res) => {
    try {
        const allSources = await sources.getAll();
        // Don't expose passwords in list view
        const sanitized = allSources.map(s => ({
            ...s,
            password: s.password ? '••••••••' : null
        }));
        res.json(sanitized);
    } catch (err) {
        console.error('Error getting sources:', err);
        res.status(500).json({ error: 'Failed to get sources' });
    }
});

// Get sources by type
router.get('/type/:type', async (req, res) => {
    try {
        const typeSources = await sources.getByType(req.params.type);
        res.json(typeSources);
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
        res.json(source);
    } catch (err) {
        console.error('Error getting source:', err);
        res.status(500).json({ error: 'Failed to get source' });
    }
});

// Create source
router.post('/', async (req, res) => {
    try {
        const { type, name, url, username, password } = req.body;

        if (!type || !name || !url) {
            return res.status(400).json({ error: 'Type, name, and URL are required' });
        }

        if (!['xtream', 'm3u', 'epg'].includes(type)) {
            return res.status(400).json({ error: 'Invalid source type' });
        }

        const source = await sources.create({ type, name, url, username, password });
        res.status(201).json(source);
    } catch (err) {
        console.error('Error creating source:', err);
        res.status(500).json({ error: 'Failed to create source' });
    }
});

// Update source
router.put('/:id', async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }

        const { name, url, username, password } = req.body;
        const updated = await sources.update(req.params.id, {
            name: name || existing.name,
            url: url || existing.url,
            username: username !== undefined ? username : existing.username,
            password: password !== undefined ? password : existing.password
        });
        res.json(updated);
    } catch (err) {
        console.error('Error updating source:', err);
        res.status(500).json({ error: 'Failed to update source' });
    }
});

// Delete source
router.delete('/:id', async (req, res) => {
    try {
        const existing = await sources.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Source not found' });
        }
        await sources.delete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting source:', err);
        res.status(500).json({ error: 'Failed to delete source' });
    }
});

// Toggle source enabled/disabled
router.post('/:id/toggle', async (req, res) => {
    try {
        const updated = await sources.toggleEnabled(req.params.id);
        if (!updated) {
            return res.status(404).json({ error: 'Source not found' });
        }
        res.json(updated);
    } catch (err) {
        console.error('Error toggling source:', err);
        res.status(500).json({ error: 'Failed to toggle source' });
    }
});

// Test source connection
router.post('/:id/test', async (req, res) => {
    try {
        const source = await sources.getById(req.params.id);
        if (!source) {
            return res.status(404).json({ error: 'Source not found' });
        }

        if (source.type === 'xtream') {
            const result = await xtreamApi.authenticate(source.url, source.username, source.password);
            res.json({ success: true, data: result });
        } else if (source.type === 'm3u') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('#EXTM3U');
            res.json({ success: isValid, message: isValid ? 'Valid M3U playlist' : 'Invalid M3U format' });
        } else if (source.type === 'epg') {
            const response = await fetch(source.url);
            const text = await response.text();
            const isValid = text.includes('<tv') || text.includes('<?xml');
            res.json({ success: isValid, message: isValid ? 'Valid EPG XML' : 'Invalid EPG format' });
        }
    } catch (err) {
        console.error('Error testing source:', err);
        res.json({ success: false, error: err.message });
    }
});

module.exports = router;
