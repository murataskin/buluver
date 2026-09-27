import * as path from 'node:path';
import { getDb, getDbPath, type FileMetadata, type SearchResult } from './database.js';
import { normalizeTurkishForSearch, generateCleanSnippet } from './search.js';

export interface IndexableChunk {
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
}

export interface IndexableDocument {
  path: string;
  filename: string;
  extension: string;
  mtime: number;
  size: number;
  body?: string;
  status?: 'pending' | 'indexed' | 'failed';
  errorMsg?: string;
  lastIndexedAt?: number;
  metadata?: Partial<FileMetadata>;
  chunks?: IndexableChunk[];
}

export interface DocumentRecord {
  id: number;
  path: string;
  filename: string;
  extension: string;
  mtime: number;
  size: number;
  status: 'pending' | 'indexed' | 'failed';
  errorMsg?: string;
  lastIndexedAt: number;
  body?: string;
  metadata?: FileMetadata;
}

export interface RepositoryStats {
  totalFiles: number;
  indexedFiles: number;
  totalChunks: number;
  monitoredFolders: number;
  dbPath: string;
}

export interface SearchRetrieverItem {
  id: number;
  path: string;
  filename: string;
  snippet: string;
  score: number;
}

/**
 * DocumentRepository is the deep persistence module encapsulating
 * document storage, full-text virtual indexes (BM25 and Trigram),
 * legal metadata, and chunk vector embeddings behind an atomic seam.
 */
export const DocumentRepository = {
  /**
   * Persists a single document atomically across all underlying SQLite tables.
   */
  saveDocument(doc: IndexableDocument): void {
    this.saveDocumentsBatch([doc]);
  },

  /**
   * Persists a batch of documents in a single atomic WAL transaction.
   * Keeps files, files_fts, files_trigram, file_metadata, and file_chunks in sync.
   */
  saveDocumentsBatch(docs: IndexableDocument[]): void {
    if (docs.length === 0) return;

    const database = getDb();
    const findStmt = database.prepare('SELECT id FROM files WHERE path = ?');
    const updateStmt = database.prepare(
      `UPDATE files SET filename=?, ext=?, mtime=?, size=?, body=?, status=?, error_msg=?, indexed_at=? WHERE id=?`
    );
    const insertStmt = database.prepare(
      `INSERT INTO files (path, filename, ext, mtime, size, body, status, error_msg, indexed_at) VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const delFtsStmt = database.prepare('DELETE FROM files_fts WHERE rowid = ?');
    const insFtsStmt = database.prepare('INSERT INTO files_fts (rowid, filename, body) VALUES (?,?,?)');
    const delTrigramStmt = database.prepare('DELETE FROM files_trigram WHERE rowid = ?');
    const insTrigramStmt = database.prepare('INSERT INTO files_trigram (rowid, filename, body) VALUES (?,?,?)');

    const findMetaStmt = database.prepare('SELECT file_id FROM file_metadata WHERE file_id = ?');
    const updateMetaStmt = database.prepare(`
      UPDATE file_metadata SET 
        summary = COALESCE(?, summary),
        tags = COALESCE(?, tags),
        case_number = COALESCE(?, case_number),
        case_kind = COALESCE(?, case_kind),
        court_name = COALESCE(?, court_name),
        document_type = COALESCE(?, document_type),
        document_date = COALESCE(?, document_date),
        plaintiff = COALESCE(?, plaintiff),
        defendant = COALESCE(?, defendant),
        updated_at = ?
      WHERE file_id = ?
    `);
    const insertMetaStmt = database.prepare(`
      INSERT INTO file_metadata (file_id, summary, tags, case_number, case_kind, court_name, document_type, document_date, plaintiff, defendant, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const delChunksStmt = database.prepare('DELETE FROM file_chunks WHERE file_id = ?');
    const insChunkStmt = database.prepare(`
      INSERT INTO file_chunks (file_id, chunk_index, text, embedding)
      VALUES (?, ?, ?, ?)
    `);

    database.exec('BEGIN IMMEDIATE;');
    try {
      const now = Date.now();
      for (const doc of docs) {
        const body = doc.body ?? '';
        const status = doc.status ?? 'indexed';
        const indexedAt = doc.lastIndexedAt ?? now;
        const existing = findStmt.get(doc.path) as any;
        let fileId: number;

        if (existing) {
          fileId = Number(existing.id);
          updateStmt.run(
            doc.filename,
            doc.extension,
            doc.mtime,
            doc.size,
            body,
            status,
            doc.errorMsg || null,
            indexedAt,
            fileId
          );
          delFtsStmt.run(fileId);
          delTrigramStmt.run(fileId);
        } else {
          const res = insertStmt.run(
            doc.path,
            doc.filename,
            doc.extension,
            doc.mtime,
            doc.size,
            body,
            status,
            doc.errorMsg || null,
            indexedAt
          );
          fileId = Number(res.lastInsertRowid);
        }

        // FTS & Trigram virtual indexes
        insFtsStmt.run(fileId, doc.filename, body);
        insTrigramStmt.run(
          fileId,
          normalizeTurkishForSearch(doc.filename),
          normalizeTurkishForSearch(body)
        );

        // Metadata
        if (doc.metadata) {
          const meta = doc.metadata;
          const tagsJson = meta.tags ? JSON.stringify(meta.tags) : null;
          const hasMeta = findMetaStmt.get(fileId);
          if (hasMeta) {
            updateMetaStmt.run(
              meta.summary !== undefined ? meta.summary : null,
              tagsJson,
              meta.case_number !== undefined ? meta.case_number : null,
              meta.case_kind !== undefined ? meta.case_kind : null,
              meta.court_name !== undefined ? meta.court_name : null,
              meta.document_type !== undefined ? meta.document_type : null,
              meta.document_date !== undefined ? meta.document_date : null,
              meta.plaintiff !== undefined ? meta.plaintiff : null,
              meta.defendant !== undefined ? meta.defendant : null,
              now,
              fileId
            );
          } else {
            insertMetaStmt.run(
              fileId,
              meta.summary || null,
              tagsJson,
              meta.case_number || null,
              meta.case_kind || null,
              meta.court_name || null,
              meta.document_type || null,
              meta.document_date || null,
              meta.plaintiff || null,
              meta.defendant || null,
              now
            );
          }
        }

        // Chunks
        if (doc.chunks && doc.chunks.length > 0) {
          delChunksStmt.run(fileId);
          for (const c of doc.chunks) {
            const buffer = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
            insChunkStmt.run(fileId, c.chunkIndex, c.text, buffer);
          }
        }
      }

      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  /**
   * Retrieves a document record by its filesystem path.
   */
  getDocument(filePath: string): DocumentRecord | undefined {
    const database = getDb();
    const row = database
      .prepare('SELECT id, path, filename, ext as extension, mtime, size, body, status, error_msg, indexed_at as last_indexed_at FROM files WHERE path = ?')
      .get(filePath) as any;
    if (!row) return undefined;

    let metadata: FileMetadata | undefined;
    const metaRow = database
      .prepare('SELECT summary, tags, case_number, case_kind, court_name, document_type, document_date, plaintiff, defendant FROM file_metadata WHERE file_id = ?')
      .get(row.id) as any;

    if (metaRow) {
      let tags: string[] = [];
      if (metaRow.tags) {
        try {
          tags = JSON.parse(metaRow.tags);
        } catch {
          tags = [];
        }
      }
      metadata = {
        summary: metaRow.summary ? String(metaRow.summary) : undefined,
        tags,
        case_number: metaRow.case_number ? String(metaRow.case_number) : undefined,
        case_kind: metaRow.case_kind ? String(metaRow.case_kind) : undefined,
        court_name: metaRow.court_name ? String(metaRow.court_name) : undefined,
        document_type: metaRow.document_type ? String(metaRow.document_type) : undefined,
        document_date: metaRow.document_date ? String(metaRow.document_date) : undefined,
        plaintiff: metaRow.plaintiff ? String(metaRow.plaintiff) : undefined,
        defendant: metaRow.defendant ? String(metaRow.defendant) : undefined
      };
    }

    return {
      id: Number(row.id),
      path: String(row.path),
      filename: String(row.filename),
      extension: String(row.extension),
      mtime: Number(row.mtime),
      size: Number(row.size),
      body: row.body ? String(row.body) : undefined,
      status: row.status,
      errorMsg: row.error_msg || undefined,
      lastIndexedAt: Number(row.last_indexed_at),
      metadata
    };
  },

  /**
   * Removes a document and its cascading virtual index, metadata, and chunk rows.
   */
  removeDocument(filePath: string): void {
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

  /**
   * Prunes files under a root folder that are no longer present on disk.
   */
  pruneMissing(rootPath: string, keepPaths: Set<string>): number {
    const database = getDb();
    const like = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    const rows = database
      .prepare(`SELECT id, path FROM files WHERE path LIKE ? || '%'`)
      .all(like) as any[];

    const toDelete = rows.filter((r) => !keepPaths.has(String(r.path)));
    if (toDelete.length === 0) return 0;

    const delFile = database.prepare('DELETE FROM files WHERE id = ?');
    const delFts = database.prepare('DELETE FROM files_fts WHERE rowid = ?');
    const delTrigram = database.prepare('DELETE FROM files_trigram WHERE rowid = ?');

    database.exec('BEGIN IMMEDIATE;');
    try {
      for (const r of toDelete) {
        delFts.run(Number(r.id));
        delTrigram.run(Number(r.id));
        delFile.run(Number(r.id));
      }
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
    return toDelete.length;
  },

  /**
   * Returns a map of path -> { mtime, size } for quick diffing during filesystem scans.
   */
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

  /**
   * Returns all indexed documents with non-empty bodies (for re-indexing embeddings).
   */
  getAllIndexedDocuments(): { path: string; filename: string; body: string }[] {
    const database = getDb();
    const rows = database
      .prepare("SELECT path, filename, body FROM files WHERE status = 'indexed' AND body != ''")
      .all() as any[];
    return rows.map((r) => ({
      path: String(r.path),
      filename: String(r.filename),
      body: String(r.body)
    }));
  },

  /**
   * Returns indexed documents with non-empty bodies that do not currently have any vector chunks.
   * Useful for batch embedding runs after fast initial FTS indexing.
   */
  getDocumentsWithoutChunks(): { path: string; filename: string; body: string }[] {
    const database = getDb();
    const rows = database
      .prepare(`
        SELECT f.path, f.filename, f.body
        FROM files f
        LEFT JOIN file_chunks c ON f.id = c.file_id
        WHERE f.status = 'indexed' AND f.body != '' AND c.file_id IS NULL
        GROUP BY f.id
      `)
      .all() as any[];
    return rows.map((r) => ({
      path: String(r.path),
      filename: String(r.filename),
      body: String(r.body)
    }));
  },


  /**
   * Replaces the vector chunks for a document identified by its file path.
   */
  replaceChunks(filePath: string, chunks: IndexableChunk[]): void {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as any;
    if (!existing) return;

    const fileId = Number(existing.id);
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare('DELETE FROM file_chunks WHERE file_id = ?').run(fileId);
      const insStmt = database.prepare(`
        INSERT INTO file_chunks (file_id, chunk_index, text, embedding)
        VALUES (?, ?, ?, ?)
      `);
      for (const c of chunks) {
        const buffer = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
        insStmt.run(fileId, c.chunkIndex, c.text, buffer);
      }
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  /**
   * Deletes all vector chunks across all documents.
   */
  clearAllChunks(): void {
    const database = getDb();
    database.exec('DELETE FROM file_chunks;');
  },

  /**
   * Returns indexed documents that do not yet have an AI summary.
   */
  getDocumentsWithoutSummary(): { path: string; filename: string; body: string }[] {
    const database = getDb();
    const rows = database.prepare(`
      SELECT f.path, f.filename, f.body
      FROM files f
      LEFT JOIN file_metadata m ON f.id = m.file_id
      WHERE f.status = 'indexed' AND f.body != ''
        AND (m.file_id IS NULL OR m.summary IS NULL OR m.summary = '')
    `).all() as any[];
    return rows.map((r) => ({
      path: String(r.path),
      filename: String(r.filename),
      body: String(r.body)
    }));
  },

  /**
   * Updates or inserts metadata for a document identified by its file path.
   */
  updateMetadata(filePath: string, metadata: Partial<FileMetadata>): void {
    const database = getDb();
    const existing = database.prepare('SELECT id FROM files WHERE path = ?').get(filePath) as any;
    if (!existing) return;
    const fileId = Number(existing.id);
    const now = Date.now();
    const tagsJson = metadata.tags ? JSON.stringify(metadata.tags) : null;
    const hasMeta = database.prepare('SELECT file_id FROM file_metadata WHERE file_id = ?').get(fileId);

    if (hasMeta) {
      database.prepare(`
        UPDATE file_metadata SET 
          summary = COALESCE(?, summary),
          tags = COALESCE(?, tags),
          case_number = COALESCE(?, case_number),
          case_kind = COALESCE(?, case_kind),
          court_name = COALESCE(?, court_name),
          document_type = COALESCE(?, document_type),
          document_date = COALESCE(?, document_date),
          plaintiff = COALESCE(?, plaintiff),
          defendant = COALESCE(?, defendant),
          updated_at = ?
        WHERE file_id = ?
      `).run(
        metadata.summary !== undefined ? metadata.summary : null,
        tagsJson,
        metadata.case_number !== undefined ? metadata.case_number : null,
        metadata.case_kind !== undefined ? metadata.case_kind : null,
        metadata.court_name !== undefined ? metadata.court_name : null,
        metadata.document_type !== undefined ? metadata.document_type : null,
        metadata.document_date !== undefined ? metadata.document_date : null,
        metadata.plaintiff !== undefined ? metadata.plaintiff : null,
        metadata.defendant !== undefined ? metadata.defendant : null,
        now,
        fileId
      );
    } else {
      database.prepare(`
        INSERT INTO file_metadata (file_id, summary, tags, case_number, case_kind, court_name, document_type, document_date, plaintiff, defendant, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileId,
        metadata.summary || null,
        tagsJson,
        metadata.case_number || null,
        metadata.case_kind || null,
        metadata.court_name || null,
        metadata.document_type || null,
        metadata.document_date || null,
        metadata.plaintiff || null,
        metadata.defendant || null,
        now
      );
    }
  },

  /**
   * Returns repository-wide counts and stats.
   */
  getStats(): RepositoryStats {
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
      dbPath: getDbPath()
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SearchRetriever Contract Implementation
  // ─────────────────────────────────────────────────────────────────────────────

  queryFts(ftsQuery: string, limit = 50): SearchRetrieverItem[] {
    const database = getDb();
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
      `).all(ftsQuery, limit) as any[];
      return rows.map((r) => ({
        id: Number(r.id),
        path: String(r.path),
        filename: String(r.filename),
        snippet: String(r.snippet),
        score: -Number(r.rank)
      }));
    } catch (err) {
      console.error('FTS5 query search failed:', err, 'Query was:', ftsQuery);
      return [];
    }
  },

  queryTrigram(cleanQuery: string, limit = 50): SearchRetrieverItem[] {
    const database = getDb();
    try {
      const normalizedQuery = normalizeTurkishForSearch(cleanQuery);
      const rows = database.prepare(`
        SELECT 
          f.id,
          f.path,
          f.filename,
          f.body,
          snippet(files_trigram, 1, '<b>', '</b>', '...', 25) as raw_snippet,
          bm25(files_trigram) as rank
        FROM files_trigram
        JOIN files f ON f.id = files_trigram.rowid
        WHERE files_trigram MATCH ?
        ORDER BY rank LIMIT ?
      `).all(`"${normalizedQuery}"`, limit) as any[];

      return rows.map((r) => {
        const bodyText = r.body ? String(r.body) : '';
        const cleanSnippet = bodyText
          ? generateCleanSnippet(bodyText, cleanQuery, 180)
          : '';
        return {
          id: Number(r.id),
          path: String(r.path),
          filename: String(r.filename),
          snippet: cleanSnippet || String(r.raw_snippet || r.filename),
          score: -Number(r.rank)
        };
      });
    } catch (err) {
      console.error('Trigram infix query search failed:', err);
      return [];
    }
  },

  queryVector(embedding: Float32Array, limit = 50): SearchRetrieverItem[] {
    const database = getDb();
    try {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
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
      `).all(buffer, limit) as any[];

      return rows.map((r) => ({
        id: Number(r.id),
        path: String(r.path),
        filename: String(r.filename),
        snippet: String(r.snippet),
        score: Number(r.similarity)
      }));
    } catch (err) {
      console.error('Semantic query search failed:', err);
      return [];
    }
  },

  attachMetadata(results: SearchResult[]): void {
    if (results.length === 0) return;
    const database = getDb();
    const paths = results.map((r) => r.path);
    try {
      const metadataRows = database.prepare(`
        SELECT 
          f.path,
          m.summary,
          m.tags,
          m.case_number,
          m.case_kind,
          m.court_name,
          m.document_type,
          m.document_date,
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
          case_kind: row.case_kind ? String(row.case_kind) : undefined,
          court_name: row.court_name ? String(row.court_name) : undefined,
          document_type: row.document_type ? String(row.document_type) : undefined,
          document_date: row.document_date ? String(row.document_date) : undefined,
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
  }
};
