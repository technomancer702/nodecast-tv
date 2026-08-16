const dns = require('dns').promises;
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isPrivateIpv4(address) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }

    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224;
}

function isPrivateIp(address) {
    const normalized = String(address).toLowerCase().split('%')[0];
    if (net.isIPv4(normalized)) return isPrivateIpv4(normalized);
    if (!net.isIPv6(normalized)) return true;

    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        if (net.isIPv4(mapped)) return isPrivateIpv4(mapped);
        const halves = mapped.split(':');
        if (halves.length === 2) {
            const high = Number.parseInt(halves[0], 16);
            const low = Number.parseInt(halves[1], 16);
            if (Number.isInteger(high) && Number.isInteger(low)) {
                return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
            }
        }
    }

    const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return normalized === '::' || normalized === '::1' ||
        normalized.startsWith('fc') || normalized.startsWith('fd') ||
        /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8:') || firstHextet < 0x2000 || firstHextet > 0x3fff;
}

async function validateExternalUrl(value, options = {}) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid upstream URL');
    }

    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new Error('Only HTTP and HTTPS upstream URLs are allowed');
    }

    if (url.username || url.password) {
        throw new Error('Credentials in the URL authority are not allowed');
    }

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
        throw new Error('Local upstream addresses are not allowed');
    }

    const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_UPSTREAMS === 'true';
    if (!allowPrivate) {
        const addresses = net.isIP(hostname)
            ? [{ address: hostname }]
            : await dns.lookup(hostname, { all: true, verbatim: true });

        if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
            throw new Error('Private or reserved upstream addresses are not allowed');
        }
    }

    return url;
}

function publicUrlLabel(value) {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}`;
    } catch {
        return '[invalid upstream URL]';
    }
}

module.exports = { validateExternalUrl, isPrivateIp, publicUrlLabel };
