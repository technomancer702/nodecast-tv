const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const db = require('../db');
const auth = require('../auth');

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

// Configure OIDC Strategy
auth.configureOidcStrategy(
    async (oidcId) => await db.users.getByOidcId(oidcId),
    async (email) => await db.users.getByEmail(email),
    async (userData) => await db.users.create(userData)
);

/**
 * Start OIDC Login
 * GET /api/auth/oidc/login
 */
router.get('/oidc/login', auth.passport.authenticate('openidconnect'));

/**
 * OIDC Callback
 * GET /api/auth/oidc/callback
 */
router.get('/oidc/callback',
    auth.passport.authenticate('openidconnect', { session: false, failureRedirect: '/login.html?error=SSO+Failed' }),
    (req, res) => {
        // Successful authentication
        const token = auth.generateToken(req.user);

        // Redirect to hompage with token
        res.redirect(`/?token=${token}`);
    }
);

/**
 * Check if initial setup is required
 * GET /api/auth/setup-required
 */
router.get('/setup-required', async (req, res) => {
    try {
        const userCount = await db.users.count();
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
router.post('/setup', async (req, res) => {
    try {
        const userCount = await db.users.count();

        // Check if setup already done
        if (userCount > 0) {
            return res.status(400).json({ error: 'Setup already completed' });
        }

        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Create admin user
        const passwordHash = await auth.hashPassword(password);
        const adminUser = await db.users.create({
            username,
            passwordHash,
            role: 'admin'
        });

        // Generate token for immediate login
        const token = auth.generateToken(adminUser);

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
router.post('/login', (req, res, next) => {
    auth.passport.authenticate('local', { session: false }, async (err, user, info) => {
        if (err) {
            console.error('Login error:', err);
            return res.status(500).json({ error: 'Server error' });
        }

        if (!user) {
            return res.status(401).json({ error: info?.message || 'Invalid credentials' });
        }

        // If 2FA is enabled, issue a short-lived temp token instead of the full JWT
        const fullUser = await db.users.getById(user.id);
        if (fullUser && fullUser.totpEnabled) {
            const tempToken = auth.generateTempToken(user.id);
            return res.json({ requires2fa: true, tempToken });
        }

        const token = auth.generateToken(user);
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
router.post('/2fa/verify', async (req, res) => {
    try {
        const { tempToken, code } = req.body;

        if (!tempToken || !code) {
            return res.status(400).json({ error: 'tempToken and code are required' });
        }

        const payload = auth.verifyTempToken(tempToken);
        if (!payload) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }

        const user = await db.users.getById(payload.id);
        if (!user || !user.totpEnabled || !user.totpSecret) {
            return res.status(401).json({ error: 'Invalid request' });
        }

        if (!auth.verifyTotpToken(String(code), user.totpSecret)) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        const token = auth.generateToken(user);
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

        // Store the pending secret (not yet enabled until verified)
        await db.users.update(user.id, { totpPendingSecret: secret });

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

        if (!auth.verifyTotpToken(String(code), user.totpPendingSecret)) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        await db.users.update(user.id, {
            totpSecret: user.totpPendingSecret,
            totpEnabled: true,
            totpPendingSecret: null
        });

        res.json({ success: true, message: '2FA enabled successfully' });
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
            totpPendingSecret: null
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
 * Admin: view QR code for a user with 2FA already enabled
 * GET /api/auth/users/:id/2fa/qr
 */
router.get('/users/:id/2fa/qr', auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
        const user = await db.users.getById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (!user.totpEnabled || !user.totpSecret) {
            return res.status(400).json({ error: '2FA is not enabled for this user' });
        }

        const uri = auth.generateTotpUri(user.username, user.totpSecret);
        const qrDataUrl = await QRCode.toDataURL(uri);

        res.json({ qrDataUrl, secret: user.totpSecret });
    } catch (err) {
        console.error('Admin 2FA QR error:', err);
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

        await db.users.update(user.id, { totpPendingSecret: secret });

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

        if (!auth.verifyTotpToken(String(code), user.totpPendingSecret)) {
            return res.status(401).json({ error: 'Invalid authenticator code' });
        }

        await db.users.update(user.id, {
            totpSecret: user.totpPendingSecret,
            totpEnabled: true,
            totpPendingSecret: null
        });

        res.json({ success: true, message: '2FA enabled successfully' });
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
            totpPendingSecret: null
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
    // With JWT, logout is handled client-side by removing the token
    // This endpoint exists for consistency and future server-side token blacklisting
    res.json({ success: true, message: 'Logged out successfully' });
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

        const users = allUsers.map(u => {
            const { passwordHash, totpSecret, totpPendingSecret, ...safe } = u;
            return safe;
        });

        res.json(users);
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
        res.json(updatedUser);
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
