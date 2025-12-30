const express = require('express');
const router = express.Router();
const { hiddenItems } = require('../db');

// Get all hidden items
router.get('/hidden', async (req, res) => {
    try {
        const { sourceId } = req.query;
        const items = await hiddenItems.getAll(sourceId ? parseInt(sourceId) : null);
        res.json(items);
    } catch (err) {
        console.error('Error getting hidden items:', err);
        res.status(500).json({ error: 'Failed to get hidden items' });
    }
});

// Hide a channel, group, or category
router.post('/hide', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;

        if (!sourceId || !itemType || !itemId) {
            return res.status(400).json({ error: 'sourceId, itemType, and itemId are required' });
        }

        const validTypes = ['channel', 'group', 'vod_category', 'series_category'];
        if (!validTypes.includes(itemType)) {
            return res.status(400).json({ error: `itemType must be one of: ${validTypes.join(', ')}` });
        }

        await hiddenItems.hide(sourceId, itemType, itemId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error hiding item:', err);
        res.status(500).json({ error: 'Failed to hide item' });
    }
});

// Show (unhide) a channel or group
router.post('/show', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.body;

        if (!sourceId || !itemType || !itemId) {
            return res.status(400).json({ error: 'sourceId, itemType, and itemId are required' });
        }

        await hiddenItems.show(sourceId, itemType, itemId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error showing item:', err);
        res.status(500).json({ error: 'Failed to show item' });
    }
});

// Check if item is hidden
router.get('/hidden/check', async (req, res) => {
    try {
        const { sourceId, itemType, itemId } = req.query;

        if (!sourceId || !itemType || !itemId) {
            return res.status(400).json({ error: 'sourceId, itemType, and itemId are required' });
        }

        // isHidden is now async
        const isHidden = await hiddenItems.isHidden(parseInt(sourceId), itemType, itemId);
        res.json({ hidden: isHidden });
    } catch (err) {
        console.error('Error checking hidden status:', err);
        res.status(500).json({ error: 'Failed to check hidden status' });
    }
});

// Bulk hide channels and groups
router.post('/hide/bulk', async (req, res) => {
    try {
        const { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items array is required' });
        }

        await hiddenItems.bulkHide(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        console.error('Error bulk hiding items:', err);
        res.status(500).json({ error: 'Failed to bulk hide items' });
    }
});

// Bulk show channels and groups
router.post('/show/bulk', async (req, res) => {
    try {
        const { items } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items array is required' });
        }

        await hiddenItems.bulkShow(items);
        res.json({ success: true, count: items.length });
    } catch (err) {
        console.error('Error bulk showing items:', err);
        res.status(500).json({ error: 'Failed to bulk show items' });
    }
});

module.exports = router;
