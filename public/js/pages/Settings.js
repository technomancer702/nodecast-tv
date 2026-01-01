/**
 * Settings Page Controller
 */

class SettingsPage {
    constructor(app) {
        this.app = app;
        this.tabs = document.querySelectorAll('.tabs .tab');
        this.tabContents = document.querySelectorAll('.tab-content');

        this.init();
    }

    init() {
        // Tab switching
        this.tabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Player settings
        this.initPlayerSettings();
        
        // User management (admin only)
        this.initUserManagement();
    }

    initPlayerSettings() {
        const arrowKeysToggle = document.getElementById('setting-arrow-keys');
        const overlayDurationInput = document.getElementById('setting-overlay-duration');
        const defaultVolumeSlider = document.getElementById('setting-default-volume');
        const volumeValueDisplay = document.getElementById('volume-value');
        const rememberVolumeToggle = document.getElementById('setting-remember-volume');
        const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
        const forceProxyToggle = document.getElementById('setting-force-proxy');
        const forceTranscodeToggle = document.getElementById('setting-force-transcode');
        const forceRemuxToggle = document.getElementById('setting-force-remux');

        // Load current settings
        if (this.app.player?.settings) {
            arrowKeysToggle.checked = this.app.player.settings.arrowKeysChangeChannel;
            overlayDurationInput.value = this.app.player.settings.overlayDuration;
            defaultVolumeSlider.value = this.app.player.settings.defaultVolume;
            volumeValueDisplay.textContent = this.app.player.settings.defaultVolume + '%';
            rememberVolumeToggle.checked = this.app.player.settings.rememberVolume;
            autoPlayNextToggle.checked = this.app.player.settings.autoPlayNextEpisode;
            if (forceProxyToggle) {
                forceProxyToggle.checked = this.app.player.settings.forceProxy || false;
            }
            if (forceTranscodeToggle) {
                forceTranscodeToggle.checked = this.app.player.settings.forceTranscode || false;
            }
            if (forceRemuxToggle) {
                forceRemuxToggle.checked = this.app.player.settings.forceRemux || false;
            }
        }

        // Arrow keys toggle
        arrowKeysToggle.addEventListener('change', () => {
            this.app.player.settings.arrowKeysChangeChannel = arrowKeysToggle.checked;
            this.app.player.saveSettings();
        });

        // Overlay duration
        overlayDurationInput.addEventListener('change', () => {
            const value = Math.min(30, Math.max(1, parseInt(overlayDurationInput.value) || 5));
            overlayDurationInput.value = value;
            this.app.player.settings.overlayDuration = value;
            this.app.player.saveSettings();
        });

        // Default volume slider
        defaultVolumeSlider?.addEventListener('input', () => {
            const value = parseInt(defaultVolumeSlider.value);
            volumeValueDisplay.textContent = value + '%';
            this.app.player.settings.defaultVolume = value;
            this.app.player.saveSettings();
        });

        // Remember volume toggle
        rememberVolumeToggle?.addEventListener('change', () => {
            this.app.player.settings.rememberVolume = rememberVolumeToggle.checked;
            this.app.player.saveSettings();
        });

        // Auto-play next episode toggle
        autoPlayNextToggle?.addEventListener('change', () => {
            this.app.player.settings.autoPlayNextEpisode = autoPlayNextToggle.checked;
            this.app.player.saveSettings();
        });

        // Force proxy toggle
        forceProxyToggle?.addEventListener('change', () => {
            this.app.player.settings.forceProxy = forceProxyToggle.checked;
            this.app.player.saveSettings();
        });

        // Force transcode toggle
        forceTranscodeToggle?.addEventListener('change', () => {
            this.app.player.settings.forceTranscode = forceTranscodeToggle.checked;
            this.app.player.saveSettings();
        });

        // Force remux toggle
        forceRemuxToggle?.addEventListener('change', () => {
            this.app.player.settings.forceRemux = forceRemuxToggle.checked;
            this.app.player.saveSettings();
        });

        // EPG refresh interval
        const epgRefreshSelect = document.getElementById('epg-refresh-interval');
        if (epgRefreshSelect && this.app.player?.settings) {
            // Load saved value from player settings
            epgRefreshSelect.value = this.app.player.settings.epgRefreshInterval || '24';

            // Save on change
            epgRefreshSelect.addEventListener('change', () => {
                this.app.player.settings.epgRefreshInterval = epgRefreshSelect.value;
                this.app.player.saveSettings();
            });
        }

        // Stream output format
        const streamFormatSelect = document.getElementById('setting-stream-format');
        if (streamFormatSelect && this.app.player?.settings) {
            // Load saved value from player settings
            streamFormatSelect.value = this.app.player.settings.streamFormat || 'm3u8';

            // Save on change
            streamFormatSelect.addEventListener('change', () => {
                this.app.player.settings.streamFormat = streamFormatSelect.value;
                this.app.player.saveSettings();
            });
        }
    }

    initUserManagement() {
        // User tab visibility is handled in show() method
        // when currentUser is available
        
        // Handle add user form
        const addUserForm = document.getElementById('add-user-form');
        if (addUserForm) {
            addUserForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const username = document.getElementById('new-username').value;
                const password = document.getElementById('new-password').value;
                const role = document.getElementById('new-role').value;
                
                try {
                    await API.users.create({ username, password, role });
                    alert('User created successfully!');
                    addUserForm.reset();
                    this.loadUsers();
                } catch (err) {
                    alert('Error creating user: ' + err.message);
                }
            });
        }
    }

    async loadUsers() {
        const userList = document.getElementById('user-list');
        if (!userList) return;
        
        try {
            const users = await API.users.getAll();
            
            if (users.length === 0) {
                userList.innerHTML = '<tr><td colspan="4" class="hint">No users found</td></tr>';
                return;
            }
            
            userList.innerHTML = users.map(user => `
                <tr>
                    <td>${user.username}</td>
                    <td><span class="badge badge-${user.role === 'admin' ? 'primary' : 'secondary'}">${user.role}</span></td>
                    <td>${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                        <button class="btn btn-sm btn-secondary" onclick="window.app.pages.settings.editUser(${user.id})">Edit</button>
                        <button class="btn btn-sm btn-error" onclick="window.app.pages.settings.deleteUser(${user.id}, '${user.username}')">Delete</button>
                    </td>
                </tr>
            `).join('');
        } catch (err) {
            console.error('Error loading users:', err);
            userList.innerHTML = '<tr><td colspan="4" class="hint">Error loading users</td></tr>';
        }
    }

    async editUser(userId) {
        const username = prompt('Enter new username (leave blank to keep current):');
        const password = prompt('Enter new password (leave blank to keep current):');
        const role = prompt('Enter role (admin or viewer, leave blank to keep current):');
        
        const updates = {};
        if (username) updates.username = username;
        if (password) updates.password = password;
        if (role) updates.role = role;
        
        if (Object.keys(updates).length === 0) {
            alert('No changes made');
            return;
        }
        
        try {
            await API.users.update(userId, updates);
            alert('User updated successfully!');
            this.loadUsers();
        } catch (err) {
            alert('Error updating user: ' + err.message);
        }
    }

    async deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }
        
        try {
            await API.users.delete(userId);
            alert('User deleted successfully!');
            this.loadUsers();
        } catch (err) {
            alert('Error deleting user: ' + err.message);
        }
    }

    switchTab(tabName) {
        this.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
        this.tabContents.forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));

        // Load content browser when switching to that tab
        if (tabName === 'content') {
            this.app.sourceManager.loadContentSources();
        }
        
        // Load users when switching to users tab
        if (tabName === 'users') {
            this.loadUsers();
        }
    }

    async show() {
        // Show users tab for admin
        if (this.app.currentUser && this.app.currentUser.role === 'admin') {
            const usersTab = document.getElementById('users-tab');
            if (usersTab) {
                usersTab.style.display = 'block';
            }
        }
        
        // Load sources when page is shown
        await this.app.sourceManager.loadSources();

        // Refresh ALL player settings from server
        if (this.app.player?.settings) {
            const s = this.app.player.settings;

            // Player settings
            const arrowKeysToggle = document.getElementById('setting-arrow-keys');
            const overlayDurationInput = document.getElementById('setting-overlay-duration');
            const defaultVolumeSlider = document.getElementById('setting-default-volume');
            const volumeValueDisplay = document.getElementById('volume-value');
            const rememberVolumeToggle = document.getElementById('setting-remember-volume');
            const autoPlayNextToggle = document.getElementById('setting-autoplay-next');
            const forceProxyToggle = document.getElementById('setting-force-proxy');
            const forceTranscodeToggle = document.getElementById('setting-force-transcode');
            const forceRemuxToggle = document.getElementById('setting-force-remux');
            const epgRefreshSelect = document.getElementById('epg-refresh-interval');
            const streamFormatSelect = document.getElementById('setting-stream-format');

            if (arrowKeysToggle) arrowKeysToggle.checked = s.arrowKeysChangeChannel;
            if (overlayDurationInput) overlayDurationInput.value = s.overlayDuration;
            if (defaultVolumeSlider) defaultVolumeSlider.value = s.defaultVolume;
            if (volumeValueDisplay) volumeValueDisplay.textContent = s.defaultVolume + '%';
            if (rememberVolumeToggle) rememberVolumeToggle.checked = s.rememberVolume;
            if (autoPlayNextToggle) autoPlayNextToggle.checked = s.autoPlayNextEpisode;
            if (forceProxyToggle) forceProxyToggle.checked = s.forceProxy || false;
            if (forceTranscodeToggle) forceTranscodeToggle.checked = s.forceTranscode || false;
            if (forceRemuxToggle) forceRemuxToggle.checked = s.forceRemux || false;
            if (epgRefreshSelect) epgRefreshSelect.value = s.epgRefreshInterval || '24';
            if (streamFormatSelect) streamFormatSelect.value = s.streamFormat || 'm3u8';
        }
    }

    hide() {
        // Page is hidden
    }
}

window.SettingsPage = SettingsPage;
