const { discoverOidcEndpoints } = require('./services/oidcDiscovery');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { Strategy: LocalStrategy } = require('passport-local');
const speakeasy = require('speakeasy');
const security = require('./config/security');
const authTokens = require('./services/authTokens');

/**
 * Authentication and Authorization Module
 * Handles user authentication, session management, and role-based access control
 * Using Passport.js with JWT tokens
 */

// JWT Secret - In production, use environment variable
const JWT_SECRET = security.jwtSecret;
const JWT_EXPIRY = '24h';
const MFA_TOKEN_EXPIRY = '5m';
const MFA_AUDIENCE = 'nodecast-tv:mfa';
// The pending-2FA challenge token uses its own key and audience so it can never
// verify as an access token (and vice versa).
const MFA_SECRET = crypto.createHmac('sha256', JWT_SECRET).update('nodecast-tv:mfa-challenge').digest();
const TOTP_STEP_SECONDS = 30;

// AES-256-GCM key for TOTP secrets at rest (env or persisted, see config/security)
const TOTP_KEY = security.totpEncryptionKey;

/**
 * Hash password using bcrypt
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Verify password against hash
 */
async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || typeof hash !== 'string') return false;
    return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            username: user.username,
            role: user.role,
            authVersion: user.authVersion || 0,
            kind: 'access'
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY, algorithm: 'HS256', audience: 'nodecast-tv', jwtid: crypto.randomUUID() }
    );
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
    try {
        const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'nodecast-tv' });
        return payload.kind === 'access' && typeof payload.jti === 'string' ? payload : null;
    } catch (err) {
        return null;
    }
}

/**
 * Issue the short-lived challenge token for the 2FA step. It only proves the
 * password was correct and is accepted exclusively by POST /api/auth/2fa/verify.
 */
function generateMfaToken(user) {
    return jwt.sign(
        { sub: String(user.id), kind: 'mfa', authVersion: user.authVersion || 0 },
        MFA_SECRET,
        { expiresIn: MFA_TOKEN_EXPIRY, algorithm: 'HS256', audience: MFA_AUDIENCE, jwtid: crypto.randomUUID() }
    );
}

/**
 * Verify a 2FA challenge token and return its payload, or null if invalid,
 * expired, already used, or not a challenge token.
 */
function verifyMfaToken(token) {
    if (typeof token !== 'string') return null;
    try {
        const payload = jwt.verify(token, MFA_SECRET, { algorithms: ['HS256'], audience: MFA_AUDIENCE });
        if (payload.kind !== 'mfa' || typeof payload.jti !== 'string' || !/^\d+$/.test(payload.sub || '')) return null;
        if (authTokens.isRevoked(payload)) return null;
        return payload;
    } catch (err) {
        return null;
    }
}

/**
 * Generate a new TOTP secret for a user (returns base32 string)
 */
function generateTotpSecret() {
    return speakeasy.generateSecret({ length: 20 }).base32;
}

/**
 * Generate the otpauth URI used to build the QR code
 */
function generateTotpUri(username, secret) {
    return speakeasy.otpauthURL({
        secret,
        label: username,
        issuer: 'NodeCast TV',
        encoding: 'base32'
    });
}

/**
 * Verify a TOTP token against a secret
 */
function verifyTotpToken(token, secret) {
    return matchTotpStep(token, secret) !== null;
}

/**
 * Return the absolute 30s time step a TOTP code belongs to (allowing one step
 * of clock drift), or null if it does not match. Callers record the step to
 * reject replays of the same code.
 */
function matchTotpStep(token, secret) {
    if (!/^\d{6}$/.test(String(token))) return null;
    try {
        const match = speakeasy.totp.verifyDelta({ secret, encoding: 'base32', token: String(token), window: 1 });
        if (!match) return null;
        return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + match.delta;
    } catch (err) {
        return null;
    }
}

/**
 * Encrypt a TOTP secret using AES-256-GCM.
 * Format: "enc:iv(hex):authTag(hex):ciphertext(hex)"
 */
function encryptSecret(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a TOTP secret encrypted by encryptSecret().
 * Returns the value unchanged if it was stored unencrypted (dev fallback).
 */
function decryptSecret(value) {
    // Secrets stored before encryption was enabled are still accepted as-is
    if (!value || !value.startsWith('enc:')) return value;
    const [, ivHex, tagHex, ctHex] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex')) + decipher.final('utf8');
}

/**
 * Generate N single-use recovery codes (format: XXXXX-XXXXX).
 * Returns { plaintext: string[], hashed: string[] } — store hashed, show plaintext once.
 */
async function generateRecoveryCodes(count = 8) {
    const plaintext = Array.from({ length: count }, () => {
        const hex = crypto.randomBytes(5).toString('hex').toUpperCase();
        return `${hex.slice(0, 5)}-${hex.slice(5)}`;
    });
    const hashed = await Promise.all(plaintext.map(c => bcrypt.hash(c, 10)));
    return { plaintext, hashed };
}

/**
 * Find and consume a recovery code. Returns the index of the matched code, or -1.
 */
/**
 * Return the stored hash matching a recovery code, or null. The hash (not an
 * index) is what db.users.consumeRecoveryCode removes atomically.
 */
async function matchRecoveryCode(input, hashedCodes) {
    if (typeof input !== 'string' || !Array.isArray(hashedCodes)) return null;
    const normalized = input.replace(/\s/g, '').toUpperCase();
    if (!/^[0-9A-F]{5}-?[0-9A-F]{5}$/.test(normalized)) return null;
    const formatted = normalized.includes('-') ? normalized : `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
    for (const hash of hashedCodes) {
        if (hash && await bcrypt.compare(formatted, hash)) return hash;
    }
    return null;
}

/**
 * Configure Passport Local Strategy for username/password authentication
 */
function configureLocalStrategy(getUserByUsername, verifyUserPassword) {
    passport.use(new LocalStrategy(
        async (username, password, done) => {
            try {
                const user = await getUserByUsername(username);

                if (!user) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                const isValid = await verifyUserPassword(password, user.passwordHash);

                if (!isValid) {
                    return done(null, false, { message: 'Invalid credentials' });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }
    ));
}

/**
 * Configure Passport JWT Strategy for token-based authentication
 */
function configureJwtStrategy(getUserById) {
    const options = {
        jwtFromRequest: extractToken,
        secretOrKey: JWT_SECRET,
        algorithms: ['HS256'],
        audience: 'nodecast-tv'
    };

    passport.use(new JwtStrategy(options, async (payload, done) => {
        try {
            const user = await getUserById(payload.id);

            if (!user || payload.kind !== 'access' || typeof payload.jti !== 'string'
                || (payload.authVersion || 0) !== (user.authVersion || 0) || authTokens.isRevoked(payload)) {
                return done(null, false);
            }

            return done(null, {
                id: user.id,
                username: user.username,
                role: user.role
            });
        } catch (err) {
            return done(err, false);
        }
    }));
}

/**
 * Configure Passport session serialization
 * Required for OIDC flow which uses sessions
 */
function configureSessionSerialization(getUserById) {
    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await getUserById(id);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    });
}

/**
 * Configure Passport OpenID Connect Strategy
 */
async function configureOidcStrategy(findUserByOidcId, findUserByEmail, createUser) {
    if (!process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID || !process.env.OIDC_CLIENT_SECRET) {
        console.warn('OIDC configuration missing - SSO disabled');
        return false;
    }

    const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');

    const endpoints = await discoverOidcEndpoints(process.env);
    passport.use(new OpenIDConnectStrategy({
        ...endpoints,
        clientID: process.env.OIDC_CLIENT_ID,
        clientSecret: process.env.OIDC_CLIENT_SECRET,
        callbackURL: process.env.OIDC_CALLBACK_URL || '/api/auth/oidc/callback',
        scope: ['openid', 'profile', 'email']
    },
        async (...args) => {
            // The done callback is always the last argument
            const done = args[args.length - 1];

            // Map known arguments
            // Standard: issuer, sub, profile, accessToken, refreshToken, done
            // Some versions: issuer, sub, profile, accessToken, refreshToken, params, done

            let issuer, sub, profile;

            if (args.length === 3) {
                // Scenario: (issuer, profile, done)
                const arg0 = args[0];
                const arg1 = args[1];

                if (typeof arg1 === 'object' && arg1.id) {
                    issuer = arg0;
                    profile = arg1;
                    sub = profile.id;
                } else if (typeof arg0 === 'string' && typeof arg1 === 'string') {
                    issuer = arg0;
                    sub = arg1;
                    profile = { id: sub, displayName: 'Unknown' };
                }
            } else if (args.length >= 4) {
                // Assume standard: iss, sub, profile...
                issuer = args[0];
                sub = args[1];
                profile = args[2];
            }

            if (!sub && profile && profile.id) sub = profile.id;

            if (!sub) {
                return done(new Error('Could not identify OIDC Subject (sub) from arguments'));
            }

            try {
                // 1. Try to find by OIDC ID (sub)
                let user = await findUserByOidcId(sub);

                // 2. If not found, try to match by email
                // Extract email - handle both profile.emails[] (Google) and profile.email (others)
                const email = profile.emails?.[0]?.value || profile.email || profile._json?.email;

                if (!user && email && profile?._json?.email_verified === true) {
                    user = await findUserByEmail(email);

                    // If found by email but no OIDC ID, link them
                    if (user && !user.oidcId) {
                        // We don't have a direct update method for specific fields without full user object in this context
                        // Ideally we'd update the user here. For now, we'll just log in.
                        // Future: Update user with oidcId
                    }
                }

                // 3. If still not found, create new user (JIT Provisioning)
                if (!user) {
                    const username = profile.username || profile.displayName || (email ? email.split('@')[0] : `user_${sub.substring(0, 8)}`);

                    user = await createUser({
                        username: username,
                        role: 'viewer', // Default role for SSO users
                        oidcId: sub,
                        email: email || null
                    });
                }

                return done(null, user);
            } catch (err) {
                return done(err);
            }
        }));
    return true;
}

/**
 * Middleware: Require authentication using Passport JWT
 */
function requireAuth(req, res, next) {
    if (req.authenticatedUser) { req.user = req.authenticatedUser; return next(); }
    passport.authenticate('jwt', { session: false }, (error, user) => {
        if (error) return next(error);
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.user = req.authenticatedUser = user;
        next();
    })(req, res, next);
}

function extractToken(req) {
    const bearer = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
    if (bearer) return bearer;
    for (const part of (req.headers.cookie || '').split(';')) {
        const separator = part.indexOf('=');
        if (part.slice(0, separator).trim() === security.authCookieName) {
            try { return decodeURIComponent(part.slice(separator + 1)); } catch { return null; }
        }
    }
    return null;
}

function cookieOptions(req) {
    return { httpOnly: true, sameSite: 'lax', secure: process.env.AUTH_COOKIE_SECURE === 'true'
        || (process.env.AUTH_COOKIE_SECURE !== 'false' && Boolean(req.secure)), path: '/' };
}
function setAuthCookie(req, res, token) {
    res.cookie(security.authCookieName, token, { ...cookieOptions(req), maxAge: 24 * 60 * 60 * 1000 });
}
function clearAuthCookie(req, res) {
    res.clearCookie(security.authCookieName, cookieOptions(req));
}
function requireSameOrigin(req, res, next) {
    if (req.path.startsWith('/auth/oidc/')) return next();
    if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request blocked' });
    const origin = req.get('origin') || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? req.get('referer') : null);
    if (!origin) return next(); // Non-browser API clients still require authentication.
    try {
        const allowed = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin
            : new URL(`${req.protocol}://${req.get('host')}`).origin;
        if (new URL(origin).origin === allowed) return next();
    } catch { /* Invalid origins are rejected. */ }
    res.status(403).json({ error: 'Cross-site request blocked' });
}

/**
 * Middleware: Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }
    next();
}

/**
 * Middleware: Check for specific role
 */
function requireRole(role) {
    return (req, res, next) => {
        if (!req.user || req.user.role !== role) {
            return res.status(403).json({ error: `Forbidden - ${role} access required` });
        }
        next();
    };
}

module.exports = {
    passport,
    hashPassword,
    verifyPassword,
    generateToken,
    verifyToken,
    generateMfaToken,
    verifyMfaToken,
    generateTotpSecret,
    generateTotpUri,
    verifyTotpToken,
    matchTotpStep,
    encryptSecret,
    decryptSecret,
    generateRecoveryCodes,
    matchRecoveryCode,
    configureLocalStrategy,
    configureJwtStrategy,
    configureSessionSerialization,
    configureOidcStrategy,
    requireAuth,
    extractToken,
    setAuthCookie,
    clearAuthCookie,
    requireSameOrigin,
    requireAdmin,
    requireRole
};
