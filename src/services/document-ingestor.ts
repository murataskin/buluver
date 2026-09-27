import * as path from 'node:path';
import * as fs from 'node:fs';
import { DocumentParser, type DocumentMetadata } from './doc-parser.js';
import { generateMetadata } from './llm.js';
import { chunkText, generateEmbedding } from './embeddings.js';
import type { IndexableDocument, IndexableChunk } from './document-repository.js';

export interface IngestTask {
  path: string;
  mtimeMs: number;
  size: number;
  body?: string;
}

export interface IngestionOptions {
  withEmbeddings?: boolean;
  withAiMetadata?: boolean;
  customEmbedder?: (text: string) => Promise<Float32Array>;
  customAiGenerator?: (text: string) => Promise<{ summary?: string; tags?: string[] }>;
}

export interface IngestedDocumentPayload extends IndexableDocument {
  parsedTextLength: number;
}

/**
 * DocumentIngestor is the deep module encapsulating text extraction,
 * legal heuristic metadata extraction, AI summary synthesis, and
 * vector chunk generation into an atomic IndexableDocument.
 */
export const DocumentIngestor = {
  /**
   * Ingests a single document from filesystem or pre-extracted body.
   * Resilient to partial failures (embedding / AI failure preserves raw document).
   */
  async ingest(
    task: IngestTask,
    options: IngestionOptions = {}
  ): Promise<IngestedDocumentPayload> {
    const filename = path.basename(task.path);
    const extension = path.extname(task.path).toLowerCase();

    // 1. Text extraction (use pre-parsed body if provided, else parse)
    let body = task.body ?? '';
    let status: 'indexed' | 'pending' | 'failed' = 'indexed';
    let errorMsg: string | undefined;

    if (task.body === undefined) {
      try {
        body = await DocumentParser.parse(task.path);
      } catch (err: any) {
        body = '';
        status = 'failed';
        errorMsg = err?.message || String(err);
      }
    }

    const cleanBody = body ? body.trim() : '';

    // 2. Fast regex heuristics parse (Court name, Esas no, Davacı, Davalı)
    let metadata: Partial<DocumentMetadata> = cleanBody
      ? DocumentParser.extractMetadataHeuristics(cleanBody, filename)
      : { document_type: filename.replace(/\.[^/.]+$/, '').slice(0, 100).trim() };

    // 3. Optional AI metadata generation
    if (options.withAiMetadata && cleanBody.length > 50) {
      try {
        const aiGenerator = options.customAiGenerator ?? generateMetadata;
        const aiMeta = await aiGenerator(cleanBody);
        metadata = {
          ...metadata,
          summary: aiMeta.summary,
          tags: aiMeta.tags
        };
      } catch (aiErr) {
        console.error(`[Ingestor:AI] Metadata generation failed for ${task.path}:`, aiErr);
      }
    }

    // 4. Optional local vector embeddings generation
    let chunks: IndexableChunk[] | undefined;
    if (options.withEmbeddings && cleanBody.length > 0) {
      const textChunks = chunkText(cleanBody);
      if (textChunks.length > 0) {
        chunks = [];
        const embedder = options.customEmbedder ?? generateEmbedding;
        for (let i = 0; i < textChunks.length; i++) {
          try {
            const embedding = await embedder(textChunks[i]);
            chunks.push({
              chunkIndex: i,
              text: textChunks[i],
              embedding
            });
          } catch (embErr) {
            console.error(`[Ingestor:Embedding] Failed on chunk ${i} of ${task.path}:`, embErr);
          }
        }
      }
    }

    return {
      path: task.path,
      filename,
      extension,
      mtime: task.mtimeMs,
      size: task.size,
      body: cleanBody,
      status,
      errorMsg,
      metadata,
      chunks,
      parsedTextLength: cleanBody.length
    };
  },

  /**
   * Ingests a batch of documents sequentially or with bounded concurrency.
   */
  async ingestBatch(
    tasks: IngestTask[],
    options: IngestionOptions = {}
  ): Promise<IngestedDocumentPayload[]> {
    const results: IngestedDocumentPayload[] = [];
    for (const task of tasks) {
      const doc = await this.ingest(task, options);
      results.push(doc);
    }
    return results;
  }
};
