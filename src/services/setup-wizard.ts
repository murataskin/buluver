import { scanSystem, type SystemScanReport } from './system-detector.js';
import { OllamaManager } from './ollama-manager.js';
import {
  setEmbeddingProvider,
  setActiveEmbeddingModel,
  setEmbeddingsEnabled,
  getModelById,
  getDefaultModel,
  type EmbeddingProvider,
  type EmbeddingCatalogEntry
} from './embeddings.js';
import { setLlmEnabled } from './llm.js';
import { SettingsStore } from './settings-store.js';

export type SetupMode = 'fts' | 'embeddings' | 'full';

export interface SetupOptions {
  mode?: SetupMode;
  modelId?: string;
  enableEmbeddings?: boolean;
  enableLlm?: boolean;
  provider?: EmbeddingProvider;
  modelName?: string;
  installOllamaIfMissing?: boolean;
  pullModelIfMissing?: boolean;
  onLog?: (message: string) => void;
  onProgress?: (progress: { status: string; completed?: number; total?: number; percent?: number }) => void;
}

export interface SetupResult {
  success: boolean;
  mode: SetupMode;
  provider?: EmbeddingProvider;
  modelName?: string;
  message: string;
  scanReport: SystemScanReport;
}

/**
 * SetupWizard coordinates hardware detection, Ollama auto-installation,
 * model pulling, and setting active embedding configuration.
 */
export const SetupWizard = {
  async runAutoSetup(options: SetupOptions = {}): Promise<SetupResult> {
    const log = options.onLog || (() => {});
    log('Sistem donanımı ve yerel modeller taranıyor...');

    const scan = await scanSystem();
    const hw = scan.hardware;
    log(`Donanım Profili: ${hw.cpuModel} (${hw.cores} çekirdek, ${hw.ramGB} GB RAM, Tier: ${hw.tier.toUpperCase()})`);

    const targetMode: SetupMode = options.mode || (options.enableEmbeddings === false ? 'fts' : (options.enableLlm ? 'full' : 'embeddings'));

    if (targetMode === 'fts') {
      setEmbeddingsEnabled(false);
      setLlmEnabled(false);
      log('✔ Buluver FTS-Only (Tam Metin ve Trigram) modunda yapılandırıldı. Vektör ve LLM bağımlılıkları kapatıldı.');
      return {
        success: true,
        mode: 'fts',
        message: 'Buluver FTS-Only (Tam Metin ve Trigram) modunda başarıyla yapılandırıldı. Vektör ve LLM devre dışı bırakıldı.',
        scanReport: scan
      };
    }

    setEmbeddingsEnabled(true);
    setLlmEnabled(targetMode === 'full');

    const catalogModel: EmbeddingCatalogEntry = options.modelId
      ? (getModelById(options.modelId) || getDefaultModel())
      : (options.modelName ? (getModelById(options.modelName) || getDefaultModel()) : getDefaultModel());

    let targetProvider = options.provider || catalogModel.provider;
    let targetModel = options.modelName || catalogModel.modelName;

    // Handle Ollama route
    if (targetProvider === 'ollama') {
      let isRunning = scan.ollamaRunning;

      // 1. Check if binary is installed
      if (!scan.ollamaInstalled) {
        if (options.installOllamaIfMissing) {
          log('Ollama kurulu değil, otomatik kurulum başlatılıyor...');
          const installRes = await OllamaManager.installOllama();
          if (!installRes.success) {
            log(`⚠️ ${installRes.message}. Dahili ONNX motoruna geçiliyor.`);
            targetProvider = 'onnx';
            targetModel = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
          } else {
            log(`✔ ${installRes.message}`);
            isRunning = await OllamaManager.isRunning();
          }
        } else {
          log('Ollama kurulu değil. Dahili ONNX motoru kullanılacak.');
          targetProvider = 'onnx';
          targetModel = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
        }
      }

      // 2. Start daemon if installed but stopped
      if (targetProvider === 'ollama' && !isRunning) {
        log('Ollama servisi çalışmıyor, arka planda başlatılıyor...');
        const started = await OllamaManager.startDaemon();
        if (!started) {
          log('⚠️ Ollama başlatılamadı. Dahili ONNX motoruna geçiliyor.');
          targetProvider = 'onnx';
          targetModel = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
        } else {
          log('✔ Ollama servisi başlatıldı (localhost:11434).');
        }
      }

      // 3. Check if target model is installed in Ollama, pull if needed
      if (targetProvider === 'ollama') {
        const hasModel = scan.detectedModels.some(
          (m) => m.provider === 'ollama' && (m.name === targetModel || m.name.startsWith(targetModel + ':'))
        );

        if (!hasModel) {
          if (options.pullModelIfMissing !== false) {
            log(`📥 "${targetModel}" modeli Ollama kütüphanesinden indiriliyor...`);
            try {
              await OllamaManager.pullModel(targetModel, options.onProgress);
              log(`✔ "${targetModel}" modeli başarıyla indirildi.`);
            } catch (err: any) {
              log(`⚠️ Model indirme hatası: ${err?.message || err}. Dahili ONNX motoruna geçiliyor.`);
              targetProvider = 'onnx';
              targetModel = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
            }
          }
        } else {
          log(`✔ "${targetModel}" modeli Ollama üzerinde zaten mevcut.`);
        }
      }
    }

    // Apply configuration
    setEmbeddingProvider(targetProvider);
    setActiveEmbeddingModel(targetModel);

    // If using Ollama, also configure Ollama for LLM metadata if qwen2.5 or llama exists
    if (targetProvider === 'ollama') {
      const qwenModel = scan.detectedModels.find((m) => m.name.includes('qwen') || m.name.includes('llama'));
      if (qwenModel) {
        SettingsStore.set('llm_provider', 'ollama');
        SettingsStore.set('llm_model', qwenModel.name);
        SettingsStore.set('llm_base_url', 'http://localhost:11434');
        log(`✔ LLM özetleyici olarak Ollama "${qwenModel.name}" otomatik yapılandırıldı.`);
      }
    }

    const modeDesc = targetMode === 'full' ? 'Tam Yapay Zeka (Vektör + LLM)' : 'Vektör Arama';
    return {
      success: true,
      mode: targetMode,
      provider: targetProvider,
      modelName: targetModel,
      message: `Buluver ${modeDesc} modunda, ${targetProvider.toUpperCase()} motoru (${targetModel}) ile başarıyla yapılandırıldı.`,
      scanReport: scan
    };
  }
};
