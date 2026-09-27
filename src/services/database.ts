import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { FolderStore } from './folder-store.js';
import { SettingsStore } from './settings-store.js';
import { DocumentRepository } from './document-repository.js';

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
      case_kind TEXT,
      court_name TEXT,
      document_type TEXT,
      document_date TEXT,
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

  // Safe schema migration for file_metadata
  try {
    const metaColumns = db.prepare('PRAGMA table_info(file_metadata)').all() as Array<{ name: string }>;
    const colNames = metaColumns.map((c) => c.name);
    if (!colNames.includes('case_kind')) {
      db.exec('ALTER TABLE file_metadata ADD COLUMN case_kind TEXT;');
    }
    if (!colNames.includes('document_date')) {
      db.exec('ALTER TABLE file_metadata ADD COLUMN document_date TEXT;');
    }
  } catch (err) {
    console.error('file_metadata schema migration error:', err);
  }

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
  case_kind?: string;
  court_name?: string;
  document_type?: string;
  document_date?: string;
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

/**
 * Resets the SQLite database by dropping all tables and re-initializing the schema.
 * Intended for test environments and system resets.
 */
export function resetDatabase(): void {
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

export { FolderStore } from './folder-store.js';
export { SettingsStore } from './settings-store.js';
export { DocumentRepository } from './document-repository.js';
export type {
  IndexableDocument,
  IndexableChunk,
  DocumentRecord,
  RepositoryStats,
  SearchRetrieverItem
} from './document-repository.js';
