import * as path from 'node:path';
import { getDataDir } from './database.js';
import { SettingsStore } from './settings-store.js';
import { DocumentRepository } from './document-repository.js';
import { OllamaManager } from './ollama-manager.js';

export type EmbeddingProvider = 'onnx' | 'ollama';

export interface EmbeddingCatalogEntry {
  id: string;
  label: string;
  provider: EmbeddingProvider;
  modelName: string;
  dimensions: number;
  approxSize: string;
  description: string;
  isDefault?: boolean;
}

/**
 * Curated catalog of supported embedding models.
 * This is the single source of truth for all models supported in Buluver.
 */
export const EMBEDDING_CATALOG: readonly EmbeddingCatalogEntry[] = [
  {
    id: 'minilm-l12',
    label: 'MiniLM-L12 Multilingual',
    provider: 'onnx',
    modelName: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    dimensions: 384,
    approxSize: '~120 MB',
    description: 'Dahili ONNX motoru. Harici servis gerektirmez, doğrudan CPU üzerinde hafif ve hızlı çalışır.',
    isDefault: true,
  },
  {
    id: 'nomic-embed',
    label: 'Nomic Embed Text',
    provider: 'ollama',
    modelName: 'nomic-embed-text',
    dimensions: 768,
    approxSize: '~560 MB',
    description: 'Ollama ile çalışır. 8192 token bağlam penceresi, yüksek hız ve dengeli doğruluk.',
  },
  {
    id: 'bge-m3',
    label: 'BAAI BGE-M3',
    provider: 'ollama',
    modelName: 'bge-m3',
    dimensions: 1024,
    approxSize: '~2.2 GB',
    description: 'Ollama ile çalışır. Çok dilli ve Türk hukuku metinlerinde en yüksek anlamsal eşleşme kalitesi.',
  },
  {
    id: 'multilingual-e5',
    label: 'Multilingual-E5-Large',
    provider: 'ollama',
    modelName: 'multilingual-e5-large',
    dimensions: 1024,
    approxSize: '~2.5 GB',
    description: 'Ollama ile çalışır. Yüksek kaliteli instruct tabanlı çok dilli embedding modeli.',
  },
] as const;

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

/**
 * Common contract for embedding providers (ONNX and Ollama).
 */
export interface EmbeddingProviderClient {
  readonly provider: EmbeddingProvider;
  checkHealth(modelName: string): Promise<HealthCheckResult>;
  embed(text: string, modelName: string): Promise<Float32Array>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy-loaded ONNX Pipeline (Instant CLI startup)
// ─────────────────────────────────────────────────────────────────────────────

let transformersEnv: any = null;

async function getTransformers() {
  if (!transformersEnv) {
    const tf = await import('@huggingface/transformers');
    const modelsDir = path.join(getDataDir(), 'models');
    tf.env.cacheDir = modelsDir;
    transformersEnv = tf;
  }
  return transformersEnv;
}

let extractor: any = null;
let currentExtractorModel: string | null = null;
let progressCallback: ((status: any) => void) | null = null;

export function setEmbeddingProgressCallback(cb: ((status: any) => void) | null): void {
  progressCallback = cb;
}

export function reloadPipeline(): void {
  extractor = null;
  currentExtractorModel = null;
}

export async function getEmbeddingPipeline(modelName?: string): Promise<any> {
  const targetModel = modelName || getActiveEmbeddingModel();
  if (extractor && currentExtractorModel === targetModel) {
    return extractor;
  }

  const tf = await getTransformers();
  extractor = await tf.pipeline('feature-extraction', targetModel, {
    progress_callback: (data: any) => {
      if (progressCallback) {
        progressCallback({ ...data, modelName: targetModel });
      }
    }
  });
  currentExtractorModel = targetModel;

  if (progressCallback) {
    progressCallback({ status: 'ready', file: targetModel });
  }
  return extractor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Implementations
// ─────────────────────────────────────────────────────────────────────────────

export class OnnxProviderClient implements EmbeddingProviderClient {
  readonly provider = 'onnx' as const;

  async checkHealth(_modelName: string): Promise<HealthCheckResult> {
    return { ok: true };
  }

  async embed(text: string, modelName: string): Promise<Float32Array> {
    const pipeline = await getEmbeddingPipeline(modelName);
    const output = await pipeline(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }
}

export class OllamaProviderClient implements EmbeddingProviderClient {
  readonly provider = 'ollama' as const;

  getBaseUrl(): string {
    return SettingsStore.get('ollama_base_url', 'http://localhost:11434');
  }

  async checkHealth(modelName: string): Promise<HealthCheckResult> {
    const baseUrl = this.getBaseUrl();
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) {
        return {
          ok: false,
          error: `Ollama servisi HTTP ${res.status} hatası döndürdü (${baseUrl}).`
        };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const installedModels = data.models || [];
      const hasModel = installedModels.some(
        (m) => m.name === modelName || m.name.startsWith(modelName + ':')
      );
      if (!hasModel) {
        return {
          ok: false,
          error: `"${modelName}" modeli Ollama üzerinde kurulu değil. Terminalde "ollama pull ${modelName}" komutunu çalıştırın.`
        };
      }
      return { ok: true };
    } catch (err: any) {
      if (
        err.name === 'TimeoutError' ||
        err.code === 'ECONNREFUSED' ||
        err.message?.includes('fetch failed') ||
        err.message?.includes('Failed to fetch')
      ) {
        return {
          ok: false,
          error: `Ollama servisine (${baseUrl}) erişilemiyor. Lütfen Ollama servisinin açık olduğundan emin olun ("ollama serve").`
        };
      }
      return {
        ok: false,
        error: `Ollama bağlantı hatası: ${err?.message || err}`
      };
    }
  }

  async embed(text: string, modelName: string): Promise<Float32Array> {
    const health = await this.checkHealth(modelName);
    if (!health.ok) {
      throw new Error(`[Ollama Sağlayıcı Hatası] ${health.error}`);
    }
    const baseUrl = this.getBaseUrl();
    return OllamaManager.generateEmbedding(modelName, text, baseUrl);
  }
}

const onnxClient = new OnnxProviderClient();
const ollamaClient = new OllamaProviderClient();

export function getProviderClient(provider: EmbeddingProvider): EmbeddingProviderClient {
  return provider === 'ollama' ? ollamaClient : onnxClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog & Active Model Management
// ─────────────────────────────────────────────────────────────────────────────

export function getCatalog(): readonly EmbeddingCatalogEntry[] {
  return EMBEDDING_CATALOG;
}

export function getModelById(id: string): EmbeddingCatalogEntry | undefined {
  return EMBEDDING_CATALOG.find((m) => m.id === id || m.modelName === id);
}

export function getDefaultModel(): EmbeddingCatalogEntry {
  return EMBEDDING_CATALOG.find((m) => m.isDefault) || EMBEDDING_CATALOG[0];
}

export function getActiveCatalogModel(): EmbeddingCatalogEntry {
  const activeId = SettingsStore.get('active_model_id', '');
  if (activeId) {
    const found = getModelById(activeId);
    if (found) return found;
  }
  const activeModelName = SettingsStore.get('active_model', '');
  if (activeModelName) {
    const found = getModelById(activeModelName);
    if (found) return found;
  }
  return getDefaultModel();
}

export function isEmbeddingsEnabled(): boolean {
  return SettingsStore.get('embeddings_enabled', 'false') === 'true';
}

export function setEmbeddingsEnabled(enabled: boolean): void {
  SettingsStore.set('embeddings_enabled', enabled ? 'true' : 'false');
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return getActiveCatalogModel().provider;
}

export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  SettingsStore.set('embedding_provider', provider);
}

export function getActiveEmbeddingModel(): string {
  return getActiveCatalogModel().modelName;
}

export function setActiveEmbeddingModel(modelNameOrId: string): void {
  const found = getModelById(modelNameOrId);
  if (found) {
    SettingsStore.set('active_model_id', found.id);
    SettingsStore.set('active_model', found.modelName);
    SettingsStore.set('embedding_provider', found.provider);
  } else {
    SettingsStore.set('active_model', modelNameOrId);
  }
  reloadPipeline();
}

export function getChunkSettings(): { chunkSize: number; chunkOverlap: number } {
  const size = parseInt(SettingsStore.get('chunk_size', '800'), 10) || 800;
  const overlap = parseInt(SettingsStore.get('chunk_overlap', '150'), 10) || 150;
  return { chunkSize: size, chunkOverlap: overlap };
}

export function setChunkSettings(chunkSize?: number, chunkOverlap?: number): void {
  if (chunkSize !== undefined && chunkSize > 0) {
    SettingsStore.set('chunk_size', String(chunkSize));
  }
  if (chunkOverlap !== undefined && chunkOverlap >= 0) {
    SettingsStore.set('chunk_overlap', String(chunkOverlap));
  }
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const active = getActiveCatalogModel();
  const client = getProviderClient(active.provider);
  return client.embed(text, active.modelName);
}

export function chunkText(text: string, customChunkSize?: number, customOverlap?: number): string[] {
  if (!text) return [];
  const defaults = getChunkSettings();
  const chunkSize = customChunkSize || defaults.chunkSize;
  const overlap = customOverlap !== undefined ? customOverlap : defaults.chunkOverlap;

  const chunks: string[] = [];
  const cleanText = text.replace(/\s+/g, ' ').trim();

  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }

  let start = 0;
  while (start < cleanText.length) {
    const end = Math.min(start + chunkSize, cleanText.length);
    let chunk = cleanText.slice(start, end);

    if (end < cleanText.length) {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > chunkSize - 100) {
        chunk = chunk.slice(0, lastSpace);
      }
    }

    chunks.push(chunk);
    start += chunk.length - overlap;

    if (chunk.length <= overlap) {
      break;
    }
  }

  return chunks;
}

export interface SwitchModelResult {
  success: boolean;
  model: EmbeddingCatalogEntry;
  previousModel: EmbeddingCatalogEntry;
  rebuilt: boolean;
  message: string;
  rebuildStats?: { totalFiles: number; totalChunks: number };
}

/**
 * Switches the active embedding model, validating against the catalog and Ollama health check,
 * and automatically triggers rebuildAllEmbeddings if the model identity changed and stored chunks exist.
 */
export async function switchActiveModel(
  modelIdOrName: string,
  options: {
    forceRebuild?: boolean;
    onProgress?: (current: number, total: number, file: string) => void;
    onLog?: (msg: string) => void;
  } = {}
): Promise<SwitchModelResult> {
  const target = getModelById(modelIdOrName);
  if (!target) {
    const valid = EMBEDDING_CATALOG.map((m) => `• ${m.id} (${m.label})`).join('\n  ');
    throw new Error(`Bilinmeyen model ID: "${modelIdOrName}".\n\nKatalogdaki desteklenen modeller:\n  ${valid}`);
  }

  // Pre-flight check if Ollama
  if (target.provider === 'ollama') {
    const client = getProviderClient('ollama');
    const health = await client.checkHealth(target.modelName);
    if (!health.ok) {
      throw new Error(health.error);
    }
  }

  const previous = getActiveCatalogModel();
  const indexedModelId = SettingsStore.get('indexed_model_id', previous.id);
  const totalChunks = DocumentRepository.getStats().totalChunks;

  // Persist new model configuration
  SettingsStore.set('active_model_id', target.id);
  SettingsStore.set('active_model', target.modelName);
  SettingsStore.set('embedding_provider', target.provider);
  reloadPipeline();

  let rebuilt = false;
  let rebuildStats: { totalFiles: number; totalChunks: number } | undefined;

  const isModelChanged = indexedModelId !== target.id;
  if ((isModelChanged || options.forceRebuild) && totalChunks > 0) {
    const reason = `Vektör uzayı uyumsuzluğunu önlemek için (${previous.label} [${previous.dimensions}d] -> ${target.label} [${target.dimensions}d]) mevcut belgelerin vektörleri yeni modelle baştan üretiliyor...`;
    options.onLog?.(reason);

    rebuildStats = await rebuildAllEmbeddings(options.onProgress);
    rebuilt = true;
    SettingsStore.set('indexed_model_id', target.id);
    SettingsStore.set('indexed_model_dim', String(target.dimensions));
  } else {
    SettingsStore.set('indexed_model_id', target.id);
    SettingsStore.set('indexed_model_dim', String(target.dimensions));
  }

  return {
    success: true,
    model: target,
    previousModel: previous,
    rebuilt,
    message: rebuilt
      ? `Model "${target.label}" olarak güncellendi ve ${rebuildStats?.totalFiles} belge (${rebuildStats?.totalChunks} chunk) yeni modelle baştan indekslendi.`
      : `Model "${target.label}" olarak başarıyla seçildi.`,
    rebuildStats,
  };
}

/**
 * Re-indexes all vector chunks for indexed documents using the active model and chunk settings.
 */
export async function rebuildAllEmbeddings(
  onProgress?: (current: number, total: number, file: string) => void
): Promise<{ totalFiles: number; totalChunks: number }> {
  const docs = DocumentRepository.getAllIndexedDocuments();
  if (docs.length === 0) {
    return { totalFiles: 0, totalChunks: 0 };
  }

  // Clear previous vector chunks
  DocumentRepository.clearAllChunks();

  let totalChunksCreated = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    if (onProgress) {
      onProgress(i + 1, docs.length, doc.filename);
    }

    const chunks = chunkText(doc.body);
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
          console.error(`[Rebuild] Failed chunk ${cIdx} for ${doc.path}:`, err);
        }
      }
      if (chunkData.length > 0) {
        DocumentRepository.replaceChunks(doc.path, chunkData);
        totalChunksCreated += chunkData.length;
      }
    }
  }

  const active = getActiveCatalogModel();
  SettingsStore.set('indexed_model_id', active.id);
  SettingsStore.set('indexed_model_dim', String(active.dimensions));

  return { totalFiles: docs.length, totalChunks: totalChunksCreated };
}

/**
 * Generates vector chunks only for indexed documents that currently lack embeddings,
 * preserving all previously generated embeddings. Perfect for resuming or running
 * background batch embeddings on large archives.
 */
export async function generateMissingEmbeddings(
  options: {
    limit?: number;
    onProgress?: (current: number, total: number, file: string) => void;
  } = {}
): Promise<{ totalFiles: number; totalChunks: number; remaining: number }> {
  const docs = DocumentRepository.getDocumentsWithoutChunks();
  if (docs.length === 0) {
    return { totalFiles: 0, totalChunks: 0, remaining: 0 };
  }

  const toProcess = options.limit && options.limit > 0 ? docs.slice(0, options.limit) : docs;
  let totalChunksCreated = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const doc = toProcess[i];
    if (options.onProgress) {
      options.onProgress(i + 1, toProcess.length, doc.filename);
    }

    const chunks = chunkText(doc.body);
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
          console.error(`[Missing Embeddings] Failed chunk ${cIdx} for ${doc.path}:`, err);
        }
      }
      if (chunkData.length > 0) {
        DocumentRepository.replaceChunks(doc.path, chunkData);
        totalChunksCreated += chunkData.length;
      }
    }
  }

  const active = getActiveCatalogModel();
  SettingsStore.set('indexed_model_id', active.id);
  SettingsStore.set('indexed_model_dim', String(active.dimensions));

  return {
    totalFiles: toProcess.length,
    totalChunks: totalChunksCreated,
    remaining: docs.length - toProcess.length
  };
}

