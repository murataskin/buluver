import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export function getDataDir(): string {
  const custom = process.env.BULUVER_DATA_DIR;
  if (custom) return custom;
  return path.join(os.homedir(), '.buluver');
}

export function getDbPath(): string {
  const custom = process.env.BULUVER_DB_PATH;
  if (custom) return custom;
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'buluver.db');
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = getDbPath();
  db = new DatabaseSync(dbPath);
  
  // Set journal mode to WAL for high-concurrency performance and enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA mmap_size = 268435456;'); // 256MB

  // Register cosine similarity custom function
  db.function('cosine_similarity', (emb1: any, emb2: any) => {
    if (!emb1 || !emb2) return 0;
    
    const buf1 = emb1 instanceof Uint8Array ? emb1 : Buffer.from(emb1);
    const buf2 = emb2 instanceof Uint8Array ? emb2 : Buffer.from(emb2);

    const arr1 = new Float32Array(buf1.buffer, buf1.byteOffset, buf1.length / 4);
    const arr2 = new Float32Array(buf2.buffer, buf2.byteOffset, buf2.length / 4);
    
    let dotProduct = 0, normA = 0, normB = 0;
    const len = Math.min(arr1.length, arr2.length);
    for (let i = 0; i < len; i++) {
      dotProduct += arr1[i] * arr2[i];
      normA += arr1[i] * arr1[i];
      normB += arr2[i] * arr2[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  });

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

    CREATE VIRTUAL TABLE IF NOT EXISTS files_trigram USING fts5(
      filename,
      body,
      content = 'files',
      content_rowid = 'id',
      tokenize = 'trigram'
    );

    CREATE TABLE IF NOT EXISTS file_metadata (
      file_id INTEGER PRIMARY KEY,
      summary TEXT,
      tags TEXT, -- JSON string array
      case_number TEXT,
      court_name TEXT,
      document_type TEXT,
      plaintiff TEXT,
      defendant TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL, -- Float32Array stored as binary blob
      FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON file_chunks(file_id);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  try {
    const trigramCount = Number((db.prepare("SELECT count(*) as c FROM files_trigram").get() as any)?.c || 0);
    const indexedCount = Number((db.prepare("SELECT count(*) as c FROM files WHERE status = 'indexed' AND body != ''").get() as any)?.c || 0);
    if (trigramCount === 0 && indexedCount > 0) {
      db.exec("INSERT INTO files_trigram(files_trigram) VALUES('rebuild');");
    }
  } catch (err) {
    console.error('Trigram index auto-sync failed:', err);
  }

  return db;
}

export interface FileRecord {
  id?: number;
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

export interface FileMetadata {
  summary?: string;
  tags?: string[];
  case_number?: string;
  court_name?: string;
  document_type?: string;
  plaintiff?: string;
  defendant?: string;
}

export interface SearchResult {
  path: string;
  filename: string;
  snippet: string;
  score?: number;
  mode?: string;
  metadata?: FileMetadata;
}

export const DatabaseService = {
  // Folder Operations
  getFolders(): FolderRecord[] {
    const database = getDb();
    return database.prepare('SELECT path, added_at FROM folders ORDER BY added_at ASC').all() as unknown as FolderRecord[];
  },

  addFolder(folderPath: string): void {
    const database = getDb();
    database.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, Date.now());
  },

  removeFolder(folderPath: string): void {
    const database = getDb();
    const like = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep;
    const rows = database.prepare(`SELECT id FROM files WHERE path LIKE ? || '%'`).all(like) as unknown as { id: number }[];
    
    database.exec('BEGIN IMMEDIATE;');
    try {
      const delFile = database.prepare('DELETE FROM files WHERE id = ?');
      const delFts = database.prepare('DELETE FROM files_fts WHERE rowid = ?');
      const delTrigram = database.prepare('DELETE FROM files_trigram WHERE rowid = ?');
      for (const r of rows) {
        delFts.run(r.id);
        delTrigram.run(r.id);
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
    const row = database.prepare('SELECT id, path, filename, ext as extension, mtime, size, status, error_msg, indexed_at as last_indexed_at FROM files WHERE path = ?').get(filePath) as any;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      path: String(row.path),
      filename: String(row.filename),
      extension: String(row.extension),
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
      path: String(row.path),
      filename: String(row.filename),
      extension: String(row.extension),
      mtime: Number(row.mtime),
      size: Number(row.size),
      status: row.status,
      error_msg: row.error_msg || undefined,
      last_indexed_at: Number(row.last_indexed_at)
    }));
  },

  getStats(): {
    monitoredFolders: number;
    totalFiles: number;
    indexedFiles: number;
    totalChunks: number;
    dbPath: string;
  } {
    const database = getDb();
    const foldersCount = Number((database.prepare('SELECT COUNT(*) as count FROM folders').get() as any)?.count || 0);
    const filesCount = Number((database.prepare('SELECT COUNT(*) as count FROM files').get() as any)?.count || 0);
    const indexedCount = Number((database.prepare("SELECT COUNT(*) as count FROM files WHERE status = 'indexed'").get() as any)?.count || 0);
    const chunksCount = Number((database.prepare('SELECT COUNT(*) as count FROM file_chunks').get() as any)?.count || 0);
    return {
      monitoredFolders: foldersCount,
      totalFiles: filesCount,
      indexedFiles: indexedCount,
      totalChunks: chunksCount,
      dbPath: getDbPath(),
    };
  },

  getSetting(key: string, defaultValue: string): string {
    const database = getDb();
    try {
      const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
      return row ? String(row.value) : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  setSetting(key: string, value: string): void {
    const database = getDb();
    database.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
  },

  getFilesWithoutSummary(): { id: number; path: string; filename: string }[] {
    const database = getDb();
    const rows = database.prepare(`
      SELECT f.id, f.path, f.filename
      FROM files f
      LEFT JOIN file_metadata m ON f.id = m.file_id
      WHERE f.status = 'indexed'
        AND (m.file_id IS NULL OR m.summary IS NULL OR m.summary = '')
    `).all() as any[];
    return rows.map(r => ({ id: Number(r.id), path: String(r.path), filename: String(r.filename) }));
  },

  getFileBody(fileId: number): string | null {
    const database = getDb();
    const row = database
      .prepare('SELECT body FROM files WHERE id = ?')
      .get(fileId) as any;
    return row ? String(row.body) : null;
  },

  getAllIndexedFilesWithBody(): { id: number; path: string; filename: string; body: string }[] {
    const database = getDb();
    const rows = database.prepare("SELECT id, path, filename, body FROM files WHERE status = 'indexed' AND body != ''").all() as any[];
    return rows.map(r => ({
      id: Number(r.id),
      path: String(r.path),
      filename: String(r.filename),
      body: String(r.body)
    }));
  },

  clearAllChunks(): void {
    const database = getDb();
    database.exec('DELETE FROM file_chunks;');
  },

  upsertFile(record: FileRecord): number {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(record.path) as any;
    const now = Date.now();
    let id: number;
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (existing) {
        id = Number(existing.id);
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
        database.prepare('DELETE FROM files_trigram WHERE rowid = ?').run(id);
      } else {
        const res = database.prepare(`
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
        id = Number(res.lastInsertRowid);
      }
      database.prepare('INSERT INTO files_fts (rowid, filename, body) VALUES (?, ?, ?)').run(id, record.filename, '');
      database.prepare('INSERT INTO files_trigram (rowid, filename, body) VALUES (?, ?, ?)').run(id, record.filename, '');
      database.exec('COMMIT;');
      return id;
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  removeFile(filePath: string): void {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as any;
    if (!existing) return;
    const id = Number(existing.id);
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('DELETE FROM files_fts WHERE rowid = ?').run(id);
      database.prepare('DELETE FROM files_trigram WHERE rowid = ?').run(id);
      database.prepare('DELETE FROM files WHERE id = ?').run(id);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  updateIndex(filePath: string, content: string): void {
    const database = getDb();
    const existing = database.prepare('SELECT id, filename FROM files WHERE path = ?').get(filePath) as any;
    if (!existing) return;
    const id = Number(existing.id);
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('UPDATE files SET body = ? WHERE id = ?').run(content, id);
      database.prepare('DELETE FROM files_fts WHERE rowid = ?').run(id);
      database.prepare('DELETE FROM files_trigram WHERE rowid = ?').run(id);
      database.prepare('INSERT INTO files_fts (rowid, filename, body) VALUES (?, ?, ?)').run(id, String(existing.filename), content);
      database.prepare('INSERT INTO files_trigram (rowid, filename, body) VALUES (?, ?, ?)').run(id, String(existing.filename), content);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  upsertFilesBatch(records: any[]): { id: number; path: string; filename: string; body: string }[] {
    if (records.length === 0) return [];
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
    const deleteTrigramStmt = database.prepare(`DELETE FROM files_trigram WHERE rowid = ?`);
    const insertTrigramStmt = database.prepare(
      `INSERT INTO files_trigram (rowid, filename, body) VALUES (?,?,?)`
    );

    const result: { id: number; path: string; filename: string; body: string }[] = [];

    database.exec("BEGIN IMMEDIATE;");
    try {
      const now = Date.now();
      for (const r of records) {
        const existing = findStmt.get(r.path) as any;
        let id: number;
        if (existing) {
          id = Number(existing.id);
          updateStmt.run(r.filename, r.ext, r.mtimeMs, r.size, r.body, 'indexed', now, id);
          deleteFtsStmt.run(id);
          deleteTrigramStmt.run(id);
        } else {
          const res = insertStmt.run(r.path, r.filename, r.ext, r.mtimeMs, r.size, r.body, 'indexed', now);
          id = Number(res.lastInsertRowid);
        }
        insertFtsStmt.run(id, r.filename, r.body);
        insertTrigramStmt.run(id, r.filename, r.body);
        result.push({ id, path: r.path, filename: r.filename, body: r.body });
      }
      database.exec("COMMIT;");
      return result;
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
      .all(like) as any[];

    const toDelete = rows.filter((r) => !keepPaths.has(String(r.path)));
    if (toDelete.length === 0) return 0;

    const delFile = database.prepare("DELETE FROM files WHERE id = ?");
    const delFts = database.prepare("DELETE FROM files_fts WHERE rowid = ?");
    const delTrigram = database.prepare("DELETE FROM files_trigram WHERE rowid = ?");
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const r of toDelete) {
        delFts.run(Number(r.id));
        delTrigram.run(Number(r.id));
        delFile.run(Number(r.id));
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
      .all(like) as any[];
    const map = new Map<string, { mtime: number; size: number }>();
    for (const r of rows) {
      map.set(String(r.path), { mtime: Number(r.mtime), size: Number(r.size) });
    }
    return map;
  },

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

  searchContent(query: string): SearchResult[] {
    const database = getDb();
    const ftsQuery = this.parseSearchQuery(query);

    if (!ftsQuery) return [];

    try {
      const rows = database.prepare(`
        SELECT 
          f.path,
          f.filename,
          snippet(files_fts, 1, '<b>', '</b>', '...', 25) as snippet
        FROM files_fts
        JOIN files f ON f.id = files_fts.rowid
        WHERE files_fts MATCH ?
        ORDER BY rank LIMIT 50
      `).all(ftsQuery) as any[];
      return rows.map(r => ({
        path: String(r.path),
        filename: String(r.filename),
        snippet: String(r.snippet)
      }));
    } catch (err) {
      console.error('FTS5 query search failed:', err, 'Query was:', ftsQuery);
      return [];
    }
  },

  upsertFileMetadata(fileId: number, metadata: Partial<FileMetadata>): void {
    const database = getDb();
    const existing = database.prepare('SELECT file_id FROM file_metadata WHERE file_id = ?').get(fileId);
    const now = Date.now();
    const tagsJson = metadata.tags ? JSON.stringify(metadata.tags) : null;
    
    if (existing) {
      database.prepare(`
        UPDATE file_metadata SET 
          summary = COALESCE(?, summary),
          tags = COALESCE(?, tags),
          case_number = COALESCE(?, case_number),
          court_name = COALESCE(?, court_name),
          document_type = COALESCE(?, document_type),
          plaintiff = COALESCE(?, plaintiff),
          defendant = COALESCE(?, defendant),
          updated_at = ?
        WHERE file_id = ?
      `).run(
        metadata.summary !== undefined ? metadata.summary : null,
        tagsJson,
        metadata.case_number !== undefined ? metadata.case_number : null,
        metadata.court_name !== undefined ? metadata.court_name : null,
        metadata.document_type !== undefined ? metadata.document_type : null,
        metadata.plaintiff !== undefined ? metadata.plaintiff : null,
        metadata.defendant !== undefined ? metadata.defendant : null,
        now,
        fileId
      );
    } else {
      database.prepare(`
        INSERT INTO file_metadata (file_id, summary, tags, case_number, court_name, document_type, plaintiff, defendant, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileId,
        metadata.summary || null,
        tagsJson,
        metadata.case_number || null,
        metadata.court_name || null,
        metadata.document_type || null,
        metadata.plaintiff || null,
        metadata.defendant || null,
        now
      );
    }
  },

  saveFileChunks(fileId: number, chunks: { chunkIndex: number; text: string; embedding: Float32Array }[]): void {
    const database = getDb();
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('DELETE FROM file_chunks WHERE file_id = ?').run(fileId);
      const insertStmt = database.prepare(`
        INSERT INTO file_chunks (file_id, chunk_index, text, embedding)
        VALUES (?, ?, ?, ?)
      `);
      for (const c of chunks) {
        const buffer = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
        insertStmt.run(fileId, c.chunkIndex, c.text, buffer);
      }
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  attachMetadataToResults(results: SearchResult[]): void {
    if (results.length === 0) return;
    const database = getDb();
    const paths = results.map(r => r.path);
    try {
      const metadataRows = database.prepare(`
        SELECT 
          f.path,
          m.summary,
          m.tags,
          m.case_number,
          m.court_name,
          m.document_type,
          m.plaintiff,
          m.defendant
        FROM file_metadata m
        JOIN files f ON f.id = m.file_id
        WHERE f.path IN (${paths.map(() => '?').join(',')})
      `).all(...paths) as any[];

      const pathMetadataMap = new Map<string, any>();
      for (const row of metadataRows) {
        let tags: string[] = [];
        if (row.tags) {
          try {
            tags = JSON.parse(row.tags);
          } catch {
            tags = [];
          }
        }
        pathMetadataMap.set(String(row.path), {
          summary: row.summary ? String(row.summary) : undefined,
          tags,
          case_number: row.case_number ? String(row.case_number) : undefined,
          court_name: row.court_name ? String(row.court_name) : undefined,
          document_type: row.document_type ? String(row.document_type) : undefined,
          plaintiff: row.plaintiff ? String(row.plaintiff) : undefined,
          defendant: row.defendant ? String(row.defendant) : undefined
        });
      }

      for (const r of results) {
        r.metadata = pathMetadataMap.get(r.path);
      }
    } catch (err) {
      console.error('Failed to batch fetch metadata for search results:', err);
    }
  },

  searchInfix(query: string, limit = 50): SearchResult[] {
    const database = getDb();
    const clean = query.trim().replace(/["']/g, '');
    if (clean.length < 3) {
      return [];
    }

    try {
      const rows = database.prepare(`
        SELECT 
          f.id,
          f.path,
          f.filename,
          snippet(files_trigram, 1, '<b>', '</b>', '...', 25) as snippet,
          bm25(files_trigram) as rank
        FROM files_trigram
        JOIN files f ON f.id = files_trigram.rowid
        WHERE files_trigram MATCH ?
        ORDER BY rank LIMIT ?
      `).all(`"${clean}"`, limit) as any[];

      const results: SearchResult[] = rows.map(r => ({
        path: String(r.path),
        filename: String(r.filename),
        snippet: String(r.snippet),
        score: -Number(r.rank),
        mode: 'infix'
      }));

      this.attachMetadataToResults(results);
      return results;
    } catch (err) {
      console.error('Trigram infix query search failed:', err);
      return [];
    }
  },

  search(query: string, mode: 'keyword' | 'semantic' | 'hybrid' | 'infix' = 'keyword', queryEmbedding?: Float32Array, limit = 50): SearchResult[] {
    const database = getDb();

    if (mode === 'infix') {
      return this.searchInfix(query, limit);
    }
    
    // 1. Keyword search (FTS5)
    let ftsResults: { id: number; path: string; filename: string; snippet: string; rank: number }[] = [];
    const ftsQuery = this.parseSearchQuery(query);
    if (ftsQuery && (mode === 'keyword' || mode === 'hybrid')) {
      try {
        const rows = database.prepare(`
          SELECT 
            f.id,
            f.path,
            f.filename,
            snippet(files_fts, 1, '<b>', '</b>', '...', 25) as snippet,
            rank
          FROM files_fts
          JOIN files f ON f.id = files_fts.rowid
          WHERE files_fts MATCH ?
          ORDER BY rank LIMIT ?
        `).all(ftsQuery, limit * 2) as any[];
        ftsResults = rows.map(r => ({
          id: Number(r.id),
          path: String(r.path),
          filename: String(r.filename),
          snippet: String(r.snippet),
          rank: Number(r.rank)
        }));
      } catch (err) {
        console.error('FTS5 query search failed:', err, 'Query was:', ftsQuery);
      }
    }

    // 2. Semantic search
    let semanticResults: { id: number; path: string; filename: string; snippet: string; similarity: number }[] = [];
    if (queryEmbedding && (mode === 'semantic' || mode === 'hybrid')) {
      try {
        const buffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
        const rows = database.prepare(`
          SELECT 
            f.id,
            f.path,
            f.filename,
            fc.text as snippet,
            MAX(cosine_similarity(fc.embedding, ?)) as similarity
          FROM file_chunks fc
          JOIN files f ON f.id = fc.file_id
          GROUP BY f.id
          HAVING similarity > 0.1
          ORDER BY similarity DESC
          LIMIT ?
        `).all(buffer, limit * 2) as any[];
        semanticResults = rows.map(r => ({
          id: Number(r.id),
          path: String(r.path),
          filename: String(r.filename),
          snippet: String(r.snippet),
          similarity: Number(r.similarity)
        }));
      } catch (err) {
        console.error('Semantic query search failed:', err);
      }
    }

    // 3. Merging / Selecting results based on mode
    let merged: SearchResult[] = [];

    if (mode === 'keyword') {
      merged = ftsResults.map(r => ({
        path: r.path,
        filename: r.filename,
        snippet: r.snippet,
        score: -r.rank,
        mode: 'keyword'
      }));
    } else if (mode === 'semantic') {
      merged = semanticResults.map(r => ({
        path: r.path,
        filename: r.filename,
        snippet: r.snippet,
        score: r.similarity,
        mode: 'semantic'
      }));
    } else {
      // Hybrid mode: Reciprocal Rank Fusion (RRF)
      const ftsRankMap = new Map<number, number>();
      ftsResults.forEach((r, idx) => ftsRankMap.set(r.id, idx + 1));

      const semRankMap = new Map<number, number>();
      semanticResults.forEach((r, idx) => semRankMap.set(r.id, idx + 1));

      const allIds = new Set<number>([
        ...ftsResults.map(r => r.id),
        ...semanticResults.map(r => r.id)
      ]);

      const rrfResults: { id: number; path: string; filename: string; snippet: string; score: number }[] = [];

      for (const id of allIds) {
        const ftsRank = ftsRankMap.get(id);
        const semRank = semRankMap.get(id);

        const rrfFts = ftsRank ? (1 / (60 + ftsRank)) : 0;
        const rrfSem = semRank ? (1 / (60 + semRank)) : 0;
        const score = rrfFts + rrfSem;

        let snippet = '';
        const ftsItem = ftsResults.find(r => r.id === id);
        const semItem = semanticResults.find(r => r.id === id);

        if (ftsItem && ftsItem.snippet) {
          snippet = ftsItem.snippet;
        } else if (semItem && semItem.snippet) {
          snippet = semItem.snippet;
        }

        const item = ftsItem || semItem;
        if (item) {
          rrfResults.push({
            id,
            path: item.path,
            filename: item.filename,
            snippet,
            score
          });
        }
      }

      rrfResults.sort((a, b) => b.score - a.score);
      merged = rrfResults.map(r => ({
        path: r.path,
        filename: r.filename,
        snippet: r.snippet,
        score: r.score,
        mode: 'hybrid'
      }));
    }

    const finalResults = merged.slice(0, limit);
    this.attachMetadataToResults(finalResults);
    return finalResults;
  },

  resetDatabase(): void {
    const database = getDb();
    database.exec(`
      DROP TABLE IF EXISTS folders;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS files_fts;
      DROP TABLE IF EXISTS files_trigram;
      DROP TABLE IF EXISTS file_metadata;
      DROP TABLE IF EXISTS file_chunks;
      DROP TABLE IF EXISTS app_settings;
    `);
    
    if (db) {
      db = null;
    }
    
    getDb();
  }
};
