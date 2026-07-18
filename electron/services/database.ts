import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  let dbPath: string;
  try {
    // Attempt to get userData directory. Will throw if app is not yet initialized.
    const userDataPath = app.getPath('userData');
    if (!fs.existsSync(userDataPath)) {
      fs.mkdirSync(userDataPath, { recursive: true });
    }
    dbPath = path.join(userDataPath, 'izbul_reborn.db');
  } catch {
    // Fallback for tests or before app ready
    dbPath = path.join(process.cwd(), 'izbul_reborn.db');
  }

  db = new DatabaseSync(dbPath);
  
  // Set journal mode to WAL for high-concurrency performance
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA mmap_size = 268435456;'); // 256MB

  // Schema migration: if old table `document_index` exists (from better-sqlite3 schema), drop the old tables
  try {
    const oldTableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_index'").get();
    if (oldTableCheck) {
      console.log('Old schema detected (document_index table). Dropping old tables to recreate with external-content FTS5 schema...');
      db.exec('DROP TABLE IF EXISTS folders;');
      db.exec('DROP TABLE IF EXISTS files;');
      db.exec('DROP TABLE IF EXISTS document_index;');
    }
  } catch (err) {
    console.error('Failed to run migration check:', err);
  }

  // Initialize tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      ext TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT CHECK( status IN ('pending', 'indexed', 'failed') ) NOT NULL DEFAULT 'pending',
      error_msg TEXT,
      indexed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_files_path_prefix ON files(path);

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
      filename,
      body,
      content = 'files',
      content_rowid = 'id',
      tokenize = "unicode61 remove_diacritics 2"
    );
  `);

  return db;
}

export interface FileRecord {
  path: string;
  filename: string;
  extension: string;
  mtime: number;
  size: number;
  status: 'pending' | 'indexed' | 'failed';
  error_msg?: string;
  last_indexed_at?: number;
}

export interface FolderRecord {
  path: string;
  added_at: number;
}

export interface SearchResult {
  path: string;
  filename: string;
  snippet: string;
}

export const DatabaseService = {
  // Folder Operations
  getFolders(): FolderRecord[] {
    const database = getDb();
    const rows = database.prepare('SELECT path, added_at FROM folders ORDER BY added_at ASC').all() as unknown as FolderRecord[];
    return rows;
  },

  addFolder(folderPath: string): void {
    const database = getDb();
    database.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, Date.now());
  },

  removeFolder(folderPath: string): void {
    const database = getDb();
    // Clean files belonging to the directory
    const like = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep;
    const rows = database.prepare(`SELECT id FROM files WHERE path LIKE ? || '%'`).all(like) as { id: number }[];
    
    database.exec('BEGIN IMMEDIATE;');
    try {
      const delFile = database.prepare('DELETE FROM files WHERE id = ?');
      const delFts = database.prepare('DELETE FROM files_fts WHERE rowid = ?');
      for (const r of rows) {
        delFts.run(r.id);
        delFile.run(r.id);
      }
      database.prepare('DELETE FROM folders WHERE path = ?').run(folderPath);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  // File Operations
  getFile(filePath: string): FileRecord | undefined {
    const database = getDb();
    const row = database.prepare('SELECT path, filename, ext as extension, mtime, size, status, error_msg, indexed_at as last_indexed_at FROM files WHERE path = ?').get(filePath) as any;
    if (!row) return undefined;
    return {
      path: row.path,
      filename: row.filename,
      extension: row.extension,
      mtime: Number(row.mtime),
      size: Number(row.size),
      status: row.status,
      error_msg: row.error_msg || undefined,
      last_indexed_at: Number(row.last_indexed_at)
    };
  },

  getAllFiles(): FileRecord[] {
    const database = getDb();
    const rows = database.prepare('SELECT path, filename, ext as extension, mtime, size, status, error_msg, indexed_at as last_indexed_at FROM files').all() as any[];
    return rows.map(row => ({
      path: row.path,
      filename: row.filename,
      extension: row.extension,
      mtime: Number(row.mtime),
      size: Number(row.size),
      status: row.status,
      error_msg: row.error_msg || undefined,
      last_indexed_at: Number(row.last_indexed_at)
    }));
  },

  upsertFile(record: FileRecord): void {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(record.path) as { id: number } | undefined;
    const now = Date.now();
    database.exec('BEGIN IMMEDIATE;');
    try {
      let id: number;
      if (existing) {
        id = existing.id;
        database.prepare(`
          UPDATE files SET filename=?, ext=?, mtime=?, size=?, status=?, error_msg=?, indexed_at=? WHERE id=?
        `).run(
          record.filename,
          record.extension,
          record.mtime,
          record.size,
          record.status,
          record.error_msg || null,
          record.last_indexed_at || now,
          id
        );
        database.prepare('DELETE FROM files_fts WHERE rowid = ?').run(id);
      } else {
        database.prepare(`
          INSERT INTO files (path, filename, ext, mtime, size, status, error_msg, indexed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          record.path,
          record.filename,
          record.extension,
          record.mtime,
          record.size,
          record.status,
          record.error_msg || null,
          record.last_indexed_at || now
        );
        id = Number(database.prepare("SELECT last_insert_rowid() AS id").get()!["id"]);
      }
      database.prepare('INSERT INTO files_fts (rowid, filename, body) VALUES (?, ?, ?)').run(id, record.filename, '');
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  removeFile(filePath: string): void {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as { id: number } | undefined;
    if (!existing) return;
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('DELETE FROM files_fts WHERE rowid = ?').run(existing.id);
      database.prepare('DELETE FROM files WHERE id = ?').run(existing.id);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  // FTS5 Virtual Index Operations
  updateIndex(filePath: string, content: string): void {
    const database = getDb();
    const existing = database.prepare('SELECT id, filename FROM files WHERE path = ?').get(filePath) as { id: number, filename: string } | undefined;
    if (!existing) return;
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('UPDATE files SET body = ? WHERE id = ?').run(content, existing.id);
      database.prepare('DELETE FROM files_fts WHERE rowid = ?').run(existing.id);
      database.prepare('INSERT INTO files_fts (rowid, filename, body) VALUES (?, ?, ?)').run(existing.id, existing.filename, content);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  // Batch operations for performance optimization
  upsertFilesBatch(records: any[]): void {
    if (records.length === 0) return;
    const database = getDb();
    const findStmt = database.prepare("SELECT id FROM files WHERE path = ?");
    const updateStmt = database.prepare(
      `UPDATE files SET filename=?, ext=?, mtime=?, size=?, body=?, status=?, indexed_at=? WHERE id=?`
    );
    const insertStmt = database.prepare(
      `INSERT INTO files (path, filename, ext, mtime, size, body, status, indexed_at) VALUES (?,?,?,?,?,?,?,?)`
    );
    const deleteFtsStmt = database.prepare(`DELETE FROM files_fts WHERE rowid = ?`);
    const insertFtsStmt = database.prepare(
      `INSERT INTO files_fts (rowid, filename, body) VALUES (?,?,?)`
    );

    database.exec("BEGIN IMMEDIATE;");
    try {
      const now = Date.now();
      for (const r of records) {
        const existing = findStmt.get(r.path) as { id: number } | undefined;
        let id: number;
        if (existing) {
          id = existing.id;
          updateStmt.run(r.filename, r.ext, r.mtimeMs, r.size, r.body, 'indexed', now, id);
          deleteFtsStmt.run(id);
        } else {
          insertStmt.run(r.path, r.filename, r.ext, r.mtimeMs, r.size, r.body, 'indexed', now);
          id = Number(database.prepare("SELECT last_insert_rowid() AS id").get()!["id"]);
        }
        insertFtsStmt.run(id, r.filename, r.body);
      }
      database.exec("COMMIT;");
    } catch (err) {
      database.exec("ROLLBACK;");
      throw err;
    }
  },

  pruneMissing(rootPath: string, keepPaths: Set<string>): number {
    const database = getDb();
    const like = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    const rows = database
      .prepare(`SELECT id, path FROM files WHERE path LIKE ? || '%'`)
      .all(like) as { id: number; path: string }[];

    const toDelete = rows.filter((r) => !keepPaths.has(r.path));
    if (toDelete.length === 0) return 0;

    const delFile = database.prepare("DELETE FROM files WHERE id = ?");
    const delFts = database.prepare("DELETE FROM files_fts WHERE rowid = ?");
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const r of toDelete) {
        delFts.run(r.id);
        delFile.run(r.id);
      }
      database.exec("COMMIT;");
    } catch (err) {
      database.exec("ROLLBACK;");
      throw err;
    }
    return toDelete.length;
  },

  getKnownFileStats(rootPath: string): Map<string, { mtime: number; size: number }> {
    const database = getDb();
    const like = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    const rows = database
      .prepare(`SELECT path, mtime, size FROM files WHERE path LIKE ? || '%'`)
      .all(like) as { path: string; mtime: number; size: number }[];
    const map = new Map<string, { mtime: number; size: number }>();
    for (const r of rows) {
      map.set(r.path, { mtime: Number(r.mtime), size: Number(r.size) });
    }
    return map;
  },

  // Helper to parse complex query syntax securely for FTS5 MATCH
  parseSearchQuery(query: string): string {
    let quoteCount = (query.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      query += '"';
    }

    const tokenRegex = /(-?"[^"]+")|(-?[^\s"()]+)|(OR|AND|NOT|\(|\))/gi;
    const tokens: string[] = [];
    let match;
    while ((match = tokenRegex.exec(query)) !== null) {
      tokens.push(match[0]);
    }

    if (tokens.length === 0) return '';

    const parsedTokens: string[] = [];
    
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const upperToken = token.toUpperCase();

      if (upperToken === 'OR' || upperToken === 'AND' || upperToken === 'NOT') {
        if (parsedTokens.length === 0) continue;
        const lastToken = parsedTokens[parsedTokens.length - 1].toUpperCase();
        if (lastToken === 'AND' || lastToken === 'OR' || lastToken === 'NOT') {
          continue;
        }
        parsedTokens.push(upperToken);
      } else if (token === '(' || token === ')') {
        parsedTokens.push(token);
      } else {
        if (token.startsWith('-')) {
          const actualTerm = token.slice(1);
          if (actualTerm.length > 0) {
            if (parsedTokens.length > 0) {
              const lastToken = parsedTokens[parsedTokens.length - 1].toUpperCase();
              if (lastToken !== 'NOT' && lastToken !== 'AND' && lastToken !== 'OR') {
                parsedTokens.push('NOT');
              }
            } else {
              parsedTokens.push('NOT');
            }
            
            if (actualTerm.startsWith('"')) {
              parsedTokens.push(actualTerm);
            } else {
              parsedTokens.push(actualTerm.endsWith('*') ? actualTerm : `${actualTerm}*`);
            }
          }
        } else {
          let formattedTerm = token;
          if (!token.startsWith('"')) {
            formattedTerm = token.endsWith('*') ? token : `${token}*`;
          }
          
          if (parsedTokens.length > 0) {
            const lastToken = parsedTokens[parsedTokens.length - 1];
            const lastUpper = lastToken.toUpperCase();
            if (
              lastToken !== '(' &&
              lastUpper !== 'AND' &&
              lastUpper !== 'OR' &&
              lastUpper !== 'NOT'
            ) {
              parsedTokens.push('AND');
            }
          }
          parsedTokens.push(formattedTerm);
        }
      }
    }

    while (parsedTokens.length > 0) {
      const last = parsedTokens[parsedTokens.length - 1].toUpperCase();
      if (last === 'AND' || last === 'OR' || last === 'NOT') {
        parsedTokens.pop();
      } else {
        break;
      }
    }

    let openCount = 0;
    const balancedTokens: string[] = [];
    for (const token of parsedTokens) {
      if (token === '(') {
        openCount++;
        balancedTokens.push(token);
      } else if (token === ')') {
        if (openCount > 0) {
          openCount--;
          balancedTokens.push(token);
        }
      } else {
        balancedTokens.push(token);
      }
    }
    while (openCount > 0) {
      balancedTokens.push(')');
      openCount--;
    }

    return balancedTokens.join(' ');
  },

  // Full-text content search using FTS5 match and snippet
  searchContent(query: string): SearchResult[] {
    const database = getDb();
    const ftsQuery = this.parseSearchQuery(query);

    if (!ftsQuery) return [];

    try {
      return database.prepare(`
        SELECT 
          f.path,
          f.filename,
          snippet(files_fts, 1, '<b>', '</b>', '...', 25) as snippet
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY rank LIMIT 50
      `).all(ftsQuery) as unknown as SearchResult[];
    } catch (err) {
      console.error('FTS5 query search failed:', err, 'Query was:', ftsQuery);
      return [];
    }
  },

  resetDatabase(): void {
    const database = getDb();
    database.exec(`
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS files_fts;
    `);
    
    if (db) {
      db = null;
    }
    
    getDb();
  }
};
