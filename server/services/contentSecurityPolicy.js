const crypto = require('crypto');

function normalizeInlineScript(script) {
    return script.replace(/\r\n?/g, '\n');
}

function createInlineScriptHash(script) {
    const normalized = normalizeInlineScript(script);
    return `'sha256-${crypto.createHash('sha256').update(normalized).digest('base64')}'`;
}

module.exports = { normalizeInlineScript, createInlineScriptHash };
