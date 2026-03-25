function normalizeSourceUrl(url) {
    if (typeof url !== 'string') {
        return url;
    }

    const trimmed = url.trim();
    if (!trimmed) {
        return trimmed;
    }

    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return `http://${trimmed}`.replace(/\/+$/, '');
    }

    return trimmed.replace(/\/+$/, '');
}

module.exports = { normalizeSourceUrl };