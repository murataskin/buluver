export {
  DocumentRepository,
  FolderStore,
  SettingsStore,
  getDb,
  getDbPath,
  getDataDir,
  resetDatabase
} from './services/database.js';
export type {
  FileRecord,
  FolderRecord,
  FileMetadata,
  SearchResult,
  IndexableDocument,
  IndexableChunk,
  DocumentRecord,
  RepositoryStats
} from './services/database.js';
export { DocumentParser } from './services/doc-parser.js';
export type { DocumentMetadata } from './services/doc-parser.js';
export { DocumentIngestor } from './services/document-ingestor.js';
export type { IngestTask, IngestionOptions, IngestedDocumentPayload } from './services/document-ingestor.js';
export { SearchEngine, createSearchEngine, parseSearchQuery } from './services/search.js';
export type { SearchMode, SearchOptions, SearchResponse } from './services/search.js';
export { IndexerService } from './services/indexer.js';
export type { IndexerOptions } from './services/indexer.js';
export { McpServerService } from './services/mcp.js';
export {
  generateEmbedding,
  chunkText,
  getEmbeddingPipeline,
  getActiveEmbeddingModel,
  setActiveEmbeddingModel,
  getChunkSettings,
  setChunkSettings,
  rebuildAllEmbeddings,
  isEmbeddingsEnabled,
  setEmbeddingsEnabled,
  getCatalog,
  getModelById,
  getDefaultModel,
  getActiveCatalogModel,
  switchActiveModel,
  EMBEDDING_CATALOG,
  getProviderClient
} from './services/embeddings.js';
export type {
  EmbeddingProvider,
  EmbeddingCatalogEntry,
  EmbeddingProviderClient,
  HealthCheckResult,
  SwitchModelResult
} from './services/embeddings.js';
export { getLLMSettings, saveLLMSettings, testLLMConnection, generateMetadata } from './services/llm.js';
export type { LLMSettings, LLMProvider, AIMetadata } from './services/llm.js';
export { scanSystem, detectHardwareProfile } from './services/system-detector.js';
export type { HardwareProfile, DetectedModel, SystemScanReport } from './services/system-detector.js';
export { OllamaManager } from './services/ollama-manager.js';
export { SetupWizard } from './services/setup-wizard.js';
export type { SetupOptions, SetupResult } from './services/setup-wizard.js';
