const express = require('express');
const router = express.Router();
const { favorites } = require('../db');

// Get all favorites
router.get('/', async (req, res) => {
    try {
        const { sourceId, itemType } = req.query;
        const items = await favorites.getAll(sourceId, itemType);
        res.json(items);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add favorite
router.post('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        await favorites.add(sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove favorite
router.delete('/', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.body;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        await favorites.remove(sourceId, itemId, itemType);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check if item is favorited
router.get('/check', async (req, res) => {
    try {
        const { sourceId, itemId, itemType = 'channel' } = req.query;
        if (!sourceId || !itemId) {
            return res.status(400).json({ error: 'Source ID and Item ID are required' });
        }

        const isFav = await favorites.isFavorite(sourceId, itemId, itemType);
        res.json({ isFavorite: isFav });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
