#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { DatabaseService, getDbPath } from './services/database.js';
import { IndexerService } from './services/indexer.js';
import { DocumentParser } from './services/doc-parser.js';
import { McpServerService } from './services/mcp.js';
import {
  generateEmbedding,
  getActiveEmbeddingModel,
  setActiveEmbeddingModel,
  getChunkSettings,
  setChunkSettings,
  rebuildAllEmbeddings
} from './services/embeddings.js';
import {
  getLLMSettings,
  saveLLMSettings,
  testLLMConnection,
  type LLMProvider
} from './services/llm.js';
import {
  installSkill,
  BULUVER_SKILL_CONTENT
} from './services/skill.js';

const program = new Command();

program
  .name('buluver')
  .description('Buluver: Yüksek performanslı Türk hukuk belgesi (UDF, DOCX, DOC, PDF) arama motoru, CLI ve AI MCP sunucusu')
  .version('1.0.0');

// 1. MCP Server Command
program
  .command('mcp')
  .description('AI ajanları (Claude Desktop, Antigravity, Cursor) için FastMCP sunucusunu başlatır')
  .option('-t, --transport <type>', 'Transport türü: stdio veya sse', 'stdio')
  .option('-p, --port <number>', 'SSE transport için port numarası', '3012')
  .action(async (options) => {
    if (options.transport === 'sse') {
      const port = parseInt(options.port, 10) || 3012;
      await McpServerService.startSse(port);
    } else {
      // stdio mode (default)
      await McpServerService.startStdio();
    }
  });

// 2. Search Command
program
  .command('search <query>')
  .description('Dizinlenmiş belgeler arasında anahtar kelime, vektör veya hibrit arama yapar')
  .option('-m, --mode <mode>', 'Arama modu: keyword, hybrid, semantic veya infix (trigram parça arama)', 'keyword')
  .option('-l, --limit <number>', 'Maksimum sonuç sayısı', '10')
  .option('--json', 'Sonuçları ham JSON olarak yazdır')
  .action(async (query, options) => {
    let mode = options.mode as 'keyword' | 'hybrid' | 'semantic' | 'infix';
    if ((options.mode as string) === 'trigram') {
      mode = 'infix';
    }
    const limit = parseInt(options.limit, 10) || 10;

    if (mode === 'infix' && query.trim().length < 3) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'Trigram (infix) araması en az 3 karakter gerektirir.' }));
      } else {
        console.log(pc.yellow(`\n⚠️  Trigram (infix) araması en az 3 karakter gerektirir.\n`));
      }
      return;
    }

    let queryEmbedding: Float32Array | undefined;
    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        queryEmbedding = await generateEmbedding(query);
      } catch (err: any) {
        if (!options.json) {
          console.warn(pc.yellow(`⚠️  Vektör embedding modeli yüklenemedi (${err?.message}), sadece keyword aranıyor.`));
        }
      }
    }

    const results = DatabaseService.search(query, mode, queryEmbedding, limit);

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(pc.yellow(`\nSonuç bulunamadı: "${query}"\n`));
      return;
    }

    console.log(pc.bold(pc.cyan(`\n🔍 Buluver Arama Sonuçları (${results.length} eşleşme - Mod: ${mode}):\n`)));

    results.forEach((r, idx) => {
      console.log(pc.bold(pc.green(`${idx + 1}. ${r.filename}`)));
      console.log(pc.dim(`   Dosya: ${r.path}`));
      if (r.score !== undefined) {
        console.log(pc.dim(`   Skor: ${r.score.toFixed(4)}`));
      }

      if (r.metadata) {
        const parts: string[] = [];
        if (r.metadata.court_name) parts.push(`Mahkeme: ${r.metadata.court_name}`);
        if (r.metadata.case_number) parts.push(`Esas: ${r.metadata.case_number}`);
        if (r.metadata.plaintiff) parts.push(`Davacı: ${r.metadata.plaintiff}`);
        if (r.metadata.defendant) parts.push(`Davalı: ${r.metadata.defendant}`);
        if (parts.length > 0) {
          console.log(pc.magenta(`   📋 ${parts.join(' | ')}`));
        }
        if (r.metadata.summary) {
          console.log(pc.italic(pc.blue(`   💡 Özet: ${r.metadata.summary}`)));
        }
      }

      if (r.snippet) {
        const cleanSnippet = r.snippet.replace(/<b>/g, '\x1b[1m\x1b[33m').replace(/<\/b>/g, '\x1b[0m');
        console.log(`   ${cleanSnippet}`);
      }
      console.log('');
    });
  });

// 3. Add Folder Command
program
  .command('add <folderPath>')
  .description('Dizine yeni bir klasör ekler')
  .option('-i, --index', 'Klasörü ekledikten sonra hemen indeksle', false)
  .option('--no-embeddings', 'İndeksleme sırasında embedding oluşturmayı atla')
  .action(async (folderPath, options) => {
    const absPath = path.resolve(folderPath);
    if (!fs.existsSync(absPath)) {
      console.error(pc.red(`Hata: Belirtilen klasör mevcut değil: ${absPath}`));
      process.exit(1);
    }

    DatabaseService.addFolder(absPath);
    console.log(pc.green(`✔ Klasör izleme listesine eklendi: ${absPath}`));

    if (options.index) {
      console.log(pc.cyan(`Klasör indeksleniyor...`));
      const res = await IndexerService.scanAllRegisteredFolders({ withEmbeddings: options.embeddings !== false });
      console.log(pc.green(`✔ İndeksleme tamamlandı. Taranan: ${res.scanned}, İndekslenen: ${res.parsed}, Değişmeyen: ${res.skipped}`));
      await IndexerService.destroyPool();
      process.exit(0);
    }
  });

// 4. Remove Folder Command
program
  .command('remove <folderPath>')
  .description('İzlenen bir klasörü ve belgelerini dizinden kaldırır')
  .action((folderPath) => {
    const absPath = path.resolve(folderPath);
    DatabaseService.removeFolder(absPath);
    console.log(pc.green(`✔ Klasör ve indeksleri silindi: ${absPath}`));
  });

// 5. List Folders Command
program
  .command('folders')
  .description('İzlenen klasörlerin listesini gösterir')
  .action(() => {
    const folders = DatabaseService.getFolders();
    if (folders.length === 0) {
      console.log(pc.yellow('Henüz izlenen bir klasör eklenmemiş. "buluver add <klasör>" komutu ile ekleyebilirsiniz.'));
      return;
    }

    console.log(pc.bold(pc.cyan('\n📁 İzlenen Klasörler:\n')));
    folders.forEach((f, idx) => {
      const date = new Date(f.added_at).toLocaleString();
      console.log(`  ${idx + 1}. ${pc.bold(f.path)} ${pc.dim(`(Eklenme: ${date})`)}`);
    });
    console.log('');
  });

// 6. Index Command
program
  .command('index [folderPath]')
  .description('Kayıtlı klasörleri veya belirtilen klasörü tarayıp belgeleri indeksler')
  .option('--no-embeddings', 'Embedding üretimini atla (yalnızca tam metin FTS)')
  .option('--ai', 'LLM ile özet ve etiket üretimi yap')
  .action(async (folderPath, options) => {
    if (folderPath) {
      const absPath = path.resolve(folderPath);
      if (!fs.existsSync(absPath)) {
        console.error(pc.red(`Hata: Klasör mevcut değil: ${absPath}`));
        process.exit(1);
      }
      DatabaseService.addFolder(absPath);
    }

    console.log(pc.cyan('🔄 İndeksleme başlatılıyor...'));
    IndexerService.setProgressCallback((st) => {
      if (st.info) {
        process.stdout.write(`\r${pc.dim(st.info)} [${st.progress}%]`);
      }
    });

    const res = await IndexerService.scanAllRegisteredFolders({
      withEmbeddings: options.embeddings !== false,
      withAiMetadata: Boolean(options.ai)
    });
    await IndexerService.destroyPool();

    console.log('\n');
    console.log(pc.bold(pc.green('✔ İndeksleme başarıyla tamamlandı:')));
    console.log(`  • Taranan dosya:     ${res.scanned}`);
    console.log(`  • İndekslenen dosya: ${res.parsed}`);
    console.log(`  • Atlanan (aynı):    ${res.skipped}`);
    console.log(`  • Silinen dosya:     ${res.removed}`);
    process.exit(0);
  });

// 7. Watch Command
program
  .command('watch [folderPath]')
  .description('Klasörleri gerçek zamanlı izler ve yeni/değişen belgeleri otomatik indeksler')
  .option('--no-embeddings', 'Embedding üretimini atla')
  .action(async (folderPath, options) => {
    if (folderPath) {
      const absPath = path.resolve(folderPath);
      if (!fs.existsSync(absPath)) {
        console.error(pc.red(`Hata: Klasör mevcut değil: ${absPath}`));
        process.exit(1);
      }
      DatabaseService.addFolder(absPath);
    }

    const folders = DatabaseService.getFolders();
    if (folders.length === 0) {
      console.error(pc.yellow('İzlenecek klasör bulunamadı. Lütfen önce "buluver add <klasör>" komutu ile bir klasör ekleyin.'));
      process.exit(1);
    }

    console.log(pc.bold(pc.cyan(`\n👀 Buluver Canlı İzleme Başlatıldı (${folders.length} klasör izleniyor)...`)));
    folders.forEach(f => console.log(pc.dim(`   • ${f.path}`)));
    console.log(pc.dim('Durdurmak için Ctrl+C tuşlarına basın.\n'));

    IndexerService.setProgressCallback((st) => {
      if (st.info) {
        console.log(pc.blue(`[${new Date().toLocaleTimeString()}] ${st.info}`));
      }
    });

    IndexerService.startWatchingAll({ withEmbeddings: options.embeddings !== false });

    // Keep process running
    await new Promise(() => {});
  });

// 8. Read Document Command
program
  .command('read <filePath>')
  .description('UDF, DOCX, DOC veya PDF dosyasını ayrıştırarak içeriğini ve metadatasını ekrana yazar')
  .option('--meta-only', 'Yalnızca çıkarılan hukuki metadatayı göster')
  .action(async (filePath, options) => {
    const absPath = path.resolve(filePath);
    if (!fs.existsSync(absPath)) {
      console.error(pc.red(`Hata: Dosya bulunamadı: ${absPath}`));
      process.exit(1);
    }

    try {
      const content = await DocumentParser.parse(absPath);
      const metadata = DocumentParser.extractMetadataHeuristics(content, path.basename(absPath));

      console.log(pc.bold(pc.cyan(`\n📄 Belge: ${path.basename(absPath)}`)));
      console.log(pc.dim(`Yol: ${absPath}`));
      console.log(pc.dim(`Karakter Sayısı: ${content.length}\n`));

      console.log(pc.bold('📋 Çıkarılan Hukuki Bilgiler:'));
      console.log(`  • Mahkeme/Makam: ${metadata.court_name || pc.dim('(Bulunamadı)')}`);
      console.log(`  • Esas/Karar No: ${metadata.case_number || pc.dim('(Bulunamadı)')}`);
      console.log(`  • Davacı/Talep:  ${metadata.plaintiff || pc.dim('(Bulunamadı)')}`);
      console.log(`  • Davalı/Karşı:  ${metadata.defendant || pc.dim('(Bulunamadı)')}`);
      console.log(`  • Belge Türü:    ${metadata.document_type || pc.dim('(Bulunamadı)')}`);

      if (!options.metaOnly) {
        console.log(pc.bold('\n📝 Metin İçeriği:'));
        console.log(pc.dim('─'.repeat(60)));
        console.log(content.slice(0, 4000));
        if (content.length > 4000) {
          console.log(pc.dim(`\n... (${content.length - 4000} karakter daha var) ...`));
        }
        console.log(pc.dim('─'.repeat(60)));
      }
    } catch (err: any) {
      console.error(pc.red(`Ayrıştırma hatası: ${err?.message || err}`));
    }
  });

// 9. Status Command
program
  .command('status')
  .description('Buluver veritabanı, vektör ve indeks durumunu gösterir')
  .action(() => {
    const stats = DatabaseService.getStats();
    const settings = getLLMSettings();
    const activeModel = getActiveEmbeddingModel();
    const chunking = getChunkSettings();

    console.log(pc.bold(pc.cyan('\n📊 Buluver Sistem Durumu:\n')));
    console.log(`  • Veritabanı Yolu:     ${pc.bold(getDbPath())}`);
    console.log(`  • İzlenen Klasör:      ${pc.green(String(stats.monitoredFolders))}`);
    console.log(`  • Toplam Dosya:        ${pc.green(String(stats.totalFiles))}`);
    console.log(`  • İndekslenen Belge:   ${pc.green(String(stats.indexedFiles))}`);
    console.log(`  • Vektör Chunk Sayısı: ${pc.green(String(stats.totalChunks))}`);
    console.log(`  • Embedding Modeli:    ${pc.dim(activeModel)} (${chunking.chunkSize} / ${chunking.chunkOverlap})`);
    console.log(`  • LLM Sağlayıcı:       ${pc.dim(settings.provider)} (${settings.model})\n`);
  });

// 10. Reindex Embeddings Command
program
  .command('reindex-embeddings')
  .description('Aktif model ve chunklama ayarları ile tüm belgelerin vektör embeddinglerini baştan hesaplar')
  .action(async () => {
    const activeModel = getActiveEmbeddingModel();
    const chunking = getChunkSettings();
    console.log(pc.cyan(`\n🔄 Vektör embeddingleri yeniden üretiliyor...`));
    console.log(pc.dim(`   • Model: ${activeModel}`));
    console.log(pc.dim(`   • Chunk Boyutu: ${chunking.chunkSize} karakter (Örtüşme: ${chunking.chunkOverlap})`));

    const startTime = Date.now();
    const res = await rebuildAllEmbeddings((current, total, file) => {
      process.stdout.write(`\r${pc.dim(`[${current}/${total}]`)} ${file.slice(0, 40).padEnd(40)}`);
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n');
    console.log(pc.bold(pc.green(`✔ Vektör üretimi tamamlandı (${elapsed}s):`)));
    console.log(`  • İşlenen belge sayısı: ${res.totalFiles}`);
    console.log(`  • Üretilen chunk sayısı: ${res.totalChunks}\n`);
  });

// 11. Config Command and Subcommands
const configCmd = program
  .command('config')
  .description('Buluver embedding modeli, LLM ve chunking yapılandırmasını yönetir')
  .action(() => {
    const settings = getLLMSettings();
    const activeModel = getActiveEmbeddingModel();
    const chunking = getChunkSettings();
    const stats = DatabaseService.getStats();

    console.log(pc.bold(pc.cyan('\n⚙️  Buluver Yapılandırması\n')));

    console.log(pc.bold('🧠 Vektör Embedding:'));
    console.log(`  • Aktif Model:         ${pc.green(activeModel)}`);
    console.log(`  • Chunk Boyutu:        ${pc.green(String(chunking.chunkSize))} karakter`);
    console.log(`  • Chunk Örtüşmesi:     ${pc.green(String(chunking.chunkOverlap))} karakter`);
    console.log(`  • Vektör Chunk Sayısı: ${pc.green(String(stats.totalChunks))}`);

    console.log(pc.bold('\n🤖 LLM Bağlantısı:'));
    console.log(`  • Sağlayıcı:           ${pc.green(settings.provider)}`);
    console.log(`  • Model:               ${pc.green(settings.model)}`);
    console.log(`  • API Servis Adresi:   ${pc.green(settings.baseUrl)}`);
    console.log(`  • API Anahtarı:        ${settings.apiKey ? pc.green('***' + settings.apiKey.slice(-4)) : pc.yellow('(ayarlanmadı)')}`);

    console.log(pc.bold('\n🗄️  Depolama ve Dizin:'));
    console.log(`  • Veritabanı Yolu:     ${pc.dim(getDbPath())}`);
    console.log(`  • İndeksli Belge:      ${pc.dim(String(stats.indexedFiles))}`);
    console.log(`  • İzlenen Klasör:      ${pc.dim(String(stats.monitoredFolders))}\n`);

    console.log(pc.dim('Komutlar:'));
    console.log(pc.dim('  buluver config model <modelName> [--rebuild]'));
    console.log(pc.dim('  buluver config llm -p ollama|openai|gemini -m <model> -u <url> -k <key>'));
    console.log(pc.dim('  buluver config chunking --size <n> --overlap <n> [--rebuild]'));
    console.log(pc.dim('  buluver config set <anahtar> <değer>'));
    console.log(pc.dim('  buluver reindex-embeddings\n'));
  });

configCmd
  .command('set <key> <value>')
  .description('Herhangi bir ayar anahtarını doğrudan günceller')
  .action((key, value) => {
    if (key === 'active_model' || key === 'embedding_model') {
      setActiveEmbeddingModel(value);
    } else if (key === 'chunk_size') {
      setChunkSettings(parseInt(value, 10));
    } else if (key === 'chunk_overlap') {
      setChunkSettings(undefined, parseInt(value, 10));
    } else if (key === 'llm_provider') {
      saveLLMSettings({ provider: value as LLMProvider });
    } else if (key === 'llm_model') {
      saveLLMSettings({ model: value });
    } else if (key === 'llm_api_key') {
      saveLLMSettings({ apiKey: value });
    } else if (key === 'llm_base_url') {
      saveLLMSettings({ baseUrl: value });
    } else {
      DatabaseService.setSetting(key, value);
    }
    console.log(pc.green(`✔ ${key} = ${value} olarak kaydedildi.`));
  });

configCmd
  .command('model [modelName]')
  .description('Aktif ONNX vektör embedding modelini gösterir veya değiştirir')
  .option('-r, --rebuild', 'Mevcut belgelerin vektörlerini yeni modelle hemen baştan üret', false)
  .action(async (modelName, options) => {
    if (!modelName) {
      console.log(`Aktif embedding modeli: ${pc.green(getActiveEmbeddingModel())}`);
      return;
    }

    setActiveEmbeddingModel(modelName);
    console.log(pc.green(`✔ Aktif embedding modeli güncellendi: ${modelName}`));

    if (options.rebuild) {
      console.log(pc.cyan('🔄 Belgelerin vektörleri yeni modelle baştan üretiliyor...'));
      const res = await rebuildAllEmbeddings((cur, tot, file) => {
        process.stdout.write(`\r${pc.dim(`[${cur}/${tot}]`)} ${file.slice(0, 40).padEnd(40)}`);
      });
      console.log('\n' + pc.green(`✔ ${res.totalFiles} belge için ${res.totalChunks} vektör chunk'ı üretildi.`));
    }
  });

configCmd
  .command('llm')
  .description('LLM sağlayıcı ve model bağlantısını yapılandırır')
  .option('-p, --provider <provider>', 'Sağlayıcı: ollama, openai, gemini')
  .option('-m, --model <model>', 'Model adı (örn: qwen2.5:3b, gpt-4o-mini, gemini-1.5-flash)')
  .option('-u, --base-url <url>', 'API servis adresi (örn: http://localhost:11434)')
  .option('-k, --api-key <key>', 'API anahtarı')
  .action(async (options) => {
    const updates: any = {};
    if (options.provider) updates.provider = options.provider as LLMProvider;
    if (options.model) updates.model = options.model;
    if (options.baseUrl) updates.baseUrl = options.baseUrl;
    if (options.apiKey !== undefined) updates.apiKey = options.apiKey;

    if (Object.keys(updates).length === 0) {
      const current = getLLMSettings();
      console.log(pc.bold(pc.cyan('\n🤖 LLM Bağlantı Ayarları:\n')));
      console.log(`  • Sağlayıcı: ${pc.green(current.provider)}`);
      console.log(`  • Model:     ${pc.green(current.model)}`);
      console.log(`  • Base URL:  ${pc.green(current.baseUrl)}`);
      console.log(`  • API Key:   ${current.apiKey ? pc.green('***' + current.apiKey.slice(-4)) : pc.yellow('(ayarlanmadı)')}\n`);
      return;
    }

    saveLLMSettings(updates);
    const updated = getLLMSettings();
    console.log(pc.green(`✔ LLM ayarları güncellendi: ${updated.provider} (${updated.model}) [${updated.baseUrl}]`));
  });

configCmd
  .command('chunking')
  .description('Vektör metin parçalama boyutlarını yapılandırır')
  .option('-s, --size <number>', 'Parça boyutu (karakter)', (val) => parseInt(val, 10))
  .option('-o, --overlap <number>', 'Örtüşme boyutu (karakter)', (val) => parseInt(val, 10))
  .option('-r, --rebuild', 'Vektörleri yeni chunk ayarlarıyla baştan üret', false)
  .action(async (options) => {
    if (options.size !== undefined || options.overlap !== undefined) {
      setChunkSettings(options.size, options.overlap);
    }
    const current = getChunkSettings();
    console.log(pc.green(`✔ Chunk ayarları güncellendi: Boyut: ${current.chunkSize}, Örtüşme: ${current.chunkOverlap}`));

    if (options.rebuild) {
      console.log(pc.cyan('🔄 Belgelerin vektörleri yeni chunk ayarlarıyla baştan üretiliyor...'));
      const res = await rebuildAllEmbeddings();
      console.log(pc.green(`✔ ${res.totalFiles} belge için ${res.totalChunks} vektör chunk'ı üretildi.`));
    }
  });

// 12. Test LLM Connection Command
program
  .command('test-llm')
  .description('Yapılandırılmış LLM sağlayıcısına (Ollama/OpenAI/Gemini) bağlantıyı test eder')
  .action(async () => {
    const s = getLLMSettings();
    console.log(pc.cyan(`Bağlantı test ediliyor: ${s.provider} (${s.model})...`));
    const result = await testLLMConnection();
    if (result.ok) {
      console.log(pc.green(`✔ ${result.message}`));
    } else {
      console.error(pc.red(`✖ Bağlantı başarısız: ${result.message}`));
    }
  });

// 13. Skill Command
const skillCmd = program
  .command('skill')
  .description('AI ajanları için Buluver yetenek tanımını (SKILL.md) yönetir');

skillCmd
  .command('add [targetDir]')
  .description('Buluver SKILL.md dosyasını çalışma alanına (.agents/skills/buluver) veya global ajan dizinine yükler')
  .option('-g, --global', 'Global kullanıcı ajan dizinine (~/.gemini/antigravity-cli/skills/buluver) yükle', false)
  .option('-l, --local', 'Yerel çalışma alanı dizinine (.agents/skills/buluver) yükle', false)
  .option('-p, --print', 'Yetenek dosyasının (SKILL.md) içeriğini konsola yazdır', false)
  .action((targetDir, options) => {
    if (options.print) {
      console.log(BULUVER_SKILL_CONTENT);
      return;
    }

    try {
      const paths = installSkill({
        targetDir,
        global: options.global,
        local: options.local,
      });

      console.log(pc.bold(pc.green('\n✔ Buluver ajan yetenek dosyası (SKILL.md) başarıyla kuruldu:')));
      for (const p of paths) {
        console.log(`  • ${pc.cyan(p)}`);
      }
      console.log(pc.dim('\nArtık AI ajanları (Antigravity, Cursor, Claude) Buluver yeteneğini otomatik olarak keşfedip kullanabilir.\n'));
    } catch (err: any) {
      console.error(pc.red(`✖ Yetenek dosyası yüklenirken hata oluştu: ${err.message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);

