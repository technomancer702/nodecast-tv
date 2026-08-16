const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const { isPrivateIp, validateExternalUrl } = require('../server/services/externalUrl');
const { sealUrl, unsealUrl } = require('../server/services/urlToken');
const { fetchValidated } = require('../server/services/safeFetch');
const { createInlineScriptHash } = require('../server/services/contentSecurityPolicy');

test('configured JWT lifetime is applied to newly issued tokens', () => {
    const result = spawnSync(process.execPath, ['-e', `
        process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters';
        process.env.JWT_EXPIRY = '30d';
        const jwt = require('jsonwebtoken');
        const auth = require('./server/auth');
        const payload = jwt.decode(auth.generateToken({ id: 1, username: 'test', role: 'admin' }));
        process.stdout.write(String(payload.exp - payload.iat));
    `], { cwd: process.cwd(), encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout), 30 * 24 * 60 * 60);
});

test('provider 401 errors do not clear the local NodeCast session', async () => {
    let tokenRemoved = false;
    const context = {
        window: { location: { href: '/' } },
        localStorage: {
            getItem: () => 'local-session-token',
            removeItem: () => { tokenRemoved = true; }
        },
        fetch: async () => ({
            ok: false,
            status: 401,
            headers: { get: () => 'application/json' },
            json: async () => ({ error: 'Provider rejected the stream' })
        })
    };
    vm.runInNewContext(fs.readFileSync('public/js/api.js', 'utf8'), context);

    await assert.rejects(context.window.API.request('GET', '/proxy/provider'), /Provider rejected/);
    assert.equal(tokenRemoved, false);
    assert.equal(context.window.location.href, '/');
});

test('concurrent database updates retain sources and users', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-db-test-'));
    try {
        const result = spawnSync(process.execPath, ['-e', `
            process.env.NODECAST_DATA_DIR = process.argv[1];
            const db = require('./server/db');
            Promise.all([
                db.sources.create({ type: 'xtream', name: 'Test source', url: 'https://example.test' }),
                db.users.create({ username: 'test-user', role: 'admin' })
            ]).then(async () => {
                const data = await db.loadDb();
                process.stdout.write(JSON.stringify({ sources: data.sources.length, users: data.users.length }));
            }).catch(error => { console.error(error); process.exit(1); });
        `, tempDir], { cwd: process.cwd(), encoding: 'utf8' });

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { sources: 1, users: 1 });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('CSP inline-script hashes are stable across Windows and browser newlines', () => {
    assert.equal(
        createInlineScriptHash('const ready = true;\r\nconsole.log(ready);\r\n'),
        createInlineScriptHash('const ready = true;\nconsole.log(ready);\n')
    );
});

test('browser security helpers escape markup and reject script URLs', () => {
    const context = {
        URL,
        window: { location: { origin: 'http://127.0.0.1:3000' } },
        document: { addEventListener: () => {} },
        HTMLImageElement: class {}
    };
    vm.runInNewContext(fs.readFileSync('public/js/security.js', 'utf8'), context);

    assert.equal(
        context.window.Security.escapeHtml('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    assert.equal(context.window.Security.safeUrl('javascript:alert(1)', '/safe'), '/safe');
    assert.match(
        context.window.Security.imageUrl('https://images.example/poster.jpg'),
        /^\/api\/proxy\/image\?url=/
    );
});

test('private and loopback addresses are rejected', async () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('192.168.1.2'), true);
    assert.equal(isPrivateIp('10.0.0.1'), true);
    assert.equal(isPrivateIp('::1'), true);
    assert.equal(isPrivateIp('8.8.8.8'), false);

    await assert.rejects(validateExternalUrl('http://127.0.0.1/admin'), /Private|reserved/);
    await assert.rejects(validateExternalUrl('file:///etc/passwd'), /HTTP and HTTPS/);
});

test('stream URL tokens conceal credentials and reject tampering', () => {
    const sensitiveUrl = 'https://provider.example/live/user/secret/123.m3u8';
    const token = sealUrl(sensitiveUrl);

    assert.equal(token.includes('user'), false);
    assert.equal(token.includes('secret'), false);
    assert.equal(unsealUrl(token), sensitiveUrl);
    const middle = Math.floor(token.length / 2);
    const tampered = `${token.slice(0, middle)}${token[middle] === 'a' ? 'b' : 'a'}${token.slice(middle + 1)}`;
    assert.throws(() => unsealUrl(tampered), /Invalid|expired/);
});

test('HTTPS redirects are upgraded when the media host supports HTTPS', async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });

    const requested = [];
    global.fetch = async value => {
        const url = String(value);
        requested.push(url);
        if (url === 'https://provider.test/start') {
            return {
                status: 302,
                headers: { get: name => name === 'location' ? 'http://cdn.test/media.m3u8' : null }
            };
        }
        return {
            status: 200,
            ok: true,
            headers: { get: () => null }
        };
    };

    const response = await fetchValidated('https://provider.test/start', { allowPrivate: true });
    assert.equal(response.status, 200);
    assert.deepEqual(requested, [
        'https://provider.test/start',
        'https://cdn.test/media.m3u8'
    ]);
});
