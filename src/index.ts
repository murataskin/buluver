export { DatabaseService, getDb, getDbPath, getDataDir } from './services/database.js';
export type { FileRecord, FolderRecord, FileMetadata, SearchResult } from './services/database.js';
export { DocumentParser } from './services/doc-parser.js';
export type { DocumentMetadata } from './services/doc-parser.js';
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
  rebuildAllEmbeddings
} from './services/embeddings.js';
export { getLLMSettings, saveLLMSettings, testLLMConnection, generateMetadata } from './services/llm.js';
export type { LLMSettings, LLMProvider, AIMetadata } from './services/llm.js';
