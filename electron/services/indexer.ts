import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Worker } from 'node:worker_threads';
import chokidar, { type FSWatcher } from 'chokidar';
import { DatabaseService, FileRecord } from './database';
import { UdfParser } from './udf-parser';
import { walk, WalkedFile } from './walker';
import type { ParseTask, ParsedRecord } from './indexWorker';

let isIndexing = false;
let stopRequested = false;
const watchers = new Map<string, FSWatcher>();
let progressCallback: ((status: any) => void) | null = null;
let pool: WorkerPool | null = null;

class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { tasks: ParseTask[]; resolve: (r: ParsedRecord[]) => void }[] = [];

  constructor(size: number, workerScript: string) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerScript);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  run(tasks: ParseTask[]): Promise<ParsedRecord[]> {
    return new Promise((resolve) => {
      this.queue.push({ tasks, resolve });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      
      const onMessage = (results: ParsedRecord[]) => {
        worker.off("message", onMessage);
        this.idle.push(worker);
        job.resolve(results);
        this.pump();
      };
      
      worker.on("message", onMessage);
      worker.postMessage(job.tasks);
    }
  }

  async destroy() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

function getPool(): WorkerPool {
  if (pool) return pool;
  const size = Math.max(1, os.cpus().length - 1);
  const workerScriptPath = path.join(__dirname, "indexWorker.js");
  pool = new WorkerPool(size, workerScriptPath);
  return pool;
}

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

  // Scan all folders registered in db using worker pool and non-blocking walker
  async scanAllRegisteredFolders(): Promise<void> {
    if (isIndexing) return;
    isIndexing = true;
    stopRequested = false;

    this.emitStatus('Dizinler taranıyor...', 0);

    const folders = DatabaseService.getFolders();
    const workerPool = getPool();

    let scanned = 0;
    let parsed = 0;
    let skipped = 0;
    let totalFilesCount = DatabaseService.getAllFiles().length;

    let lastEmit = Date.now();
    const throttleEmit = (info: string, progress: number, force = false) => {
      const now = Date.now();
      if (force || now - lastEmit > 150) {
        lastEmit = now;
        this.emitStatus(info, progress);
      }
    };

    for (const folder of folders) {
      if (stopRequested) break;

      throttleEmit(`Dizin taranıyor: ${folder.path}`, 0, true);

      // 1. Get cached file metadata to skip parsing unchanged files
      const known = DatabaseService.getKnownFileStats(folder.path);
      const keepPaths = new Set<string>();

      let pendingBatch: any[] = [];
      const pendingWork: Promise<void>[] = [];
      let toParseBuffer: ParseTask[] = [];

      const DB_COMMIT_BATCH_SIZE = 300;
      const WORKER_TASK_BATCH_SIZE = 40;

      const flush = () => {
        if (pendingBatch.length === 0) return;
        DatabaseService.upsertFilesBatch(pendingBatch);
        parsed += pendingBatch.length;
        pendingBatch = [];
        throttleEmit(
          `İçerik dizinleniyor... (${parsed} yeni/değişen dosya)`,
          Math.min(99, 10 + Math.floor((parsed / (parsed + skipped || 1)) * 80))
        );
      };

      const flushToParseBuffer = () => {
        if (toParseBuffer.length === 0) return;
        const batch = toParseBuffer;
        toParseBuffer = [];
        const work = workerPool.run(batch).then((results) => {
          for (const r of results) {
            pendingBatch.push({
              path: r.path,
              filename: r.filename,
              ext: r.ext,
              mtimeMs: r.mtimeMs,
              size: r.size,
              body: r.body
            });
          }
          if (pendingBatch.length >= DB_COMMIT_BATCH_SIZE) flush();
        });
        pendingWork.push(work);
      };

      try {
        // 2. Walk directory with non-blocking walker yielding chunks
        for await (const chunk of walk(folder.path)) {
          if (stopRequested) break;

          for (const file of chunk) {
            scanned++;
            keepPaths.add(file.path);

            const cached = known.get(file.path);
            if (cached && cached.mtime === file.mtimeMs && cached.size === file.size) {
              skipped++;
              continue;
            }

            toParseBuffer.push(file);
            if (toParseBuffer.length >= WORKER_TASK_BATCH_SIZE) flushToParseBuffer();
          }

          // Back-pressure control: don't buffer too many pending parser promises
          if (pendingWork.length > 50) {
            await Promise.race(pendingWork);
          }
        }

        // Flush remaining buffers
        flushToParseBuffer();
        await Promise.all(pendingWork);
        flush();

        // 3. Prune deleted files
        const removed = DatabaseService.pruneMissing(folder.path, keepPaths);
        console.log(`Indexer: Monitored folder [${folder.path}] scan done. Scanned: ${scanned}, Parsed: ${parsed}, Skipped: ${skipped}, Removed: ${removed}`);

      } catch (err) {
        console.error(`Indexer: Error indexing folder ${folder.path}:`, err);
      }
    }

    isIndexing = false;
    this.emitStatus('İndeksleme tamamlandı.', 100);
  },

  async processPendingQueue(): Promise<void> {
    // Backward compatibility wrapper
    await this.scanAllRegisteredFolders();
  },

  // Setup Chokidar watchers for real-time indexing
  startWatchingFolder(folderPath: string) {
    if (watchers.has(folderPath)) return;

    const watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true
    });

    const indexSingleFile = async (filePath: string) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.udf' || ext === '.pdf' || ext === '.docx') {
        try {
          const stats = fs.statSync(filePath);
          let body = '';
          if (ext === '.udf') {
            body = await UdfParser.parse(filePath);
          }
          DatabaseService.upsertFile({
            path: filePath,
            filename: path.basename(filePath),
            extension: ext,
            mtime: stats.mtimeMs,
            size: stats.size,
            status: 'indexed',
            last_indexed_at: Date.now()
          });
          if (body) {
            DatabaseService.updateIndex(filePath, body);
          }
          this.emitStatus(`Dosya güncellendi: ${path.basename(filePath)}`, 100);
        } catch (err) {
          console.error(`Watcher failed to index file ${filePath}:`, err);
        }
      }
    };

    watcher.on('add', indexSingleFile);
    watcher.on('change', indexSingleFile);

    watcher.on('unlink', (filePath) => {
      DatabaseService.removeFile(filePath);
      this.emitStatus(`Dosya silindi: ${path.basename(filePath)}`, 100);
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
    for (const [_, watcher] of watchers) {
      watcher.close();
    }
    watchers.clear();
  },

  stopCurrentScan() {
    stopRequested = true;
  }
};
