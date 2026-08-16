const { validateExternalUrl } = require('./externalUrl');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchValidated(value, options = {}) {
    const {
        maxRedirects = 5,
        preferHttps = true,
        allowPrivate,
        ...fetchOptions
    } = options;

    let current = await validateExternalUrl(value, { allowPrivate });
    let downgradeFallback = null;

    for (let hop = 0; hop <= maxRedirects; hop++) {
        let response;
        try {
            response = await fetch(current, { ...fetchOptions, redirect: 'manual' });
        } catch (error) {
            if (downgradeFallback) {
                current = downgradeFallback;
                downgradeFallback = null;
                continue;
            }
            throw error;
        }
        downgradeFallback = null;

        const location = response.headers.get('location');
        if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
        if (hop === maxRedirects) throw new Error('Too many upstream redirects');
        await response.body?.cancel().catch(() => {});

        let next = await validateExternalUrl(new URL(location, current).href, { allowPrivate });
        if (preferHttps && current.protocol === 'https:' && next.protocol === 'http:') {
            downgradeFallback = next;
            const upgraded = new URL(next);
            upgraded.protocol = 'https:';
            try {
                next = await validateExternalUrl(upgraded.href, { allowPrivate });
            } catch {
                next = downgradeFallback;
                downgradeFallback = null;
            }
        } else {
            downgradeFallback = null;
        }

        current = next;
    }

    throw new Error('Unable to fetch upstream URL');
}

module.exports = { fetchValidated };
