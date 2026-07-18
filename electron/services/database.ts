import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
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

  db = new Database(dbPath);
  
  // Set journal mode to WAL for high-concurrency performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Initialize tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL,
      status TEXT CHECK( status IN ('pending', 'indexed', 'failed') ) NOT NULL DEFAULT 'pending',
      error_msg TEXT,
      last_indexed_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS document_index USING fts5(
      path,
      content,
      tokenize="unicode61 remove_diacritics 1"
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
    return database.prepare('SELECT path, added_at FROM folders ORDER BY added_at ASC').all() as FolderRecord[];
  },

  addFolder(folderPath: string): void {
    const database = getDb();
    database.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(folderPath, Date.now());
  },

  removeFolder(folderPath: string): void {
    const database = getDb();
    // Run in transaction to clean files belonging to the directory
    const deleteTx = database.transaction(() => {
      // Find all files in the database matching directory path prefix
      const filesToRemove = database.prepare('SELECT path FROM files WHERE path LIKE ?').all(folderPath + '%') as { path: string }[];
      
      for (const file of filesToRemove) {
        database.prepare('DELETE FROM document_index WHERE path = ?').run(file.path);
        database.prepare('DELETE FROM files WHERE path = ?').run(file.path);
      }
      
      database.prepare('DELETE FROM folders WHERE path = ?').run(folderPath);
    });
    
    deleteTx();
  },

  // File Operations
  getFile(filePath: string): FileRecord | undefined {
    const database = getDb();
    return database.prepare('SELECT * FROM files WHERE path = ?').get(filePath) as FileRecord | undefined;
  },

  getAllFiles(): FileRecord[] {
    const database = getDb();
    return database.prepare('SELECT * FROM files').all() as FileRecord[];
  },

  upsertFile(record: FileRecord): void {
    const database = getDb();
    database.prepare(`
      INSERT INTO files (path, filename, extension, mtime, size, status, error_msg, last_indexed_at)
      VALUES ($path, $filename, $extension, $mtime, $size, $status, $error_msg, $last_indexed_at)
      ON CONFLICT(path) DO UPDATE SET
        mtime = excluded.mtime,
        size = excluded.size,
        status = excluded.status,
        error_msg = excluded.error_msg,
        last_indexed_at = excluded.last_indexed_at
    `).run({
      path: record.path,
      filename: record.filename,
      extension: record.extension,
      mtime: record.mtime,
      size: record.size,
      status: record.status,
      error_msg: record.error_msg || null,
      last_indexed_at: record.last_indexed_at || null
    });
  },

  removeFile(filePath: string): void {
    const database = getDb();
    const deleteTx = database.transaction(() => {
      database.prepare('DELETE FROM document_index WHERE path = ?').run(filePath);
      database.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    });
    deleteTx();
  },

  // FTS5 Virtual Index Operations
  updateIndex(filePath: string, content: string): void {
    const database = getDb();
    const indexTx = database.transaction(() => {
      database.prepare('DELETE FROM document_index WHERE path = ?').run(filePath);
      database.prepare('INSERT INTO document_index (path, content) VALUES (?, ?)').run(filePath, content);
    });
    indexTx();
  },

  // Helper to parse complex query syntax securely for FTS5 MATCH
  parseSearchQuery(query: string): string {
    // 1. Balance double quotes
    let quoteCount = (query.match(/"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      query += '"';
    }

    // 2. Tokenize preserving double-quoted phrases and grouping syntax
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
          continue; // avoid repeating operators
        }
        parsedTokens.push(upperToken);
      } else if (token === '(' || token === ')') {
        parsedTokens.push(token);
      } else {
        // Exclusions (-term or -"phrase")
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
          
          // Implicit AND
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

    // Strip trailing operators
    while (parsedTokens.length > 0) {
      const last = parsedTokens[parsedTokens.length - 1].toUpperCase();
      if (last === 'AND' || last === 'OR' || last === 'NOT') {
        parsedTokens.pop();
      } else {
        break;
      }
    }

    // Parentheses balancing
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
    
    // Parse the query safely into FTS5 syntax
    const ftsQuery = this.parseSearchQuery(query);

    if (!ftsQuery) return [];

    try {
      // Return snippet with bold markup around matches
      return database.prepare(`
        SELECT 
          f.path,
          f.filename,
          snippet(document_index, 1, '<b>', '</b>', '...', 25) as snippet
        FROM document_index
        JOIN files f ON f.path = document_index.path
        WHERE document_index MATCH ?
        ORDER BY rank LIMIT 50
      `).all(ftsQuery) as SearchResult[];
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
      DROP TABLE IF EXISTS document_index;
    `);
    
    // Close connection to let database reinitialize
    if (db) {
      db.close();
      db = null;
    }
    
    // Reinitialize
    getDb();
  }
};
