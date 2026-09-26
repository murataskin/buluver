import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { DatabaseService, getDbPath } from './database.js';
import { IndexerService } from './indexer.js';
import { DocumentParser } from './doc-parser.js';
import {
  generateEmbedding,
  getActiveEmbeddingModel,
  setActiveEmbeddingModel,
  getChunkSettings,
  setChunkSettings,
  rebuildAllEmbeddings
} from './embeddings.js';
import {
  getLLMSettings,
  saveLLMSettings,
  testLLMConnection,
  type LLMProvider
} from './llm.js';
import * as fs from 'node:fs';

let server: FastMCP | null = null;

export const McpServerService = {
  isRunning(): boolean {
    return server !== null;
  },

  createServer(): FastMCP {
    const s = new FastMCP({
      name: 'buluver',
      version: '1.0.0',
    });

    // 1. Search tool
    s.addTool({
      name: 'search',
      description: 'Hukuk belgeleri (UDF, DOCX, PDF, TXT) arasında tam metin (FTS5) ve anlamsal (vektör/hybrid RRF) arama yapar. Mahkeme, esas no, davacı, davalı ve özet bilgilerini döner.',
      parameters: z.object({
        query: z.string().describe('Aranacak hukuki kavram, ifade, esas/karar numarası veya taraf adı'),
        mode: z.enum(['keyword', 'semantic', 'hybrid', 'infix', 'trigram']).optional().default('keyword').describe('Arama modu: keyword (FTS5 tam metin - varsayılan), hybrid (RRF birleştirilmiş), semantic (vektör benzerliği), infix/trigram (kelime ortasından/parçadan arama)'),
        limit: z.number().optional().default(20).describe('Döndürülecek maksimum sonuç sayısı (varsayılan: 20)')
      }),
      execute: async ({ query, mode = 'keyword', limit = 20 }) => {
        try {
          const effectiveMode = (mode === 'trigram' ? 'infix' : mode) as 'keyword' | 'semantic' | 'hybrid' | 'infix';
          let queryEmbedding: Float32Array | undefined;
          if (effectiveMode === 'semantic' || effectiveMode === 'hybrid') {
            try {
              queryEmbedding = await generateEmbedding(query);
            } catch (err) {
              console.error('[MCP] Vektör oluşturulamadı, keyword moduna düşülüyor:', err);
            }
          }

          const results = DatabaseService.search(query, effectiveMode, queryEmbedding, limit);
          return JSON.stringify({
            success: true,
            query,
            mode: effectiveMode,
            count: results.length,
            results
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 2. Read document tool
    s.addTool({
      name: 'read_document',
      description: 'Belirtilen mutlak yoldaki UDF (.udf), Word (.docx, .doc), PDF (.pdf) veya metin dosyasının içeriğini ayrıştırarak temiz metin ve hukuki metadatalarını (mahkeme, esas no, taraflar) döner.',
      parameters: z.object({
        filePath: z.string().describe('Okunacak belgenin mutlak dosya yolu')
      }),
      execute: async ({ filePath }) => {
        try {
          if (!fs.existsSync(filePath)) {
            throw new Error(`Dosya bulunamadı: ${filePath}`);
          }
          if (!DocumentParser.isSupported(filePath)) {
            throw new Error(`Desteklenmeyen dosya türü. Desteklenenler: .udf, .docx, .doc, .pdf, .txt, .md`);
          }

          const content = await DocumentParser.parse(filePath);
          const metadata = DocumentParser.extractMetadataHeuristics(content, filePath.split(/[/\\]/).pop() || '');

          return JSON.stringify({
            success: true,
            filePath,
            charCount: content.length,
            metadata,
            content
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            filePath,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 3. Index status tool
    s.addTool({
      name: 'status',
      description: 'Buluver arama dizini istatistiklerini, izlenen klasörleri ve indekslenen belge sayılarını döner.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const stats = DatabaseService.getStats();
          const folders = DatabaseService.getFolders().map(f => f.path);
          const llm = getLLMSettings();
          const activeModel = getActiveEmbeddingModel();
          const chunking = getChunkSettings();

          return JSON.stringify({
            success: true,
            status: IndexerService.isCurrentlyIndexing() ? 'indexing' : 'idle',
            ...stats,
            folders,
            config: {
              activeEmbeddingModel: activeModel,
              chunkSize: chunking.chunkSize,
              chunkOverlap: chunking.chunkOverlap,
              llmProvider: llm.provider,
              llmModel: llm.model,
              llmBaseUrl: llm.baseUrl
            }
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 4. Get Configuration Tool
    s.addTool({
      name: 'get_config',
      description: 'Mevcut vektör embedding modelini, chunklama boyutlarını ve LLM bağlantı ayarlarını döner.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const llm = getLLMSettings();
          const activeEmbeddingModel = getActiveEmbeddingModel();
          const chunkSettings = getChunkSettings();
          const stats = DatabaseService.getStats();

          return JSON.stringify({
            success: true,
            embedding: {
              activeModel: activeEmbeddingModel,
              chunkSize: chunkSettings.chunkSize,
              chunkOverlap: chunkSettings.chunkOverlap,
              totalVectorChunks: stats.totalChunks
            },
            llm: {
              provider: llm.provider,
              model: llm.model,
              baseUrl: llm.baseUrl,
              apiKeyConfigured: Boolean(llm.apiKey)
            },
            database: {
              path: getDbPath(),
              totalIndexedFiles: stats.indexedFiles,
              monitoredFoldersCount: stats.monitoredFolders
            }
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 5. Set Configuration Tool
    s.addTool({
      name: 'set_config',
      description: 'Vektör embedding modelini, chunk ayarlarını veya LLM bağlantısını (Ollama/OpenAI/Gemini) yapılandırır. İsteğe bağlı olarak mevcut tüm belgelerin vektörlerini yeni modelle baştan üretir.',
      parameters: z.object({
        embedding_model: z.string().optional().describe('Kullanılacak ONNX embedding modeli (örn: "Xenova/paraphrase-multilingual-MiniLM-L12-v2")'),
        chunk_size: z.number().optional().describe('Metin parçalama boyutu (karakter sayısı, örn: 800)'),
        chunk_overlap: z.number().optional().describe('Metin parçalama örtüşme boyutu (karakter sayısı, örn: 150)'),
        rebuild_embeddings: z.boolean().optional().default(false).describe('Ayar değiştikten sonra tüm indeksli belgelerin vektörlerini baştan üret (arka planda çalışır)'),
        llm_provider: z.enum(['ollama', 'openai', 'gemini']).optional().describe('LLM sağlayıcısı'),
        llm_model: z.string().optional().describe('LLM model adı (örn: "qwen2.5:3b", "gpt-4o-mini", "gemini-1.5-flash")'),
        llm_base_url: z.string().optional().describe('LLM API servis adresi (örn: "http://localhost:11434")'),
        llm_api_key: z.string().optional().describe('LLM API anahtarı (OpenAI veya Gemini için)')
      }),
      execute: async ({
        embedding_model,
        chunk_size,
        chunk_overlap,
        rebuild_embeddings = false,
        llm_provider,
        llm_model,
        llm_base_url,
        llm_api_key
      }) => {
        try {
          const updated: Record<string, any> = {};

          if (embedding_model) {
            setActiveEmbeddingModel(embedding_model);
            updated.embedding_model = embedding_model;
          }

          if (chunk_size !== undefined || chunk_overlap !== undefined) {
            setChunkSettings(chunk_size, chunk_overlap);
            updated.chunkSettings = getChunkSettings();
          }

          const llmUpdates: any = {};
          if (llm_provider) llmUpdates.provider = llm_provider as LLMProvider;
          if (llm_model) llmUpdates.model = llm_model;
          if (llm_base_url) llmUpdates.baseUrl = llm_base_url;
          if (llm_api_key !== undefined) llmUpdates.apiKey = llm_api_key;
          if (Object.keys(llmUpdates).length > 0) {
            saveLLMSettings(llmUpdates);
            updated.llm = getLLMSettings();
          }

          let rebuildStatus = 'not_requested';
          if (rebuild_embeddings) {
            rebuildStatus = 'started_in_background';
            rebuildAllEmbeddings().then((res) => {
              console.log(`[MCP] Vektörler baştan üretildi: ${res.totalFiles} dosya, ${res.totalChunks} chunk.`);
            }).catch(console.error);
          }

          return JSON.stringify({
            success: true,
            message: 'Yapılandırma başarıyla güncellendi.',
            updated,
            rebuildStatus
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 6. Test LLM Tool
    s.addTool({
      name: 'test_llm',
      description: 'Yapılandırılmış LLM sağlayıcısına (Ollama/OpenAI/Gemini) bağlantıyı test eder.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const res = await testLLMConnection();
          const current = getLLMSettings();
          return JSON.stringify({
            success: res.ok,
            message: res.message,
            provider: current.provider,
            model: current.model,
            baseUrl: current.baseUrl
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 7. Rebuild Embeddings Tool
    s.addTool({
      name: 'rebuild_embeddings',
      description: 'Tüm indeksli belgelerin vektör embeddinglerini aktif model ve chunk ayarlarıyla baştan hesaplar.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const res = await rebuildAllEmbeddings();
          return JSON.stringify({
            success: true,
            message: 'Vektör embeddingleri başarıyla yeniden üretildi.',
            ...res
          }, null, 2);
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 8. Add watch folder tool
    s.addTool({
      name: 'add_folder',
      description: 'Arama dizinine yeni bir klasör ekler ve isteğe bağlı olarak hemen tarama başlatır.',
      parameters: z.object({
        folderPath: z.string().describe('İzlenecek ve indekslenecek klasörün mutlak yolu'),
        scanNow: z.boolean().optional().default(true).describe('Klasör eklendikten sonra hemen indekslensin mi?')
      }),
      execute: async ({ folderPath, scanNow = true }) => {
        try {
          if (!fs.existsSync(folderPath)) {
            throw new Error(`Klasör mevcut değil: ${folderPath}`);
          }

          DatabaseService.addFolder(folderPath);
          IndexerService.startWatchingFolder(folderPath);

          if (scanNow) {
            IndexerService.scanAllRegisteredFolders().catch(console.error);
          }

          return JSON.stringify({
            success: true,
            message: `Klasör başarıyla eklendi: ${folderPath}`,
            scanning: scanNow
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 9. Remove folder tool
    s.addTool({
      name: 'remove_folder',
      description: 'İzlenen bir klasörü ve o klasöre ait indekslenmiş belgeleri dizinden siler.',
      parameters: z.object({
        folderPath: z.string().describe('Silinecek klasörün mutlak yolu')
      }),
      execute: async ({ folderPath }) => {
        try {
          IndexerService.stopWatchingFolder(folderPath);
          DatabaseService.removeFolder(folderPath);
          return JSON.stringify({
            success: true,
            message: `Klasör ve ilişkili belgeler dizinden kaldırıldı: ${folderPath}`
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 10. Trigger scan tool
    s.addTool({
      name: 'trigger_scan',
      description: 'Kayıtlı tüm klasörleri tarayarak yeni ve değişen belgeleri dizine ekler.',
      parameters: z.object({
        withEmbeddings: z.boolean().optional().default(true).describe('Vektör embeddingleri de oluşturulsun mu?')
      }),
      execute: async ({ withEmbeddings = true }) => {
        try {
          if (IndexerService.isCurrentlyIndexing()) {
            return JSON.stringify({
              success: false,
              message: 'İndeksleme işlemi zaten arka planda çalışıyor.'
            });
          }

          IndexerService.scanAllRegisteredFolders({ withEmbeddings }).catch(console.error);

          return JSON.stringify({
            success: true,
            message: 'Tüm kayıtlı klasörler için tarama işlemi başlatıldı.'
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 11. Update document metadata tool
    s.addTool({
      name: 'update_document_metadata',
      description: 'Belirtilen belgenin özet, etiket veya hukuki bilgilerini (mahkeme, esas no, davacı, davalı, belge türü) el ile günceller.',
      parameters: z.object({
        filePath: z.string().describe('Metadatası güncellenecek dosyanın mutlak yolu'),
        summary: z.string().optional().describe('Belge özeti'),
        tags: z.array(z.string()).optional().describe('Etiketler (ör: ["kira", "tahliye"])'),
        case_number: z.string().optional().describe('Esas veya dosya numarası'),
        court_name: z.string().optional().describe('Mahkeme adı'),
        document_type: z.string().optional().describe('Belge türü'),
        plaintiff: z.string().optional().describe('Davacı / Müşteki'),
        defendant: z.string().optional().describe('Davalı / Sanık')
      }),
      execute: async ({ filePath, summary, tags, case_number, court_name, document_type, plaintiff, defendant }) => {
        try {
          const file = DatabaseService.getFile(filePath);
          if (!file || file.id === undefined) {
            throw new Error(`Dosya veritabanında bulunamadı: ${filePath}`);
          }

          DatabaseService.upsertFileMetadata(file.id, {
            summary,
            tags,
            case_number,
            court_name,
            document_type,
            plaintiff,
            defendant
          });

          return JSON.stringify({
            success: true,
            message: `Belge metadatası başarıyla güncellendi: ${filePath}`
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    return s;
  },

  async startStdio(): Promise<void> {
    if (server) await this.stop();
    server = this.createServer();
    await server.start({
      transportType: 'stdio'
    });
  },

  async startSse(port = 3012): Promise<void> {
    if (server) await this.stop();
    server = this.createServer();
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port,
        host: 'localhost',
        endpoint: '/mcp'
      }
    });
    console.log(`[Buluver FastMCP] SSE Server listening on port ${port} at http://localhost:${port}/mcp`);
  },

  async stop(): Promise<void> {
    if (!server) return;
    try {
      await server.stop();
    } catch (err) {
      console.error('[Buluver FastMCP] Stop error:', err);
    } finally {
      server = null;
    }
  }
};
