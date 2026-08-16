const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const secretPath = path.join(__dirname, '..', '..', 'data', '.jwt-secret');

function getRuntimeSecret() {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) {
        return process.env.JWT_SECRET;
    }

    try {
        const existing = fs.readFileSync(secretPath, 'utf8').trim();
        if (existing.length >= 32) return existing;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    const generated = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(secretPath, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
}

module.exports = { getRuntimeSecret };
