const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Create and initialize the SQLite database with schema and prepared statements.
 * @param {string} dbPath Path to SQLite file or ':memory:'.
 */
function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS parents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#2563eb',
      pairing_code TEXT UNIQUE,
      pairing_expires_at TEXT,
      device_token_hash TEXT UNIQUE,
      device_name TEXT,
      paired_at TEXT,
      last_seen_at TEXT,
      battery_level REAL,
      is_charging INTEGER,
      tracking_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      speed REAL,
      heading REAL,
      altitude REAL,
      battery_level REAL,
      is_charging INTEGER,
      source TEXT NOT NULL DEFAULT 'gps',
      recorded_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_locations_child_recorded
      ON locations(child_id, recorded_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_child_recorded_unique
      ON locations(child_id, recorded_at, lat, lng);
  `);

  const statements = {
    insertParent: db.prepare(`
      INSERT INTO parents (id, name, email, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    findParentByEmail: db.prepare(`
      SELECT id, name, email, password_hash, created_at
      FROM parents
      WHERE email = ?
    `),
    findParentById: db.prepare(`
      SELECT id, name, email, created_at
      FROM parents
      WHERE id = ?
    `),
    insertChild: db.prepare(`
      INSERT INTO children (id, parent_id, name, avatar_color, pairing_code, pairing_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listChildrenByParent: db.prepare(`
      SELECT
        c.id,
        c.parent_id,
        c.name,
        c.avatar_color,
        c.pairing_code,
        c.pairing_expires_at,
        c.device_name,
        c.paired_at,
        c.last_seen_at,
        c.battery_level,
        c.is_charging,
        c.tracking_active,
        c.created_at,
        (c.device_token_hash IS NOT NULL) AS is_paired
      FROM children c
      WHERE c.parent_id = ?
      ORDER BY c.created_at ASC
    `),
    findChildByIdAndParent: db.prepare(`
      SELECT
        id,
        parent_id,
        name,
        avatar_color,
        pairing_code,
        pairing_expires_at,
        device_name,
        paired_at,
        last_seen_at,
        battery_level,
        is_charging,
        tracking_active,
        created_at,
        (device_token_hash IS NOT NULL) AS is_paired
      FROM children
      WHERE id = ? AND parent_id = ?
    `),
    findChildByPairingCode: db.prepare(`
      SELECT
        c.id,
        c.parent_id,
        c.name,
        c.avatar_color,
        c.pairing_code,
        c.pairing_expires_at,
        p.name AS parent_name
      FROM children c
      JOIN parents p ON p.id = c.parent_id
      WHERE c.pairing_code = ?
    `),
    findChildByDeviceTokenHash: db.prepare(`
      SELECT
        c.id,
        c.parent_id,
        c.name,
        c.avatar_color,
        c.device_name,
        c.paired_at,
        c.last_seen_at,
        c.battery_level,
        c.is_charging,
        c.tracking_active,
        p.name AS parent_name
      FROM children c
      JOIN parents p ON p.id = c.parent_id
      WHERE c.device_token_hash = ?
    `),
    updateChildPairingCode: db.prepare(`
      UPDATE children
      SET pairing_code = ?, pairing_expires_at = ?
      WHERE id = ? AND parent_id = ?
    `),
    completeChildPairing: db.prepare(`
      UPDATE children
      SET device_token_hash = ?,
          device_name = ?,
          paired_at = ?,
          pairing_code = NULL,
          pairing_expires_at = NULL,
          tracking_active = 1
      WHERE id = ?
    `),
    updateChildTelemetry: db.prepare(`
      UPDATE children
      SET last_seen_at = ?,
          battery_level = COALESCE(?, battery_level),
          is_charging = COALESCE(?, is_charging),
          tracking_active = ?
      WHERE id = ?
    `),
    updateChildTrackingState: db.prepare(`
      UPDATE children
      SET tracking_active = ?,
          last_seen_at = ?
      WHERE id = ?
    `),
    deleteChild: db.prepare(`
      DELETE FROM children
      WHERE id = ? AND parent_id = ?
    `),
    insertLocation: db.prepare(`
      INSERT OR IGNORE INTO locations (
        child_id, lat, lng, accuracy, speed, heading, altitude,
        battery_level, is_charging, source, recorded_at, received_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getLatestLocationForChild: db.prepare(`
      SELECT id, child_id, lat, lng, accuracy, speed, heading, altitude,
             battery_level, is_charging, source, recorded_at, received_at
      FROM locations
      WHERE child_id = ?
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1
    `),
    getLocationsInRange: db.prepare(`
      SELECT id, child_id, lat, lng, accuracy, speed, heading, altitude,
             battery_level, is_charging, source, recorded_at, received_at
      FROM locations
      WHERE child_id = ?
        AND recorded_at >= ?
        AND recorded_at <= ?
      ORDER BY recorded_at ASC, id ASC
      LIMIT ?
    `),
  };

  return {
    db,
    statements,
    close() {
      db.close();
    },
  };
}

module.exports = { createDatabase };
