const { unsealUrl } = require('./urlToken');
const { validateExternalUrl } = require('./externalUrl');

async function resolvePlaybackUrl(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Playback URL is required');

    let upstream = value;
    if (value.startsWith('/api/proxy/stream')) {
        const local = new URL(value, 'http://127.0.0.1');
        const token = local.searchParams.get('token');
        if (!token) throw new Error('A protected stream token is required');
        upstream = unsealUrl(token);
    }

    return (await validateExternalUrl(upstream)).href;
}

module.exports = { resolvePlaybackUrl };
