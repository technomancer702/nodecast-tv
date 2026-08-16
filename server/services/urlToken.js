const crypto = require('crypto');

// Tokens are intentionally process-local. Restarting NodeCast invalidates old playback URLs.
const key = crypto.randomBytes(32);

function sealUrl(value) {
    const plaintext = Buffer.from(String(value), 'utf8');
    if (plaintext.length > 16 * 1024) throw new Error('Upstream URL is too long');

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function unsealUrl(token) {
    if (typeof token !== 'string' || token.length > 24 * 1024) {
        throw new Error('Invalid stream token');
    }

    try {
        const payload = Buffer.from(token, 'base64url');
        if (payload.length < 29) throw new Error('Token is too short');
        const iv = payload.subarray(0, 12);
        const tag = payload.subarray(12, 28);
        const encrypted = payload.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
        throw new Error('Invalid or expired stream token');
    }
}

module.exports = { sealUrl, unsealUrl };
