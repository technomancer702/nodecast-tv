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
        nextId: data.nextId || 1
      };
    } catch (error) {
      if (error.code === 'ENOENT') {
        // File doesn't exist, return default
        return {
          sources: [],
          hiddenItems: [],
          favorites: [],
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
      nextId: 1
    };
  }
}

async function saveDb(data) {
  await fs.writeFile(dbPath, JSON.stringify(data, null, 2));
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

module.exports = { sources, hiddenItems, favorites };
