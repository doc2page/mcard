// src/store.js
import Database from 'better-sqlite3';

export function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');

  const select = db.prepare('SELECT data FROM state WHERE id = 1');
  const upsert = db.prepare(
    'INSERT INTO state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'
  );

  return {
    loadState() {
      const row = select.get();
      return row ? JSON.parse(row.data) : null;
    },
    saveState(state) {
      upsert.run(JSON.stringify(state));
    },
    close() { db.close(); },
  };
}
