/**
 * Auth Manager - Frontend authentication state management
 */

const Auth = {
    currentUser: null,

    /**
     * Initialize auth - check setup status and current user
     */
    async init() {
        try {
            // Check if setup is required
            const setupStatus = await API.auth.checkSetup();
            if (setupStatus.setupRequired) {
                this.showSetup();
                return false;
            }

            // Check if user is logged in (cookie is sent automatically)
            try {
                this.currentUser = await API.auth.me();
                return true;
            } catch (error) {
                this.showLogin();
                return false;
            }
        } catch (error) {
            console.error('Auth initialization failed:', error);
            // On any error, show login (don't loop)
            this.showLogin();
            return false;
        }
    },

    /**
     * Show setup screen
     */
    showSetup() {
        document.getElementById('setup-screen').classList.add('active');
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app').classList.remove('active');
    },

    /**
     * Show login screen
     */
    showLogin() {
        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('app').classList.remove('active');
    },

    /**
     * Show main app
     */
    showApp() {
        document.getElementById('setup-screen').classList.remove('active');
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app').classList.add('active');
        
        // Hide settings tab if viewer
        if (!this.isAdmin()) {
            const settingsLink = document.querySelector('[data-page="settings"]');
            if (settingsLink) {
                settingsLink.parentElement.style.display = 'none';
            }
        }
    },

    /**
     * Setup initial admin user
     */
    async setup(username, password) {
        try {
            const result = await API.auth.setup(username, password);
            this.currentUser = result.user;
            this.showApp();
            return true;
        } catch (error) {
            throw error;
        }
    },

    /**
     * Login user
     */
    async login(username, password) {
        try {
            const result = await API.auth.login(username, password);
            this.currentUser = result.user;
            this.showApp();
            return true;
        } catch (error) {
            throw error;
        }
    },

    /**
     * Logout user
     */
    async logout() {
        try {
            await API.auth.logout();
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            this.currentUser = null;
            this.showLogin();
        }
    },

    /**
     * Check if current user is admin
     */
    isAdmin() {
        return this.currentUser && this.currentUser.role === 'admin';
    },

    /**
     * Check if current user is viewer
     */
    isViewer() {
        return this.currentUser && this.currentUser.role === 'viewer';
    },

    /**
     * Get current user
     */
    getCurrentUser() {
        return this.currentUser;
    }
};
