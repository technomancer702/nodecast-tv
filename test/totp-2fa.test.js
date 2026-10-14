const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');

async function serverFixture(t, extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-2fa-test-'));
    const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir, NODE_ENV: 'production',
            NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '', TOTP_ENCRYPTION_KEY: '',
            OIDC_ISSUER_URL: '', AUTH_COOKIE_SECURE: '', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(async () => {
        if (child.exitCode === null) {
            const closed = new Promise(resolve => child.once('close', resolve));
            child.kill();
            await closed;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    let output = '';
    const base = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
        child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/server running on http:\/\/localhost:(\d+)/);
            if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
        });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    });
    const request = async (endpoint, { body, headers, method } = {}) => {
        const response = await fetch(`${base}${endpoint}`, { method: method || (body ? 'POST' : 'GET'),
            headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')) };
    };
    const readDb = () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    return { dir, request, readDb };
}

const cookieOf = result => ({ Cookie: result.cookie.split(';')[0] });
const totp = (secret, offsetSteps = 0) => speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(Date.now() / 1000) + offsetSteps * 30 });

// Admin with 2FA enabled; returns the admin session, TOTP secret and recovery codes
async function enrolledAdmin(fixture) {
    const { request } = fixture;
    const admin = await request('/api/auth/setup', { body: { username: 'Admin', password: 'password123' } });
    const headers = cookieOf(admin);
    const setup = await request('/api/auth/2fa/setup', { headers });
    assert.equal(setup.status, 200);
    // Enrol with the previous step's code so the current one is still unused for login
    const enabled = await request('/api/auth/2fa/enable', { headers, body: { code: totp(setup.body.secret, -1) } });
    assert.equal(enabled.status, 200);
    return { admin, headers, secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes };
}
const challenge = async request => {
    const login = await request('/api/auth/login', { body: { username: 'Admin', password: 'password123' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.requires2fa, true);
    assert.equal(login.cookie, undefined, 'no session cookie before the second factor');
    assert.equal(login.body.token, undefined);
    return login.body.tempToken;
};

test('2FA challenge tokens are rejected by every protected route and only accepted once by /2fa/verify', async t => {
    const fixture = await serverFixture(t);
    const { request, dir } = fixture;
    const { admin, secret } = await enrolledAdmin(fixture);
    const tempToken = await challenge(request);

    const cookieName = admin.cookie.split('=')[0];
    for (const headers of [{ Authorization: `Bearer ${tempToken}` }, { Cookie: `${cookieName}=${tempToken}` }]) {
        for (const route of ['/api/auth/me', '/api/auth/users', '/api/sources', '/api/settings', '/api/auth/2fa/status']) {
            assert.equal((await request(route, { headers })).status, 401, `${route} ${Object.keys(headers)[0]}`);
        }
        assert.equal((await request('/api/auth/users', { headers, body: { username: 'Evil', password: 'password123', role: 'admin' } })).status, 401);
    }

    // The original bypass: an id/purpose token signed with the JWT secret is not an access token
    const jwtSecret = JSON.parse(fs.readFileSync(path.join(dir, 'security.json'), 'utf8')).jwt;
    const legacy = jwt.sign({ id: admin.body.user.id, purpose: '2fa' }, jwtSecret, { expiresIn: '5m' });
    assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${legacy}` } })).status, 401);
    // ...nor a challenge token for /2fa/verify, and neither is a real access token
    for (const token of [legacy, admin.body.token]) {
        assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: token, code: totp(secret) } })).status, 401);
    }

    const verified = await request('/api/auth/2fa/verify', { body: { tempToken, code: totp(secret) } });
    assert.equal(verified.status, 200);
    assert.equal((await request('/api/auth/me', { headers: cookieOf(verified) })).body.username, 'Admin');
    // Single use: the same challenge cannot mint a second session, even with a fresh code
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken, code: totp(secret, 1) } })).status, 401);
});

test('a TOTP code cannot be replayed and a recovery code is consumed exactly once under concurrency', async t => {
    const fixture = await serverFixture(t);
    const { request } = fixture;
    const { secret, recoveryCodes } = await enrolledAdmin(fixture);

    const code = totp(secret);
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: await challenge(request), code } })).status, 200);
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: await challenge(request), code } })).status, 401);

    const tokens = await Promise.all(Array.from({ length: 4 }, () => challenge(request)));
    const results = await Promise.all(tokens.map(tempToken =>
        request('/api/auth/2fa/verify', { body: { tempToken, code: recoveryCodes[0] } })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401, 401, 401]);
    const stored = fixture.readDb().users[0].recoveryCodes;
    assert.equal(stored.filter(hash => hash === null).length, 1);
});

test('challenges are invalidated by a password change and expire', async t => {
    const fixture = await serverFixture(t);
    const { request, dir } = fixture;
    const { admin, headers, secret } = await enrolledAdmin(fixture);
    const tempToken = await challenge(request);
    assert.equal((await request(`/api/auth/users/${admin.body.user.id}`, { method: 'PUT', headers, body: { password: 'changed123' } })).status, 200);
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken, code: totp(secret) } })).status, 401);

    const jwtSecret = JSON.parse(fs.readFileSync(path.join(dir, 'security.json'), 'utf8')).jwt;
    const mfaKey = crypto.createHmac('sha256', jwtSecret).update('nodecast-tv:mfa-challenge').digest();
    const expired = jwt.sign({ sub: String(admin.body.user.id), kind: 'mfa', authVersion: 1, iat: Math.floor(Date.now() / 1000) - 600 },
        mfaKey, { expiresIn: '5m', audience: 'nodecast-tv:mfa', jwtid: 'expired' });
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: expired, code: totp(secret) } })).status, 401);
});

test('2FA login works over plain HTTP in production and marks the cookie Secure behind an HTTPS proxy', async t => {
    const { request } = await serverFixture(t);
    const { secret } = await enrolledAdmin({ request });

    const plain = await request('/api/auth/2fa/verify', { body: { tempToken: await challenge(request), code: totp(secret) } });
    assert.equal(plain.status, 200);
    assert.match(plain.cookie, /HttpOnly/);
    assert.doesNotMatch(plain.cookie, /;\s*Secure/i);
    assert.equal((await request('/api/auth/me', { headers: cookieOf(plain) })).status, 200);

    const proxied = await request('/api/auth/2fa/verify', { headers: { 'X-Forwarded-Proto': 'https' },
        body: { tempToken: await challenge(request), code: totp(secret, 1) } });
    assert.equal(proxied.status, 200);
    assert.match(proxied.cookie, /;\s*Secure/i);
});

test('TOTP secrets are encrypted at rest without configuration and never returned by user endpoints', async t => {
    const fixture = await serverFixture(t);
    const { request, dir } = fixture;
    const { admin, headers } = await enrolledAdmin(fixture);

    const keyFile = path.join(dir, 'totp.key');
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    const [stored] = fixture.readDb().users;
    assert.match(stored.totpSecret, /^enc:/);

    const sensitive = ['passwordHash', 'totpSecret', 'totpPendingSecret', 'recoveryCodes', 'totpLastStep'];
    const listed = await request('/api/auth/users', { headers });
    const updated = await request(`/api/auth/users/${admin.body.user.id}`, { method: 'PUT', headers, body: { username: 'Admin2' } });
    for (const user of [listed.body[0], updated.body]) {
        for (const field of sensitive) assert.equal(field in user, false, field);
        assert.equal(user.totpEnabled, true);
    }
});

test('second-factor guessing is rate limited per client', async t => {
    const { request } = await serverFixture(t);
    for (let i = 0; i < 10; i++) {
        assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: 'invalid', code: '000000' } })).status, 401);
    }
    assert.equal((await request('/api/auth/2fa/verify', { body: { tempToken: 'invalid', code: '000000' } })).status, 429);
});
