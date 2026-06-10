const express = require('express');
const router = express.Router();

router.post('/zap', async (req, res) => {
    const { boxUrl, serviceRef } = req.body;

    if (!boxUrl || !serviceRef) {
        return res.status(400).json({ error: 'boxUrl and serviceRef are required' });
    }

    try {
        const zapUrl = `${boxUrl.replace(/\/$/, '')}/web/zap?sRef=${encodeURIComponent(serviceRef)}`;
        console.log('[ZAP]', zapUrl);

        const response = await fetch(zapUrl);
        const text = await response.text();

        res.json({
            success: response.ok,
            status: response.status,
            response: text
        });
    } catch (err) {
        console.error('[ZAP] Failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;