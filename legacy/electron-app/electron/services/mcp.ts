import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { DatabaseService } from './database';
import { IndexerService } from './indexer';
import { UdfParser } from './udf-parser';
import { generateEmbedding } from './embeddings';
import * as fs from 'node:fs';

let server: FastMCP | null = null;
let currentPort = 3012;

export const McpServerService = {
  isRunning(): boolean {
    return server !== null;
  },

  getCurrentPort(): number {
    return currentPort;
  },

  async start(port: number): Promise<void> {
    if (server) {
      await this.stop();
    }

    currentPort = port;
    server = new FastMCP({
      name: 'IzBul-Reborn',
      version: '2.0.0',
    });

    // 1. Search tool
    server.addTool({
      name: 'search_index',
      description: 'Arama dizinindeki belgeler arasında arama yapar. Keyword (anahtar kelime), semantic (anlamsal) veya hybrid (hibrit) arama modlarını destekler.',
      parameters: z.object({
        query: z.string().describe('Aranacak kelimeler, cümle veya gelişmiş boolean sorgusu'),
        mode: z.enum(['keyword', 'semantic', 'hybrid']).optional().default('hybrid').describe('Arama modu: keyword (anahtar kelime), semantic (anlamsal), hybrid (hibrit/RRF)')
      }),
      execute: async ({ query, mode = 'hybrid' }) => {
        try {
          let queryEmbedding: Float32Array | undefined;
          if (mode === 'semantic' || mode === 'hybrid') {
            try {
              queryEmbedding = await generateEmbedding(query);
            } catch (err) {
              console.error('[MCP] Failed to generate embedding for query:', err);
            }
          }

          const results = DatabaseService.search(query, mode, queryEmbedding);
          return JSON.stringify({
            success: true,
            query,
            mode,
            count: results.length,
            results
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 2. Status tool
    server.addTool({
      name: 'index_status',
      description: 'Mevcut arama dizini istatistiklerini ve izlenen klasör konfigürasyonunu döner.',
      parameters: z.object({}),
      execute: async () => {
        try {
          const folders = DatabaseService.getFolders().map(f => f.path);
          const files = DatabaseService.getAllFiles();
          const indexed = files.filter(f => f.status === 'indexed').length;
          const pending = files.filter(f => f.status === 'pending').length;
          const failed = files.filter(f => f.status === 'failed').length;

          return JSON.stringify({
            success: true,
            status: IndexerService.isCurrentlyIndexing() ? 'indexing' : 'idle',
            monitoredFoldersCount: folders.length,
            folders,
            totalFilesCount: files.length,
            indexedCount: indexed,
            pendingCount: pending,
            failedCount: failed
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 3. Add watch directory tool
    server.addTool({
      name: 'add_watch_directory',
      description: 'Arama dizinine yeni bir klasör ekler ve gerçek zamanlı izlemeyi başlatır.',
      parameters: z.object({
        folderPath: z.string().describe('Eklenecek klasörün mutlak yolu')
      }),
      execute: async ({ folderPath }) => {
        try {
          DatabaseService.addFolder(folderPath);
          IndexerService.startWatchingFolder(folderPath);

          // Trigger scan in background
          IndexerService.scanAllRegisteredFolders().catch(console.error);

          return JSON.stringify({
            success: true,
            message: `Klasör başarıyla eklendi ve tarama kuyruğuna alındı: ${folderPath}`
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 4. Read UDF tool
    server.addTool({
      name: 'read_udf',
      description: 'Belirtilen mutlak yoldaki UDF (.udf) dosyasının içeriğini ayrıştırarak temiz metin olarak okur.',
      parameters: z.object({
        filePath: z.string().describe('Okunacak UDF dosyasının mutlak yolu')
      }),
      execute: async ({ filePath }) => {
        try {
          if (!filePath.toLowerCase().endsWith('.udf')) {
            throw new Error('Geçersiz dosya uzantısı. Yalnızca .udf dosyaları okunabilir.');
          }
          if (!fs.existsSync(filePath)) {
            throw new Error(`Dosya bulunamadı: ${filePath}`);
          }

          const content = await UdfParser.parse(filePath);
          return JSON.stringify({
            success: true,
            filePath,
            content
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            filePath,
            error: err?.message || String(err)
          });
        }
      }
    });

    // 5. Update UDF metadata tool
    server.addTool({
      name: 'update_udf_metadata',
      description: 'Belirtilen UDF belgesinin özet, etiket veya diğer hukuki bilgilerini (mahkeme adı, esas no, davacı, davalı, belge türü) el ile günceller.',
      parameters: z.object({
        filePath: z.string().describe('Metadataları güncellenecek dosyanın mutlak yolu'),
        summary: z.string().optional().describe('Dosya özeti'),
        tags: z.array(z.string()).optional().describe('Dosya etiketleri (örn: ["kira", "tahliye"])'),
        case_number: z.string().optional().describe('Esas veya dosya numarası'),
        court_name: z.string().optional().describe('Mahkeme adı'),
        document_type: z.string().optional().describe('Belge türü'),
        plaintiff: z.string().optional().describe('Davacı / Müşteki'),
        defendant: z.string().optional().describe('Davalı / Sanık')
      }),
      execute: async ({ filePath, summary, tags, case_number, court_name, document_type, plaintiff, defendant }) => {
        try {
          const file = DatabaseService.getFile(filePath);
          if (!file) {
            throw new Error(`Dosya veritabanında bulunamadı: ${filePath}`);
          }
          if (file.id === undefined) {
            throw new Error(`Dosya veritabanında kayıtlı fakat geçerli bir ID'ye sahip değil: ${filePath}`);
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
            message: `Dosya metadatası başarıyla güncellendi: ${filePath}`
          });
        } catch (err: any) {
          return JSON.stringify({
            success: false,
            error: err?.message || String(err)
          });
        }
      }
    });

    // Start server on httpStream SSE transport
    await server.start({
      transportType: 'httpStream',
      httpStream: {
        port,
        host: 'localhost',
        endpoint: '/mcp'
      }
    });

    console.log(`[FastMCP] Server successfully started on port ${port} at /mcp`);
  },

  async stop(): Promise<void> {
    if (!server) return;
    try {
      await server.stop();
      console.log('[FastMCP] Server successfully stopped.');
    } catch (err) {
      console.error('[FastMCP] Failed to stop server:', err);
    } finally {
      server = null;
    }
  }
};
