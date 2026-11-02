const { getDb } = require('../db/sqlite');

function store() {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS auth_revocations (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_auth_revocations_expiry ON auth_revocations(expires_at)');
    db.prepare('DELETE FROM auth_revocations WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
    return db;
}
function isRevoked(payload) {
    return Boolean(store().prepare('SELECT 1 FROM auth_revocations WHERE id = ?').get(payload.jti));
}
function revoke(payload) {
    store().prepare('INSERT OR REPLACE INTO auth_revocations (id, expires_at) VALUES (?, ?)').run(payload.jti, payload.exp);
}
function consume(payload) {
    return store().prepare('INSERT OR IGNORE INTO auth_revocations (id, expires_at) VALUES (?, ?)')
        .run(payload.jti, payload.exp).changes === 1;
}
module.exports = { isRevoked, revoke, consume };
