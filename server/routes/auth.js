const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../auth');
const { requestLimit } = require('../services/requestLimits');
const authTokens = require('../services/authTokens');
const loginLimit = requestLimit(20);

// Bounds TOTP/recovery-code guessing per client, on top of the login limit
const totpVerifyLimiter = requestLimit(10, 15 * 60 * 1000);

// Fields safe to return from user management endpoints (no hashes or TOTP secrets)
function publicUser(user) {
    const { id, username, role, email, oidcId, createdAt, updatedAt } = user;
    return { id, username, role, email, oidcId, createdAt, updatedAt, totpEnabled: !!user.totpEnabled };
}

// Configure Passport strategies
auth.configureLocalStrategy(
    async (username) => await db.users.getByUsername(username),
    async (password, hash) => await auth.verifyPassword(password, hash)
);

auth.configureJwtStrategy(
    async (id) => await db.users.getById(id)
);

// Configure Passport session serialization (required for OIDC)
auth.configureSessionSerialization(
    async (id) => await db.users.getById(id)
);

// Configure OIDC once; SSO routes wait until discovery and registration finish.
let oidcAvailable = false;
const oidcReady = auth.configureOidcStrategy(
    async (oidcId) => await db.users.getByOidcId(oidcId),
    async (email) => await db.users.getByEmail(email),
    async (userData) => await db.users.create(userData)
).then(available => { oidcAvailable = available; }).catch(error => {
    console.error('[OIDC] SSO unavailable:', error.message);
});
router.oidcReady = oidcReady;
async function requireOidc(req, res, next) {
    await oidcReady;
    if (!oidcAvailable) return res.status(503).json({ error: 'Single sign-on is unavailable. Contact your administrator.' });
    next();
}

/**
 * Start OIDC Login
 * GET /api/auth/oidc/login
 */
router.get('/oidc/login', requireOidc, auth.passport.authenticate('openidconnect'));

/**
 * OIDC Callback
 * GET /api/auth/oidc/callback
 */
router.get('/oidc/callback', requireOidc,
    auth.passport.authenticate('openidconnect', { session: false, failureRedirect: '/login.html?error=SSO+Failed' }),
    (req, res) => {
        const token = auth.generateToken(req.user);

        auth.setAuthCookie(req, res, token);
        req.session.regenerate(error => error ? res.status(500).json({ error: 'Login failed' }) : res.redirect('/'));
    }
);

/**
 * Check if initial setup is required
 * GET /api/auth/setup-required
 */
router.get('/setup-required', async (req, res) => {
    try {
        const userCount = (await db.checkHealth()).users.length;
        res.json({ setupRequired: userCount === 0 });
    } catch (err) {
        console.error('Error in /setup-required:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Initial setup - Create admin user
 * POST /api/auth/setup
 */
router.post('/setup', loginLimit, async (req, res) => {
    try {
        const userCount = (await db.checkHealth()).users.length;

        // Check if setup already done
        if (userCount > 0) {
            return res.status(400).json({ error: 'Setup already completed' });
        }

        const { username, password } = req.body;

        if (typeof username !== 'string' || !username.trim() || username.length > 64 || typeof password !== 'string') {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (password.length < 6 || Buffer.byteLength(password) > 72) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Create admin user
        const passwordHash = await auth.hashPassword(password);
        const adminUser = await db.users.create({
            username,
            passwordHash,
            role: 'admin'
        }, { initialSetup: true });

        const token = auth.generateToken(adminUser);
        auth.setAuthCookie(req, res, token);

        res.status(201).json({
            message: 'Admin user created successfully',
            token,
            user: adminUser
        });
    } catch (err) {
        console.error('Error in /setup:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Login with Passport Local Strategy
 * POST /api/auth/login
 */
router.post('/login', loginLimit, (req, res, next) => {
    if (typeof req.body.username !== 'string' || typeof req.body.password !== 'string' || req.body.password.length > 1024) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    auth.passport.authenticate('local', { session: false }, async (err, user, info) => {
        if (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (!user) {
            return res.status(401).json({ error: info?.message || 'Invalid credentials' });
        }

        // If 2FA is enabled, only issue a challenge token; the access token and
        // cookie are issued by /2fa/verify once the second factor is proven
        const fullUser = await db.users.getById(user.id);
        if (fullUser && fullUser.totpEnabled) {
            return res.json({ requires2fa: true, tempToken: auth.generateMfaToken(fullUser) });
        }

        const token = auth.generateToken(user);
        auth.setAuthCookie(req, res, token);
        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    })(req, res, next);
});

/**
 * Verify TOTP code after login
 * POST /api/auth/2fa/verify
 */
router.post('/2fa/verify', totpVerifyLimiter, async (req, res) => {
    try {
        const { tempToken, code } = req.body;

        if (typeof tempToken !== 'string' || typeof code !== 'string' || !code.trim()) {
            return res.status(400).json({ error: 'tempToken and code are required' });
        }

        const challenge = auth.verifyMfaToken(tempToken);
        if (!challenge) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        const user = await db.users.getById(challenge.sub);
        if (!user || !user.totpEnabled || !user.totpSecret
            || (challenge.authVersion || 0) !== (user.authVersion || 0)) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        // TOTP codes and recovery codes are each consumed atomically, so a code
        // replayed (or raced) by a second request is rejected
        const step = auth.matchTotpStep(code.trim(), auth.decryptSecret(user.totpSecret));
        let accepted = step !== null && await db.users.consumeTotpStep(user.id, step);
        if (!accepted && step === null) {
            const hash = await auth.matchRecoveryCode(code, user.recoveryCodes);
            accepted = hash !== null && await db.users.consumeRecoveryCode(user.id, hash);
        }
        if (!accepted) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        // The challenge token is single-use
        authTokens.revoke(challenge);

        const token = auth.generateToken(user);
        auth.setAuthCookie(req, res, token);
        res.json({
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
    } catch (err) {
        console.error('2FA verify error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Start 2FA setup — generate secret and return QR code
 * GET /api/auth/2fa/setup
 */
router.get('/2fa/setup', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.totpEnabled) {
            return res.status(400).json({ error: '2FA is already enabled' });
        }

        const secret = auth.generateTotpSecret();
        const uri = auth.generateTotpUri(user.username, secret);
        const qrDataUrl = await QRCode.toDataURL(uri);

        await db.users.update(user.id, { totpPendingSecret: auth.encryptSecret(secret) });

        res.json({ qrDataUrl, secret });
    } catch (err) {
        console.error('2FA setup error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Confirm 2FA setup — verify code and activate
 * POST /api/auth/2fa/enable
 */
router.post('/2fa/enable', auth.requireAuth, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'code is required' });

        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.totpEnabled) {
            return res.status(400).json({ error: '2FA is already enabled' });
        }

        if (!user.totpPendingSecret) {
            return res.status(400).json({ error: 'No pending 2FA setup. Call GET /2fa/setup first.' });
        }

        const plainPending = auth.decryptSecret(user.totpPendingSecret);
        const step = auth.matchTotpStep(String(code).trim(), plainPending);
        if (step === null) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        const { plaintext: recoveryCodes, hashed: hashedCodes } = await auth.generateRecoveryCodes();

        await db.users.update(user.id, {
            totpSecret: auth.encryptSecret(plainPending),
            totpEnabled: true,
            totpPendingSecret: null,
            totpLastStep: step,
            recoveryCodes: hashedCodes
        });

        res.json({ success: true, message: '2FA enabled successfully', recoveryCodes });
    } catch (err) {
        console.error('2FA enable error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Disable 2FA — requires password confirmation
 * POST /api/auth/2fa/disable
 */
router.post('/2fa/disable', auth.requireAuth, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'password is required' });

        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.totpEnabled) {
            return res.status(400).json({ error: '2FA is not enabled' });
        }

        if (!user.passwordHash || !(await auth.verifyPassword(password, user.passwordHash))) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        await db.users.update(user.id, {
            totpSecret: null,
            totpEnabled: false,
            totpPendingSecret: null,
            totpLastStep: null,
            recoveryCodes: null
        });

        res.json({ success: true, message: '2FA disabled successfully' });
    } catch (err) {
        console.error('2FA disable error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Get 2FA status for the current user
 * GET /api/auth/2fa/status
 */
router.get('/2fa/status', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ totpEnabled: !!user.totpEnabled });
    } catch (err) {
        console.error('2FA status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Admin: get 2FA status for any user
 * GET /api/auth/users/:id/2fa/status
 */
router.get('/users/:id/2fa/status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ totpEnabled: !!user.totpEnabled });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Admin: reset 2FA for a user — disables current secret and generates a new pending one
 * POST /api/auth/users/:id/2fa/reset
 * The active secret is never returned; the user must re-enroll via the new QR.
 */
router.post('/users/:id/2fa/reset', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.totpEnabled) {
            return res.status(400).json({ error: '2FA is not enabled for this user' });
        }

        const newSecret = auth.generateTotpSecret();
        const uri = auth.generateTotpUri(user.username, newSecret);
        const qrDataUrl = await QRCode.toDataURL(uri);

        await db.users.update(user.id, {
            totpSecret: null,
            totpEnabled: false,
            totpPendingSecret: auth.encryptSecret(newSecret),
            totpLastStep: null,
            recoveryCodes: null
        });

        res.json({ qrDataUrl, message: '2FA has been reset. User must re-enroll with the new QR code.' });
    } catch (err) {
        console.error('Admin 2FA reset error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Admin: start 2FA setup for any user — generate secret + QR code
 * GET /api/auth/users/:id/2fa/setup
 */
router.get('/users/:id/2fa/setup', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.totpEnabled) {
            return res.status(400).json({ error: '2FA is already enabled for this user' });
        }

        const secret = auth.generateTotpSecret();
        const uri = auth.generateTotpUri(user.username, secret);
        const qrDataUrl = await QRCode.toDataURL(uri);

        await db.users.update(user.id, { totpPendingSecret: auth.encryptSecret(secret) });

        res.json({ qrDataUrl, secret });
    } catch (err) {
        console.error('Admin 2FA setup error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Admin: confirm 2FA setup for any user
 * POST /api/auth/users/:id/2fa/enable
 */
router.post('/users/:id/2fa/enable', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'code is required' });

        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.totpEnabled) {
            return res.status(400).json({ error: '2FA is already enabled for this user' });
        }

        if (!user.totpPendingSecret) {
            return res.status(400).json({ error: 'No pending 2FA setup. Call GET /users/:id/2fa/setup first.' });
        }

        const plainPending = auth.decryptSecret(user.totpPendingSecret);
        const step = auth.matchTotpStep(String(code).trim(), plainPending);
        if (step === null) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        const { plaintext: recoveryCodes, hashed: hashedCodes } = await auth.generateRecoveryCodes();

        await db.users.update(user.id, {
            totpSecret: auth.encryptSecret(plainPending),
            totpEnabled: true,
            totpPendingSecret: null,
            totpLastStep: step,
            recoveryCodes: hashedCodes
        });

        res.json({ success: true, message: '2FA enabled successfully', recoveryCodes });
    } catch (err) {
        console.error('Admin 2FA enable error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Admin: force-disable 2FA for any user
 * DELETE /api/auth/users/:id/2fa
 */
router.delete('/users/:id/2fa', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.totpEnabled) {
            return res.status(400).json({ error: '2FA is not enabled for this user' });
        }

        await db.users.update(user.id, {
            totpSecret: null,
            totpEnabled: false,
            totpPendingSecret: null,
            totpLastStep: null,
            recoveryCodes: null
        });

        res.json({ success: true, message: '2FA disabled successfully' });
    } catch (err) {
        console.error('Admin 2FA disable error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Logout (client-side handles token removal)
 * POST /api/auth/logout
 */
router.post('/logout', (req, res) => {
    const payload = auth.verifyToken(auth.extractToken(req));
    if (payload) authTokens.revoke(payload);
    auth.clearAuthCookie(req, res);
    if (req.session) req.session.destroy(() => {});
    res.json({ success: true, message: 'Logged out successfully' });
});

// Exchange a valid API token for a browser cookie during migration.
router.post('/session', auth.requireAuth, (req, res) => {
    auth.setAuthCookie(req, res, auth.extractToken(req));
    res.json({ success: true });
});

/**
 * Get current user
 * GET /api/auth/me
 */
router.get('/me', auth.requireAuth, async (req, res) => {
    try {
        const user = await db.users.getById(req.user.id);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: user.id,
            username: user.username,
            role: user.role
        });
    } catch (err) {
        console.error('Error in /me:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Get all users (admin only)
 * GET /api/auth/users
 */
router.get('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const allUsers = await db.users.getAll();

        res.json(allUsers.map(publicUser));
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Create a new user (admin only)
 * POST /api/auth/users
 */
router.post('/users', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password || !role) {
            return res.status(400).json({ error: 'Username, password, and role are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        if (!['admin', 'viewer'].includes(role)) {
            return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
        }

        const passwordHash = await auth.hashPassword(password);
        const newUser = await db.users.create({
            username,
            passwordHash,
            role
        });

        res.status(201).json(newUser);
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Update a user (admin only)
 * PUT /api/auth/users/:id
 */
router.put('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password, role } = req.body;

        const updates = {};

        if (username) {
            updates.username = username;
        }

        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters' });
            }
            updates.passwordHash = await auth.hashPassword(password);
        }

        if (role) {
            if (!['admin', 'viewer'].includes(role)) {
                return res.status(400).json({ error: 'Role must be either "admin" or "viewer"' });
            }

            // Prevent removing admin role from the last admin
            const user = await db.users.getById(id);
            if (user && user.role === 'admin' && role !== 'admin') {
                const allUsers = await db.users.getAll();
                const adminCount = allUsers.filter(u => u.role === 'admin').length;
                if (adminCount <= 1) {
                    return res.status(400).json({ error: 'Cannot remove admin role from the last admin user' });
                }
            }

            updates.role = role;
        }

        const updatedUser = await db.users.update(id, updates);
        res.json(publicUser(updatedUser));
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

/**
 * Delete a user (admin only)
 * DELETE /api/auth/users/:id
 */
router.delete('/users/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        await db.users.delete(id);
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: err.message || 'Server error' });
    }
});

module.exports = router;
