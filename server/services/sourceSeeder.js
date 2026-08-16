const { sources } = require('../db');
const { normalizeBaseUrls } = require('./xtreamApi');

function getXtreamSeedConfig(env = process.env) {
    const url = env.SEED_XTREAM_URL?.trim();
    const username = env.SEED_XTREAM_USERNAME?.trim();
    const password = env.SEED_XTREAM_PASSWORD?.trim();

    if (!url || !username || !password) {
        return null;
    }

    const fallbackUrls = normalizeBaseUrls(null, env.SEED_XTREAM_FALLBACK_URLS)
        .filter(item => item !== url.replace(/\/+$/, ''));

    return {
        type: 'xtream',
        name: env.SEED_XTREAM_NAME?.trim() || 'Preconfigured IPTV',
        url: url.replace(/\/+$/, ''),
        username,
        password,
        fallbackUrls
    };
}

async function seedXtreamSourceFromEnv(env = process.env, sourceStore = sources) {
    const config = getXtreamSeedConfig(env);
    if (!config) {
        return { created: false, reason: 'not-configured' };
    }

    const allSources = await sourceStore.getAll();
    if (allSources.some(source => source.type === 'xtream')) {
        return { created: false, reason: 'already-exists' };
    }

    const source = await sourceStore.create(config);
    console.log(`[Seed] Created preconfigured Xtream source "${source.name}"`);
    return { created: true, sourceId: source.id };
}

module.exports = { getXtreamSeedConfig, seedXtreamSourceFromEnv };
