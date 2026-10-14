const fs = require('fs/promises');
const path = require('path');
const { existsSync, mkdirSync } = require('fs');

// Ensure data directory exists (sync is fine for startup)
const dataDir = process.env.NODECAST_DATA_DIR
  ? path.resolve(process.env.NODECAST_DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.json');

function getEmptyDb() {
  return {
    sources: [],
    hiddenItems: [],
    favorites: [],
    settings: getDefaultSettings(),
    users: [],
    nextId: 1
  };
}

// Writes use this strict reader so a damaged or temporarily unreadable file
// cannot be replaced with an empty database after an apparently successful edit.
async function readDbForMutation() {
  try {
    const fileContent = await fs.readFile(dbPath, 'utf-8');
    const data = JSON.parse(fileContent);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid database document');
    }
    let nextId = Number.isSafeInteger(data.nextId) && data.nextId > 0 ? data.nextId : 1;
    for (const records of [data.sources, data.hiddenItems, data.favorites, data.users]) {
      if (!records) continue;
      if (!Array.isArray(records)) throw new Error('Invalid database collection');
      for (const record of records) {
        const id = Number(record.id);
        if (Number.isSafeInteger(id) && id >= nextId) nextId = id + 1;
      }
    }
    return {
      ...data,
      sources: data.sources || [],
      hiddenItems: data.hiddenItems || [],
      favorites: data.favorites || [],
      settings: data.settings || getDefaultSettings(),
      users: data.users || [],
      nextId
    };
  } catch (error) {
    if (error.code === 'ENOENT') return getEmptyDb();
    throw error;
  }
}

// Preserve the existing read-only fallback behavior. Mutations never use it.
async function loadDb() {
  try {
    return await readDbForMutation();
  } catch (err) {
    console.error('Error loading database:', err);
    return getEmptyDb();
  }
}

// Default settings
function getDefaultSettings() {
  return {
    arrowKeysChangeChannel: true,
    overlayDuration: 5,
    defaultVolume: 80,
    rememberVolume: true,
    lastVolume: 80,
    autoPlayNextEpisode: false,
    forceProxy: false,
    forceTranscode: false, // Force Audio Transcode
    forceVideoTranscode: false, // Force Video Transcode
    forceRemux: false,
    autoTranscode: true,
    streamFormat: 'm3u8',
    epgRefreshInterval: '24',
    // User-Agent settings
    userAgentPreset: 'chrome',    // chrome | vlc | tivimate | custom
    userAgentCustom: '',          // Custom UA string when preset is 'custom'
    // Transcoding settings
    hwEncoder: 'auto',            // auto | nvenc | amf | qsv | vaapi | software
    maxResolution: '1080p',       // 4k | 1080p | 720p | 480p
    quality: 'medium',            // high | medium | low
    audioMixPreset: 'auto',       // auto | itu | night | cinematic | passthrough
    // Probe cache settings  
    probeCacheTTL: 300,           // 5 minutes for URL probe cache
    seriesProbeCacheDays: 7,       // 7 days for series episode probe cache
    // Upscaling settings
    upscaleEnabled: false,
    upscaleMethod: 'hardware',    // hardware | software
    upscaleTarget: '1080p'        // 1080p | 4k | 720p
  };
}

// User-Agent presets
const USER_AGENT_PRESETS = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  vlc: 'VLC/3.0.20 LibVLC/3.0.20',
  tivimate: 'TiviMate/4.7.0',
};

function getUserAgent(settings) {
  if (settings.userAgentPreset === 'custom' && settings.userAgentCustom) {
    return settings.userAgentCustom;
  }
  return USER_AGENT_PRESETS[settings.userAgentPreset] || USER_AGENT_PRESETS.chrome;
}

// Queue the entire read-modify-write transaction, not only the file write.
let mutationQueue = Promise.resolve();
const tmpPath = dbPath + '.tmp';

async function writeDb(data) {
  try {
    const jsonString = JSON.stringify(data, null, 2);
    // Rename keeps readers from observing a partially written JSON file.
    await fs.writeFile(tmpPath, jsonString);
    // Windows can briefly lock the destination while another request reads it.
    // Retry only transient rename errors; persistent failures still reach the caller.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmpPath, dbPath);
        break;
      } catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  } catch (err) {
    console.error('Error writing database:', err);
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function queueMutation(operation) {
  const result = mutationQueue.then(operation);
  // A rejected operation must not poison later writes, but its own caller
  // must receive the error instead of an incorrect success response.
  mutationQueue = result.catch(() => {});
  return result;
}

async function mutateDb(mutator) {
  return queueMutation(async () => {
    const data = await readDbForMutation();
    let changed = false;
    const result = await mutator(data, () => { changed = true; });
    if (changed) await writeDb(data);
    return result;
  });
}

// Full-document saves remain serialized for compatibility with external callers.
function saveDb(data) {
  return queueMutation(() => writeDb(data));
}

// Source CRUD operations
const sources = {
  async getAll() {
    const db = await loadDb();
    return db.sources;
  },

  async getById(id) {
    const db = await loadDb();
    return db.sources.find(s => s.id === parseInt(id));
  },

  async getByType(type) {
    const db = await loadDb();
    return db.sources.filter(s => s.type === type && s.enabled);
  },

  async create(source) {
    return mutateDb((db, markChanged) => {
      const newSource = {
        id: db.nextId++,
        ...source,
        enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.sources.push(newSource);
      markChanged();
      return newSource;
    });
  },

  async update(id, updates) {
    return mutateDb((db, markChanged) => {
      const index = db.sources.findIndex(s => s.id === parseInt(id));
      if (index === -1) return null;

      db.sources[index] = {
        ...db.sources[index],
        ...updates,
        updated_at: new Date().toISOString()
      };
      markChanged();
      return db.sources[index];
    });
  },

  async delete(id) {
    return mutateDb((db, markChanged) => {
      db.sources = db.sources.filter(s => s.id !== parseInt(id));
      // Also delete related hidden items and favorites
      db.hiddenItems = db.hiddenItems.filter(h => h.source_id !== parseInt(id));
      db.favorites = db.favorites.filter(f => f.source_id !== parseInt(id));
      markChanged();
    });
  },

  async toggleEnabled(id) {
    return mutateDb((db, markChanged) => {
      const source = db.sources.find(s => s.id === parseInt(id));
      if (source) {
        source.enabled = !source.enabled;
        source.updated_at = new Date().toISOString();
        markChanged();
      }
      return source;
    });
  }
};

// Hidden items operations
const hiddenItems = {
  async getAll(sourceId = null) {
    const db = await loadDb();
    if (sourceId) {
      return db.hiddenItems.filter(h => h.source_id === parseInt(sourceId));
    }
    return db.hiddenItems;
  },

  async hide(sourceId, itemType, itemId) {
    return mutateDb((db, markChanged) => {
      // Check if already hidden
      const exists = db.hiddenItems.find(
        h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
      );
      if (!exists) {
        db.hiddenItems.push({
          id: db.nextId++,
          source_id: parseInt(sourceId),
          item_type: itemType,
          item_id: itemId
        });
        markChanged();
      }
    });
  },

  async show(sourceId, itemType, itemId) {
    return mutateDb((db, markChanged) => {
      db.hiddenItems = db.hiddenItems.filter(
        h => !(h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId)
      );
      markChanged();
    });
  },

  async isHidden(sourceId, itemType, itemId) {
    const db = await loadDb();
    return db.hiddenItems.some(
      h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
    );
  },

  async bulkHide(items) {
    return mutateDb((db, markChanged) => {
      let modified = false;

      items.forEach(item => {
        const { sourceId, itemType, itemId } = item;
        const exists = db.hiddenItems.find(
          h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
        );

        if (!exists) {
          db.hiddenItems.push({
            id: db.nextId++,
            source_id: parseInt(sourceId),
            item_type: itemType,
            item_id: itemId
          });
          modified = true;
        }
      });

      if (modified) {
        markChanged();
      }
      return true;
    });
  },

  async bulkShow(items) {
    return mutateDb((db, markChanged) => {
      const initialLength = db.hiddenItems.length;

      // Create a set of "signatures" for O(1) lookup of items to remove
      const toRemove = new Set(items.map(i => `${i.sourceId}:${i.itemType}:${i.itemId}`));

      db.hiddenItems = db.hiddenItems.filter(h =>
        !toRemove.has(`${h.source_id}:${h.item_type}:${h.item_id}`)
      );

      if (db.hiddenItems.length !== initialLength) {
        markChanged();
      }
      return true;
    });
  }
};

// Favorites operations
const favorites = {
  async getAll(sourceId = null, itemType = null) {
    const db = await loadDb();
    let results = db.favorites;
    if (sourceId) {
      results = results.filter(f => f.source_id === parseInt(sourceId));
    }
    if (itemType) {
      results = results.filter(f => f.item_type === itemType);
    }
    return results;
  },

  async add(sourceId, itemId, itemType = 'channel') {
    return mutateDb((db, markChanged) => {
      // Check if already favorited
      const exists = db.favorites.find(
        f => f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType
      );
      if (!exists) {
        db.favorites.push({
          id: db.nextId++,
          source_id: parseInt(sourceId),
          item_id: String(itemId),
          item_type: itemType, // 'channel', 'movie', 'series'
          created_at: new Date().toISOString()
        });
        markChanged();
      }
      return true;
    });
  },

  async remove(sourceId, itemId, itemType = 'channel') {
    return mutateDb((db, markChanged) => {
      db.favorites = db.favorites.filter(
        f => !(f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType)
      );
      markChanged();
      return true;
    });
  },

  async isFavorite(sourceId, itemId, itemType = 'channel') {
    const db = await loadDb();
    return db.favorites.some(
      f => f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType
    );
  }
};

// Settings operations
const settings = {
  async get() {
    const db = await loadDb();
    return { ...getDefaultSettings(), ...db.settings };
  },

  async update(newSettings) {
    return mutateDb((db, markChanged) => {
      db.settings = { ...db.settings, ...newSettings };
      markChanged();
      return db.settings;
    });
  },

  async reset() {
    return mutateDb((db, markChanged) => {
      db.settings = getDefaultSettings();
      markChanged();
      return db.settings;
    });
  }
};

// Preserve display spelling and IDs while preventing new case-only account collisions.
function usernameKey(username) { return typeof username === 'string' ? username.toLowerCase() : null; }
function validateUsername(username) {
  if (typeof username !== 'string' || !username.trim() || username.length > 64 || /[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('Username must be a non-empty string of at most 64 characters');
  }
}

// User operations
const users = {
  async getAll() {
    const db = await loadDb();
    return db.users || [];
  },

  async getById(id) {
    const db = await loadDb();
    return db.users?.find(u => u.id === parseInt(id));
  },

  async getByUsername(username) {
    const db = await loadDb();
    const key = usernameKey(username);
    if (key === null) return undefined;
    const matches = (db.users || []).filter(user => usernameKey(user.username) === key);
    if (matches.length === 1) return matches[0];
    // Legacy case-only duplicates keep their exact-spelling login. Never guess between accounts.
    const exact = matches.filter(user => user.username === username);
    return exact.length === 1 ? exact[0] : undefined;
  },

  async getByOidcId(oidcId) {
    const db = await loadDb();
    return db.users?.find(u => u.oidcId === oidcId);
  },

  async getByEmail(email) {
    const db = await loadDb();
    return db.users?.find(u => u.email === email);
  },

  async create(userData, { initialSetup = false } = {}) {
    return mutateDb((db, markChanged) => {
      if (!db.users) {
        db.users = [];
      }

      // Check if username already exists
      if (initialSetup && db.users.length) throw new Error('Setup already completed');
      validateUsername(userData.username);
      if (db.users.some(u => usernameKey(u.username) === usernameKey(userData.username))) {
        throw new Error('Username already exists');
      }

      const newUser = {
        id: db.nextId++,
        username: userData.username,
        // For OIDC users, passwordHash is optional
        passwordHash: userData.passwordHash || null,
        role: userData.role || 'viewer',
        oidcId: userData.oidcId || null,
        email: userData.email || null,
        createdAt: new Date().toISOString()
      };

      db.users.push(newUser);
      markChanged();

      // Return user without password hash
      const { passwordHash, ...userWithoutPassword } = newUser;
      return userWithoutPassword;
    });
  },

  async update(id, updates) {
    return mutateDb((db, markChanged) => {
      const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

      if (userIndex === -1 || userIndex === undefined) {
        throw new Error('User not found');
      }

      // Existing case-only duplicates can still change passwords/roles without a rename.
      if (Object.hasOwn(updates, 'username')) validateUsername(updates.username);
      if (updates.username && updates.username !== db.users[userIndex].username) {
        if (db.users.some((u, index) => index !== userIndex && usernameKey(u.username) === usernameKey(updates.username))) {
          throw new Error('Username already exists');
        }
      }

      if (db.users[userIndex].role === 'admin' && updates.role && updates.role !== 'admin') {
        if (db.users.filter(user => user.role === 'admin').length <= 1) {
          throw new Error('Cannot remove admin role from the last admin user');
        }
      }

      db.users[userIndex] = {
        ...db.users[userIndex],
        ...updates,
        authVersion: updates.passwordHash ? (db.users[userIndex].authVersion || 0) + 1 : (db.users[userIndex].authVersion || 0),
        updatedAt: new Date().toISOString()
      };

      markChanged();

      // Return user without password hash
      const { passwordHash, ...userWithoutPassword } = db.users[userIndex];
      return userWithoutPassword;
    });
  },

  /**
   * Atomically record a used TOTP time step. Returns false if this step (or a
   * later one) was already used, so each code can only log in once.
   */
  async consumeTotpStep(id, step) {
    return mutateDb((db, markChanged) => {
      const user = db.users?.find(u => u.id === parseInt(id));
      if (!user || !user.totpEnabled || !Number.isInteger(step)) return false;
      if (Number.isInteger(user.totpLastStep) && step <= user.totpLastStep) return false;
      user.totpLastStep = step;
      markChanged();
      return true;
    });
  },

  /**
   * Atomically remove a recovery code by its stored hash. Returns false if it
   * was already consumed (e.g. by a concurrent request).
   */
  async consumeRecoveryCode(id, hash) {
    return mutateDb((db, markChanged) => {
      const user = db.users?.find(u => u.id === parseInt(id));
      const index = user?.totpEnabled && Array.isArray(user.recoveryCodes) ? user.recoveryCodes.indexOf(hash) : -1;
      if (!hash || index === -1) return false;
      user.recoveryCodes[index] = null;
      markChanged();
      return true;
    });
  },

  async delete(id) {
    return mutateDb((db, markChanged) => {
      const userIndex = db.users?.findIndex(u => u.id === parseInt(id));

      if (userIndex === -1 || userIndex === undefined) {
        throw new Error('User not found');
      }

      // Prevent deleting the last admin
      const user = db.users[userIndex];
      if (user.role === 'admin') {
        const adminCount = db.users.filter(u => u.role === 'admin').length;
        if (adminCount <= 1) {
          throw new Error('Cannot delete the last admin user');
        }
      }

      db.users.splice(userIndex, 1);
      markChanged();
      return true;
    });
  },

  async count() {
    const db = await loadDb();
    return db.users?.length || 0;
  }
};

module.exports = { loadDb, saveDb, checkHealth: readDbForMutation, sources, hiddenItems, favorites, settings, users, getDefaultSettings, getUserAgent, USER_AGENT_PRESETS };
