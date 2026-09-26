import { pipeline, env } from '@huggingface/transformers';
import * as path from 'node:path';
import { DatabaseService, getDataDir } from './database.js';

// Configure transformers cache directory inside Buluver data dir (~/.buluver/models)
const modelsDir = path.join(getDataDir(), 'models');
env.cacheDir = modelsDir;

let extractor: any = null;
let progressCallback: ((status: any) => void) | null = null;

export function setEmbeddingProgressCallback(cb: ((status: any) => void) | null): void {
  progressCallback = cb;
}

export function reloadPipeline(): void {
  extractor = null;
}

export function getActiveEmbeddingModel(): string {
  return DatabaseService.getSetting('active_model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
}

export function setActiveEmbeddingModel(modelName: string): void {
  DatabaseService.setSetting('active_model', modelName);
  reloadPipeline();
}

export function getChunkSettings(): { chunkSize: number; chunkOverlap: number } {
  const size = parseInt(DatabaseService.getSetting('chunk_size', '800'), 10) || 800;
  const overlap = parseInt(DatabaseService.getSetting('chunk_overlap', '150'), 10) || 150;
  return { chunkSize: size, chunkOverlap: overlap };
}

export function setChunkSettings(chunkSize?: number, chunkOverlap?: number): void {
  if (chunkSize !== undefined && chunkSize > 0) {
    DatabaseService.setSetting('chunk_size', String(chunkSize));
  }
  if (chunkOverlap !== undefined && chunkOverlap >= 0) {
    DatabaseService.setSetting('chunk_overlap', String(chunkOverlap));
  }
}

export async function getEmbeddingPipeline(): Promise<any> {
  if (extractor) return extractor;
  
  const modelName = getActiveEmbeddingModel();
  
  extractor = await pipeline('feature-extraction', modelName, {
    progress_callback: (data: any) => {
      if (progressCallback) {
        progressCallback({ ...data, modelName });
      }
    }
  });
  
  if (progressCallback) {
    progressCallback({ status: 'ready', file: modelName });
  }
  return extractor;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const model = await getEmbeddingPipeline();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export function chunkText(text: string, customChunkSize?: number, customOverlap?: number): string[] {
  if (!text) return [];
  const defaults = getChunkSettings();
  const chunkSize = customChunkSize || defaults.chunkSize;
  const overlap = customOverlap !== undefined ? customOverlap : defaults.chunkOverlap;

  const chunks: string[] = [];
  
  // Normalize whitespace: replace multiple spaces/newlines with a single space
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }
  
  let start = 0;
  while (start < cleanText.length) {
    const end = Math.min(start + chunkSize, cleanText.length);
    let chunk = cleanText.slice(start, end);
    
    // Attempt to align chunk boundary to a space to avoid cutting words
    if (end < cleanText.length) {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > chunkSize - 100) {
        chunk = chunk.slice(0, lastSpace);
      }
    }
    
    chunks.push(chunk);
    start += chunk.length - overlap;
    
    // Safety check to prevent infinite loops
    if (chunk.length <= overlap) {
      break;
    }
  }
  
  return chunks;
}

/**
 * Re-indexes all vector chunks for indexed documents using the active model and chunk settings.
 */
export async function rebuildAllEmbeddings(
  onProgress?: (current: number, total: number, file: string) => void
): Promise<{ totalFiles: number; totalChunks: number }> {
  const files = DatabaseService.getAllIndexedFilesWithBody();
  if (files.length === 0) {
    return { totalFiles: 0, totalChunks: 0 };
  }

  // Clear previous vector chunks
  DatabaseService.clearAllChunks();

  let totalChunksCreated = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) {
      onProgress(i + 1, files.length, file.filename);
    }

    const chunks = chunkText(file.body);
    if (chunks.length > 0) {
      const chunkData: { chunkIndex: number; text: string; embedding: Float32Array }[] = [];
      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        try {
          const emb = await generateEmbedding(chunks[cIdx]);
          chunkData.push({
            chunkIndex: cIdx,
            text: chunks[cIdx],
            embedding: emb
          });
        } catch (err) {
          console.error(`[Rebuild] Failed chunk ${cIdx} for ${file.path}:`, err);
        }
      }
      if (chunkData.length > 0) {
        DatabaseService.saveFileChunks(file.id, chunkData);
        totalChunksCreated += chunkData.length;
      }
    }
  }

  return { totalFiles: files.length, totalChunks: totalChunksCreated };
}
