import * as path from 'node:path';
import { getDb } from './database.js';

export interface FolderRecord {
  path: string;
  added_at: number;
}

export interface AddFolderResult {
  added: boolean;
  path: string;
  alreadyMonitored?: boolean;
  parentPath?: string;
  prunedChildren?: string[];
}

/**
 * Checks whether childPath is nested inside parentPath or identical to it.
 */
function isSubpathOrEqual(childPath: string, parentPath: string): boolean {
  const normChild = path.resolve(childPath);
  const normParent = path.resolve(parentPath);
  if (normChild === normParent) return true;
  const relative = path.relative(normParent, normChild);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * FolderStore encapsulates registration, listing, deduplication, and removal
 * of Monitored Folders.
 */
export const FolderStore = {
  getFolders(): FolderRecord[] {
    const database = getDb();
    return database
      .prepare('SELECT path, added_at FROM folders ORDER BY added_at ASC')
      .all() as unknown as FolderRecord[];
  },

  /**
   * Adds a folder to the monitored list.
   * - If an ancestor folder is already monitored, ignores addition (no-op).
   * - If the added folder is a parent of existing registered folders, prunes those redundant child entries.
   */
  addFolder(folderPath: string): AddFolderResult {
    const database = getDb();
    const resolvedPath = path.resolve(folderPath);
    const existing = this.getFolders();

    // 1. Check if an ancestor folder already covers this path
    const coveredByParent = existing.find(
      (f) => f.path !== resolvedPath && isSubpathOrEqual(resolvedPath, f.path)
    );
    if (coveredByParent) {
      return {
        added: false,
        path: resolvedPath,
        parentPath: coveredByParent.path
      };
    }

    // 2. Check if identical path already exists
    const exactMatch = existing.find((f) => f.path === resolvedPath);
    if (exactMatch) {
      return {
        added: false,
        path: resolvedPath,
        alreadyMonitored: true
      };
    }

    // 3. Find any child folders that should be collapsed into this new parent
    const childrenToPrune = existing.filter(
      (f) => f.path !== resolvedPath && isSubpathOrEqual(f.path, resolvedPath)
    );

    database.exec('BEGIN IMMEDIATE;');
    try {
      if (childrenToPrune.length > 0) {
        const delStmt = database.prepare('DELETE FROM folders WHERE path = ?');
        for (const child of childrenToPrune) {
          delStmt.run(child.path);
        }
      }
      database
        .prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)')
        .run(resolvedPath, Date.now());
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }

    return {
      added: true,
      path: resolvedPath,
      prunedChildren: childrenToPrune.map((c) => c.path)
    };
  },

  /**
   * Removes a folder from monitored list.
   * When keepFiles is true, only deregisters the folder without deleting its files, FTS entries, or chunks.
   * When keepFiles is false (default), cascades deletion to all indexed files under this path.
   */
  removeFolder(folderPath: string, options: { keepFiles?: boolean } = {}): void {
    const database = getDb();
    const resolvedPath = path.resolve(folderPath);

    if (options.keepFiles) {
      database.prepare('DELETE FROM folders WHERE path = ?').run(resolvedPath);
      return;
    }

    const like = resolvedPath.endsWith(path.sep) ? resolvedPath : resolvedPath + path.sep;
    const rows = database
      .prepare(`SELECT id FROM files WHERE path LIKE ? || '%' OR path = ?`)
      .all(like, resolvedPath) as unknown as { id: number }[];

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
      database.prepare('DELETE FROM folders WHERE path = ?').run(resolvedPath);
      database.exec('COMMIT;');
    } catch (err) {
      database.exec('ROLLBACK;');
      throw err;
    }
  },

  count(): number {
    const database = getDb();
    return Number((database.prepare('SELECT COUNT(*) as count FROM folders').get() as any)?.count || 0);
  }
};

