import * as fs from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { DatabaseService, FileRecord } from './database';
import { UdfParser } from './udf-parser';

let isIndexing = false;
let stopRequested = false;
const watchers = new Map<string, FSWatcher>();
let progressCallback: ((status: any) => void) | null = null;

export const IndexerService = {
  setProgressCallback(cb: (status: any) => void) {
    progressCallback = cb;
  },

  isCurrentlyIndexing(): boolean {
    return isIndexing;
  },

  emitStatus(info: string, progress = 0) {
    if (progressCallback) {
      progressCallback({
        isScanning: isIndexing,
        progress,
        info,
        folders: DatabaseService.getFolders().map(f => f.path),
        filesCount: DatabaseService.getAllFiles().length
      });
    }
  },

  // Recursively search for UDF, DOCX, and PDF files
  crawlDirectory(dirPath: string, filesList: string[] = []): string[] {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          // Skip hidden directories (like .git, .DS_Store)
          if (!entry.name.startsWith('.')) {
            this.crawlDirectory(fullPath, filesList);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ext === '.udf' || ext === '.pdf' || ext === '.docx') {
            filesList.push(fullPath);
          }
        }
      }
    } catch (err) {
      console.error(`Crawl failed for directory ${dirPath}:`, err);
    }
    return filesList;
  },

  // Scan all folders registered in db
  async scanAllRegisteredFolders(): Promise<void> {
    if (isIndexing) return;
    isIndexing = true;
    stopRequested = false;
    this.emitStatus('Dizinler taranıyor...', 0);

    const folders = DatabaseService.getFolders();
    const allFoundFiles: string[] = [];

    // 1. Crawl filesystem
    for (const folder of folders) {
      this.emitStatus(`Dizin taranıyor: ${folder.path}`, 0);
      this.crawlDirectory(folder.path, allFoundFiles);
    }

    // 2. Diff and detect database changes
    this.emitStatus('İndeksler veritabanı ile karşılaştırılıyor...', 10);
    const dbFiles = DatabaseService.getAllFiles();
    const dbFilesMap = new Map<string, FileRecord>();
    for (const file of dbFiles) {
      dbFilesMap.set(file.path, file);
    }

    // Detect files deleted on disk
    const foundFilesSet = new Set(allFoundFiles);
    for (const dbFile of dbFiles) {
      if (!foundFilesSet.has(dbFile.path)) {
        DatabaseService.removeFile(dbFile.path);
      }
    }

    // Detect new or modified files
    let queuedCount = 0;
    for (const filePath of allFoundFiles) {
      try {
        const stats = fs.statSync(filePath);
        const existing = dbFilesMap.get(filePath);
        const ext = path.extname(filePath).toLowerCase();
        
        const needsUpdate = !existing || 
                             existing.mtime !== stats.mtime.getTime() || 
                             existing.size !== stats.size ||
                             existing.status === 'pending';

        if (needsUpdate) {
          DatabaseService.upsertFile({
            path: filePath,
            filename: path.basename(filePath),
            extension: ext,
            mtime: stats.mtime.getTime(),
            size: stats.size,
            status: 'pending'
          });
          queuedCount++;
        }
      } catch (err) {
        console.error(`Failed to stat file ${filePath}:`, err);
      }
    }

    this.emitStatus(`${queuedCount} yeni/değişen dosya indeksleme kuyruğuna eklendi.`, 20);

    // 3. Process indexing queue
    await this.processPendingQueue();
  },

  async processPendingQueue(): Promise<void> {
    const pendingFiles = DatabaseService.getAllFiles().filter(f => f.status === 'pending');
    const total = pendingFiles.length;
    
    if (total === 0) {
      isIndexing = false;
      this.emitStatus('Hazır', 100);
      return;
    }

    isIndexing = true;
    for (let i = 0; i < total; i++) {
      if (stopRequested) break;

      const file = pendingFiles[i];
      const percent = Math.floor(20 + ((i + 1) / total) * 80);
      this.emitStatus(`İçerik dizinleniyor (${i + 1}/${total}): ${file.filename}`, percent);

      try {
        if (file.extension === '.udf') {
          // Full-text index for UDF
          const textContent = await UdfParser.parse(file.path);
          DatabaseService.updateIndex(file.path, textContent);
          
          DatabaseService.upsertFile({
            ...file,
            status: 'indexed',
            last_indexed_at: Date.now()
          });
        } else {
          // Just filename index for PDF/DOCX (empty content in document_index so it is registered)
          DatabaseService.updateIndex(file.path, '');
          DatabaseService.upsertFile({
            ...file,
            status: 'indexed',
            last_indexed_at: Date.now()
          });
        }
      } catch (err: any) {
        console.error(`Failed to index file ${file.path}:`, err);
        DatabaseService.upsertFile({
          ...file,
          status: 'failed',
          error_msg: err?.message || String(err),
          last_indexed_at: Date.now()
        });
      }
    }

    isIndexing = false;
    this.emitStatus('İndeksleme tamamlandı.', 100);
  },

  // Setup Chokidar watchers for real-time indexing
  startWatchingFolder(folderPath: string) {
    if (watchers.has(folderPath)) return;

    const watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\../, // ignore hidden
      persistent: true,
      ignoreInitial: true // we scan manually initially
    });

    watcher.on('add', async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.udf' || ext === '.pdf' || ext === '.docx') {
        try {
          const stats = fs.statSync(filePath);
          DatabaseService.upsertFile({
            path: filePath,
            filename: path.basename(filePath),
            extension: ext,
            mtime: stats.mtime.getTime(),
            size: stats.size,
            status: 'pending'
          });
          if (!isIndexing) {
            this.processPendingQueue();
          }
        } catch (err) {
          console.error(`Watcher stat failed:`, err);
        }
      }
    });

    watcher.on('change', async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.udf' || ext === '.pdf' || ext === '.docx') {
        try {
          const stats = fs.statSync(filePath);
          DatabaseService.upsertFile({
            path: filePath,
            filename: path.basename(filePath),
            extension: ext,
            mtime: stats.mtime.getTime(),
            size: stats.size,
            status: 'pending'
          });
          if (!isIndexing) {
            this.processPendingQueue();
          }
        } catch (err) {
          console.error(`Watcher change stat failed:`, err);
        }
      }
    });

    watcher.on('unlink', (filePath) => {
      DatabaseService.removeFile(filePath);
      this.emitStatus(`Dosya kaldırıldı: ${path.basename(filePath)}`, 100);
    });

    watchers.set(folderPath, watcher);
  },

  stopWatchingFolder(folderPath: string) {
    const watcher = watchers.get(folderPath);
    if (watcher) {
      watcher.close();
      watchers.delete(folderPath);
    }
  },

  startWatchingAll() {
    const folders = DatabaseService.getFolders();
    for (const folder of folders) {
      this.startWatchingFolder(folder.path);
    }
  },

  stopWatchingAll() {
    for (const [path, watcher] of watchers) {
      watcher.close();
    }
    watchers.clear();
  },

  stopCurrentScan() {
    stopRequested = true;
  }
};
