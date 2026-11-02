const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.NODECAST_DATA_DIR ? path.resolve(process.env.NODECAST_DATA_DIR) : path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });
const secretPath = path.join(dataDir, 'security.json');
try {
    fs.writeFileSync(secretPath, JSON.stringify({ jwt: crypto.randomBytes(32).toString('base64url'),
        session: crypto.randomBytes(32).toString('base64url') }), { flag: 'wx', mode: 0o600 });
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
const persisted = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
if (typeof persisted.jwt !== 'string' || persisted.jwt.length < 32 || typeof persisted.session !== 'string' || persisted.session.length < 32) {
    throw new Error('Invalid persisted authentication secrets');
}
const jwtSecret = process.env.JWT_SECRET || persisted.jwt;
const suffix = crypto.createHash('sha256').update(jwtSecret).digest('hex').slice(0, 12);
// TOTP secrets are encrypted at rest. Without TOTP_ENCRYPTION_KEY a random key
// is persisted beside the other secrets so installs never store them in clear.
function totpEncryptionKey() {
    let hex = process.env.TOTP_ENCRYPTION_KEY;
    if (!hex) {
        const keyPath = path.join(dataDir, 'totp.key');
        try {
            fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        hex = fs.readFileSync(keyPath, 'utf8').trim();
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('TOTP encryption key must be 64 hex characters');
    return Buffer.from(hex, 'hex');
}
module.exports = { jwtSecret, sessionSecret: process.env.SESSION_SECRET || persisted.session,
    authCookieName: `nodecast_auth_${suffix}`, sessionCookieName: `nodecast_session_${suffix}`,
    totpEncryptionKey: totpEncryptionKey() };
