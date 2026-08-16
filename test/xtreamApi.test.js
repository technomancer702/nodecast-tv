const test = require('node:test');
const assert = require('node:assert/strict');

const { XtreamApi, normalizeBaseUrls } = require('../server/services/xtreamApi');
const { getXtreamSeedConfig, seedXtreamSourceFromEnv } = require('../server/services/sourceSeeder');

test('normalizeBaseUrls removes blanks, trailing slashes and duplicates', () => {
    assert.deepEqual(
        normalizeBaseUrls('http://primary.test/', ['http://backup.test///', '', 'http://primary.test']),
        ['http://primary.test', 'http://backup.test']
    );
});

test('Xtream API falls back and remembers the responsive URL', async (t) => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    const requestedHosts = [];
    global.fetch = async (url) => {
        const value = String(url);
        requestedHosts.push(new URL(value).host);
        if (value.startsWith('http://primary.test')) {
            throw new Error('DNS lookup failed');
        }
        return {
            status: 200,
            ok: true,
            headers: { get: () => null },
            json: async () => ({ user_info: { auth: 1 } })
        };
    };

    const api = new XtreamApi(
        ['http://primary.test', 'http://backup.test'],
        'user',
        'pass',
        { allowPrivate: true }
    );

    const result = await api.authenticate();

    assert.equal(result.user_info.auth, 1);
    assert.equal(api.baseUrl, 'http://backup.test');
    assert.deepEqual(requestedHosts, ['primary.test', 'backup.test']);
    assert.match(api.buildStreamUrl('123', 'live', 'm3u8'), /^http:\/\/backup\.test\/live\//);
});

test('Xtream seed parses fallback DNS values without exposing credentials in code', () => {
    const config = getXtreamSeedConfig({
        SEED_XTREAM_URL: 'http://primary.test/',
        SEED_XTREAM_FALLBACK_URLS: 'http://backup-a.test,http://backup-b.test',
        SEED_XTREAM_USERNAME: 'local-user',
        SEED_XTREAM_PASSWORD: 'local-password'
    });

    assert.equal(config.url, 'http://primary.test');
    assert.deepEqual(config.fallbackUrls, ['http://backup-a.test', 'http://backup-b.test']);
});

test('Xtream seed does not overwrite an existing source', async () => {
    let createCalls = 0;
    const sourceStore = {
        getAll: async () => [{ id: 1, type: 'xtream' }],
        create: async () => { createCalls += 1; }
    };
    const env = {
        SEED_XTREAM_URL: 'http://primary.test',
        SEED_XTREAM_USERNAME: 'local-user',
        SEED_XTREAM_PASSWORD: 'local-password'
    };

    const result = await seedXtreamSourceFromEnv(env, sourceStore);

    assert.equal(result.reason, 'already-exists');
    assert.equal(createCalls, 0);
});
