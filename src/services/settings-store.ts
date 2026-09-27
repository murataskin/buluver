import { getDb } from './database.js';

/**
 * SettingsStore manages persistent key-value configuration
 * (e.g. active embedding model, chunking parameters, LLM credentials).
 */
export const SettingsStore = {
  get(key: string, defaultValue = ''): string {
    const database = getDb();
    try {
      const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
      return row ? String(row.value) : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  set(key: string, value: string): void {
    const database = getDb();
    database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
  },

  delete(key: string): void {
    const database = getDb();
    database.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  },

  getAll(): Record<string, string> {
    const database = getDb();
    try {
      const rows = database.prepare('SELECT key, value FROM app_settings').all() as any[];
      const map: Record<string, string> = {};
      for (const r of rows) {
        map[String(r.key)] = String(r.value);
      }
      return map;
    } catch {
      return {};
    }
  }
};
