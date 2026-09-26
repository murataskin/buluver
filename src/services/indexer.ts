import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import chokidar, { type FSWatcher } from 'chokidar';
import { DatabaseService } from './database.js';
import { DocumentParser } from './doc-parser.js';
import { walk } from './walker.js';
import type { ParseTask, ParsedRecord } from './indexWorker.js';
import { generateEmbedding, chunkText } from './embeddings.js';
import { generateMetadata } from './llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let isIndexing = false;
let stopRequested = false;
const watchers = new Map<string, FSWatcher>();
let progressCallback: ((status: any) => void) | null = null;
let pool: WorkerPool | null = null;

class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { tasks: ParseTask[]; resolve: (r: ParsedRecord[]) => void }[] = [];

  constructor(size: number, workerScript: string, workerOptions: any = {}) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(workerScript, workerOptions);
      w.unref();
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
    this.workers = [];
    this.idle = [];
  }
}

function getPool(): WorkerPool {
  if (pool) return pool;
  const size = Math.max(1, os.cpus().length - 1);
  let workerScriptPath = path.join(__dirname, "indexWorker.js");
  let workerOptions: any = {};
  if (!fs.existsSync(workerScriptPath)) {
    workerScriptPath = path.join(__dirname, "indexWorker.ts");
    workerOptions = { execArgv: ['--import', 'tsx'] };
  }
  pool = new WorkerPool(size, workerScriptPath, workerOptions);
  return pool;
}

export interface IndexerOptions {
  withEmbeddings?: boolean;
  withAiMetadata?: boolean;
}

export const IndexerService = {
  setProgressCallback(cb: ((status: any) => void) | null) {
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

  async scanAllRegisteredFolders(options: IndexerOptions = { withEmbeddings: true, withAiMetadata: false }): Promise<{
    scanned: number;
    parsed: number;
    skipped: number;
    removed: number;
  }> {
    if (isIndexing) {
      throw new Error("İndeksleme işlemi zaten devam ediyor.");
    }
    isIndexing = true;
    stopRequested = false;

    this.emitStatus('Dizinler taranıyor...', 0);

    const folders = DatabaseService.getFolders();
    const workerPool = getPool();

    let totalScanned = 0;
    let totalParsed = 0;
    let totalSkipped = 0;
    let totalRemoved = 0;

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

      const known = DatabaseService.getKnownFileStats(folder.path);
      const keepPaths = new Set<string>();

      let pendingBatch: any[] = [];
      const pendingWork: Promise<void>[] = [];
      let toParseBuffer: ParseTask[] = [];

      const DB_COMMIT_BATCH_SIZE = 100;
      const WORKER_TASK_BATCH_SIZE = 30;

      const flush = async () => {
        if (pendingBatch.length === 0) return;
        const inserted = DatabaseService.upsertFilesBatch(pendingBatch);
        totalParsed += pendingBatch.length;
        pendingBatch = [];
        throttleEmit(
          `İçerik dizinleniyor... (${totalParsed} yeni/güncel dosya)`,
          Math.min(99, 10 + Math.floor((totalParsed / (totalParsed + totalSkipped || 1)) * 80))
        );

        // Post-process metadata and embeddings
        for (const item of inserted) {
          try {
            // 1. Fast regex heuristics parse
            const heuristicMeta = DocumentParser.extractMetadataHeuristics(item.body, item.filename);

            // 2. Optional AI metadata generation
            let finalMeta = heuristicMeta;
            if (options.withAiMetadata && item.body.trim().length > 50) {
              try {
                const aiMeta = await generateMetadata(item.body);
                finalMeta = {
                  ...heuristicMeta,
                  summary: aiMeta.summary,
                  tags: aiMeta.tags,
                };
              } catch (aiErr) {
                console.error(`[AI] Metadata generation failed for ${item.path}:`, aiErr);
              }
            }
            DatabaseService.upsertFileMetadata(item.id, finalMeta);

            // 3. Optional local embeddings generation
            if (options.withEmbeddings && item.body.trim().length > 0) {
              const chunks = chunkText(item.body);
              if (chunks.length > 0) {
                const chunkData: { chunkIndex: number; text: string; embedding: Float32Array }[] = [];
                for (let i = 0; i < chunks.length; i++) {
                  try {
                    const embedding = await generateEmbedding(chunks[i]);
                    chunkData.push({
                      chunkIndex: i,
                      text: chunks[i],
                      embedding
                    });
                  } catch (embErr) {
                    console.error(`[Embedding] Failed on chunk ${i} of ${item.path}:`, embErr);
                  }
                }
                if (chunkData.length > 0) {
                  DatabaseService.saveFileChunks(item.id, chunkData);
                }
              }
            }
          } catch (err) {
            console.error(`Post-processing failed for file ${item.path}:`, err);
          }
        }
      };

      const flushToParseBuffer = () => {
        if (toParseBuffer.length === 0) return;
        const batch = toParseBuffer;
        toParseBuffer = [];
        const work = workerPool.run(batch).then(async (results) => {
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
          if (pendingBatch.length >= DB_COMMIT_BATCH_SIZE) {
            await flush();
          }
        });
        pendingWork.push(work);
      };

      try {
        for await (const chunk of walk(folder.path)) {
          if (stopRequested) break;

          for (const file of chunk) {
            totalScanned++;
            keepPaths.add(file.path);

            const cached = known.get(file.path);
            if (cached && cached.mtime === file.mtimeMs && cached.size === file.size) {
              totalSkipped++;
              continue;
            }

            toParseBuffer.push(file);
            if (toParseBuffer.length >= WORKER_TASK_BATCH_SIZE) flushToParseBuffer();
          }

          if (pendingWork.length > 30) {
            await Promise.race(pendingWork);
          }
        }

        flushToParseBuffer();
        await Promise.all(pendingWork);
        await flush();

        const removed = DatabaseService.pruneMissing(folder.path, keepPaths);
        totalRemoved += removed;

      } catch (err) {
        console.error(`Indexer error on folder ${folder.path}:`, err);
      }
    }

    isIndexing = false;
    this.emitStatus('İndeksleme tamamlandı.', 100);

    return {
      scanned: totalScanned,
      parsed: totalParsed,
      skipped: totalSkipped,
      removed: totalRemoved
    };
  },

  async indexFolder(folderPath: string, options: IndexerOptions = { withEmbeddings: true, withAiMetadata: false }) {
    DatabaseService.addFolder(folderPath);
    return this.scanAllRegisteredFolders(options);
  },

  startWatchingFolder(folderPath: string, options: IndexerOptions = { withEmbeddings: true, withAiMetadata: false }) {
    if (watchers.has(folderPath)) return;

    const watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true
    });

    const indexSingleFile = async (filePath: string) => {
      if (!DocumentParser.isSupported(filePath)) return;

      try {
        const stats = fs.statSync(filePath);
        if (stats.size === 0) return;

        const body = await DocumentParser.parse(filePath);
        const ext = path.extname(filePath).toLowerCase();

        const id = DatabaseService.upsertFile({
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

          const heuristicMeta = DocumentParser.extractMetadataHeuristics(body, path.basename(filePath));
          let finalMeta = heuristicMeta;
          if (options.withAiMetadata) {
            try {
              const aiMeta = await generateMetadata(body);
              finalMeta = {
                ...heuristicMeta,
                summary: aiMeta.summary,
                tags: aiMeta.tags,
              };
            } catch (aiErr) {
              console.error(`[AI] Metadata generation failed for ${filePath}:`, aiErr);
            }
          }
          DatabaseService.upsertFileMetadata(id, finalMeta);

          if (options.withEmbeddings) {
            const chunks = chunkText(body);
            if (chunks.length > 0) {
              const chunkData: { chunkIndex: number; text: string; embedding: Float32Array }[] = [];
              for (let i = 0; i < chunks.length; i++) {
                try {
                  const embedding = await generateEmbedding(chunks[i]);
                  chunkData.push({
                    chunkIndex: i,
                    text: chunks[i],
                    embedding
                  });
                } catch (err) {
                  console.error(`[Embedding] Failed on chunk ${i} of ${filePath}:`, err);
                }
              }
              if (chunkData.length > 0) {
                DatabaseService.saveFileChunks(id, chunkData);
              }
            }
          }
        }
        this.emitStatus(`Dosya güncellendi: ${path.basename(filePath)}`, 100);
      } catch (err) {
        console.error(`Watcher failed to index ${filePath}:`, err);
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

  startWatchingAll(options?: IndexerOptions) {
    const folders = DatabaseService.getFolders();
    for (const folder of folders) {
      this.startWatchingFolder(folder.path, options);
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
  },

  async enrichMissingMetadata(): Promise<void> {
    const files = DatabaseService.getFilesWithoutSummary();
    if (files.length === 0) return;

    this.emitStatus(`AI özet üretiliyor... (0/${files.length})`, 0);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const body = DatabaseService.getFileBody(file.id);
        if (!body || !body.trim()) continue;

        const heuristicMeta = DocumentParser.extractMetadataHeuristics(body, file.filename);
        let finalMeta = heuristicMeta;
        try {
          const aiMeta = await generateMetadata(body);
          finalMeta = {
            ...heuristicMeta,
            summary: aiMeta.summary,
            tags: aiMeta.tags,
          };
        } catch (aiErr) {
          console.error(`[AI] Metadata generation failed for ${file.path}:`, aiErr);
        }

        DatabaseService.upsertFileMetadata(file.id, finalMeta);
        const progress = Math.floor(((i + 1) / files.length) * 100);
        this.emitStatus(`AI özet üretiliyor... (${i + 1}/${files.length})`, progress);
      } catch (err) {
        console.error(`AI enrichment error for ${file.path}:`, err);
      }
    }

    this.emitStatus('AI özet üretimi tamamlandı.', 100);
  },

  async destroyPool() {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  }
};
