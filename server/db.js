const fs = require('fs/promises');
const path = require('path');
const { existsSync, mkdirSync } = require('fs');

// Ensure data directory exists (sync is fine for startup)
const dataDir = path.join(__dirname, '..', 'data');
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.json');

// Initialize database structure
async function loadDb() {
  try {
    // Check if file exists (using fs.access is better for async, but we can catch ENOENT)
    try {
      const fileContent = await fs.readFile(dbPath, 'utf-8');
      const data = JSON.parse(fileContent);
      return {
        sources: data.sources || [],
        hiddenItems: data.hiddenItems || [],
        favorites: data.favorites || [],
        settings: data.settings || getDefaultSettings(),
        users: data.users || [],
        nextId: data.nextId || 1
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return default
        return {
          sources: [],
          hiddenItems: [],
          favorites: [],
          settings: getDefaultSettings(),
          users: [],
          nextId: 1
        };
      }
      throw error;
    }
  } catch (err) {
    console.error('Error loading database:', err);
    // Return safe default on error to prevent crashing, but log it
    return {
      sources: [],
      hiddenItems: [],
      favorites: [],
      settings: getDefaultSettings(),
      users: [],
      nextId: 1
    };
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
    forceTranscode: false,
    forceRemux: false,
    streamFormat: 'm3u8',
    epgRefreshInterval: '24'
  };
}

// Write lock to prevent concurrent writes from corrupting db.json
let writeQueue = Promise.resolve();

async function saveDb(data) {
  // Queue this write operation - each write waits for the previous one
  writeQueue = writeQueue.then(async () => {
    try {
      const jsonString = JSON.stringify(data, null, 2);
      await fs.writeFile(dbPath, jsonString);
    } catch (err) {
      console.error('Error writing database:', err);
      throw err;
    }
  }).catch(err => {
    console.error('Database write failed:', err);
  });

  return writeQueue;
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
    const db = await loadDb();
    const newSource = {
      id: db.nextId++,
      ...source,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.sources.push(newSource);
    await saveDb(db);
    return newSource;
  },

  async update(id, updates) {
    const db = await loadDb();
    const index = db.sources.findIndex(s => s.id === parseInt(id));
    if (index === -1) return null;

    db.sources[index] = {
      ...db.sources[index],
      ...updates,
      updated_at: new Date().toISOString()
    };
    await saveDb(db);
    return db.sources[index];
  },

  async delete(id) {
    const db = await loadDb();
    db.sources = db.sources.filter(s => s.id !== parseInt(id));
    // Also delete related hidden items
    db.hiddenItems = db.hiddenItems.filter(h => h.source_id !== parseInt(id));
    await saveDb(db);
  },

  async toggleEnabled(id) {
    const db = await loadDb();
    const source = db.sources.find(s => s.id === parseInt(id));
    if (source) {
      source.enabled = !source.enabled;
      source.updated_at = new Date().toISOString();
      await saveDb(db);
    }
    return source;
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
    const db = await loadDb();
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
      await saveDb(db);
    }
  },

  async show(sourceId, itemType, itemId) {
    const db = await loadDb();
    db.hiddenItems = db.hiddenItems.filter(
      h => !(h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId)
    );
    await saveDb(db);
  },

  async isHidden(sourceId, itemType, itemId) {
    const db = await loadDb();
    return db.hiddenItems.some(
      h => h.source_id === parseInt(sourceId) && h.item_type === itemType && h.item_id === itemId
    );
  },

  async bulkHide(items) {
    const db = await loadDb();
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
      await saveDb(db);
    }
    return true;
  },

  async bulkShow(items) {
    const db = await loadDb();
    const initialLength = db.hiddenItems.length;

    // Create a set of "signatures" for O(1) lookup of items to remove
    const toRemove = new Set(items.map(i => `${i.sourceId}:${i.itemType}:${i.itemId}`));

    db.hiddenItems = db.hiddenItems.filter(h =>
      !toRemove.has(`${h.source_id}:${h.item_type}:${h.item_id}`)
    );

    if (db.hiddenItems.length !== initialLength) {
      await saveDb(db);
    }
    return true;
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
    const db = await loadDb();
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
      await saveDb(db);
    }
    return true;
  },

  async remove(sourceId, itemId, itemType = 'channel') {
    const db = await loadDb();
    db.favorites = db.favorites.filter(
      f => !(f.source_id === parseInt(sourceId) && f.item_id === String(itemId) && f.item_type === itemType)
    );
    await saveDb(db);
    return true;
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
    const db = await loadDb();
    db.settings = { ...db.settings, ...newSettings };
    await saveDb(db);
    return db.settings;
  },

  async reset() {
    const db = await loadDb();
    db.settings = getDefaultSettings();
    await saveDb(db);
    return db.settings;
  }
};

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
    return db.users?.find(u => u.username === username);
  },

  async create(userData) {
    const db = await loadDb();
    if (!db.users) {
      db.users = [];
    }
    
    // Check if username already exists
    if (db.users.some(u => u.username === userData.username)) {
      throw new Error('Username already exists');
    }
    
    const newUser = {
      id: db.nextId++,
      username: userData.username,
      passwordHash: userData.passwordHash,
      role: userData.role || 'viewer',
      createdAt: new Date().toISOString()
    };
    
    db.users.push(newUser);
    await saveDb(db);
    
    // Return user without password hash
    const { passwordHash, ...userWithoutPassword } = newUser;
    return userWithoutPassword;
  },

  async update(id, updates) {
    const db = await loadDb();
    const userIndex = db.users?.findIndex(u => u.id === parseInt(id));
    
    if (userIndex === -1 || userIndex === undefined) {
      throw new Error('User not found');
    }
    
    // Check if username is being changed and if it already exists
    if (updates.username && updates.username !== db.users[userIndex].username) {
      if (db.users.some(u => u.username === updates.username)) {
        throw new Error('Username already exists');
      }
    }
    
    db.users[userIndex] = {
      ...db.users[userIndex],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    
    await saveDb(db);
    
    // Return user without password hash
    const { passwordHash, ...userWithoutPassword } = db.users[userIndex];
    return userWithoutPassword;
  },

  async delete(id) {
    const db = await loadDb();
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
    await saveDb(db);
    return true;
  },

  async count() {
    const db = await loadDb();
    return db.users?.length || 0;
  }
};

module.exports = { loadDb, saveDb, sources, hiddenItems, favorites, settings, users, getDefaultSettings };
