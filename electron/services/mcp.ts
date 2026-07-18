import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { DatabaseService } from './database';
import { IndexerService } from './indexer';

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
      name: 'TBB-IzBul-Reborn',
      version: '2.0.0',
    });

    // 1. Search tool
    server.addTool({
      name: 'search_index',
      description: 'Arama dizinindeki UDF belgelerinin içeriğinde ve PDF/DOCX dosya isimlerinde arama yapar. Gelişmiş boolean ve mantıksal arama sorgularını destekler (AND, OR, NOT, parantez gruplamaları, çift tırnaklı tam ifade eşleşmeleri ve eksi "-" işaretiyle kelime hariç tutma).',
      parameters: z.object({
        query: z.string().describe('Aranacak kelimeler veya gelişmiş boolean sorgusu (örn: \'"kira sözleşmesi" OR "kira bedeli" -tahliye\', \'(tahliye OR ihtar) NOT taslak\')')
      }),
      execute: async ({ query }) => {
        try {
          const results = DatabaseService.searchContent(query);
          return JSON.stringify({
            success: true,
            query,
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
