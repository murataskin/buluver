import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { SettingsStore } from './settings-store.js';
import { getDataDir } from './database.js';

export interface HardwareProfile {
  cpuModel: string;
  cores: number;
  ramGB: number;
  platform: string;
  arch: string;
  isAppleSilicon: boolean;
  tier: 'light' | 'balanced' | 'pro';
}

export interface DetectedModel {
  name: string;
  provider: 'ollama' | 'onnx';
  location: string;
  sizeBytes?: number;
  dimension?: number;
  isActive?: boolean;
}

export interface SystemScanReport {
  hardware: HardwareProfile;
  ollamaInstalled: boolean;
  ollamaRunning: boolean;
  ollamaVersion?: string;
  detectedModels: DetectedModel[];
  recommendation: {
    provider: 'ollama' | 'onnx';
    modelName: string;
    reason: string;
  };
}

/**
 * Probes the machine's hardware specs (CPU, RAM, Apple Silicon)
 * and categorizes into a recommended performance tier.
 */
export function detectHardwareProfile(): HardwareProfile {
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
  const cores = cpus.length;
  const ramGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const platform = process.platform;
  const arch = process.arch;
  const isAppleSilicon = platform === 'darwin' && (arch === 'arm64' || cpuModel.includes('Apple'));

  let tier: 'light' | 'balanced' | 'pro' = 'light';
  if (isAppleSilicon || ramGB >= 16) {
    tier = 'pro';
  } else if (ramGB >= 8 || cores >= 4) {
    tier = 'balanced';
  }

  return {
    cpuModel,
    cores,
    ramGB,
    platform,
    arch,
    isAppleSilicon,
    tier
  };
}

/**
 * Checks whether the Ollama binary exists in PATH or standard paths.
 */
export function isOllamaBinaryPresent(): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    execSync(whichCmd, { stdio: 'pipe' });
    return true;
  } catch {
    const commonPaths = [
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      path.join(os.homedir(), '.buluver', 'bin', 'ollama')
    ];
    return commonPaths.some(p => fs.existsSync(p));
  }
}

/**
 * Checks if Ollama REST server is currently responding on baseUrl.
 */
export async function checkOllamaServer(baseUrl = 'http://localhost:11434'): Promise<{ running: boolean; version?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(1500)
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      return { running: true, version: data.version };
    }
  } catch {}
  return { running: false };
}

/**
 * Queries running Ollama server for installed models with embedding capabilities.
 */
export async function getOllamaInstalledModels(baseUrl = 'http://localhost:11434'): Promise<DetectedModel[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    const models = Array.isArray(data.models) ? data.models : [];

    const activeProvider = SettingsStore.get('embedding_provider', 'onnx');
    const activeModel = SettingsStore.get('active_model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');

    const result: DetectedModel[] = [];
    for (const m of models) {
      const caps = Array.isArray(m.capabilities) ? m.capabilities : [];
      const isEmbed = caps.includes('embedding') ||
        m.name.includes('embed') ||
        m.name.includes('bge') ||
        m.name.includes('minilm') ||
        m.name.includes('e5');

      result.push({
        name: m.name,
        provider: 'ollama',
        location: `${baseUrl} (${m.details?.format || 'gguf'})`,
        sizeBytes: m.size,
        dimension: m.details?.embedding_length,
        isActive: activeProvider === 'ollama' && activeModel === m.name
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Scans local filesystem caches for pre-downloaded ONNX models.
 */
export function getLocalOnnxModels(): DetectedModel[] {
  const activeProvider = SettingsStore.get('embedding_provider', 'onnx');
  const activeModel = SettingsStore.get('active_model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  const detected: DetectedModel[] = [];

  // 1. Buluver models dir (~/.buluver/models)
  const buluverDir = path.join(getDataDir(), 'models');
  if (fs.existsSync(buluverDir)) {
    try {
      const entries = fs.readdirSync(buluverDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const orgPath = path.join(buluverDir, ent.name);
          const subEntries = fs.readdirSync(orgPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isDirectory()) {
              const modelFullName = `${ent.name}/${sub.name}`;
              detected.push({
                name: modelFullName,
                provider: 'onnx',
                location: path.join(orgPath, sub.name),
                isActive: activeProvider === 'onnx' && activeModel === modelFullName
              });
            }
          }
        }
      }
    } catch {}
  }

  // 2. Hugging Face hub cache (~/.cache/huggingface/hub)
  const hfDir = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  if (fs.existsSync(hfDir)) {
    try {
      const entries = fs.readdirSync(hfDir);
      for (const name of entries) {
        if (name.startsWith('models--')) {
          const parts = name.replace('models--', '').split('--');
          const modelName = parts.join('/');
          // Avoid duplicate if already found in buluver
          if (!detected.some(d => d.name === modelName)) {
            detected.push({
              name: modelName,
              provider: 'onnx',
              location: path.join(hfDir, name),
              isActive: activeProvider === 'onnx' && activeModel === modelName
            });
          }
        }
      }
    } catch {}
  }

  return detected;
}

/**
 * Conducts a full scan of system hardware, local models, and Ollama status.
 */
export async function scanSystem(): Promise<SystemScanReport> {
  const hardware = detectHardwareProfile();
  const ollamaInstalled = isOllamaBinaryPresent();
  const ollamaStatus = await checkOllamaServer();

  let detectedModels: DetectedModel[] = [];

  if (ollamaStatus.running) {
    const ollamaModels = await getOllamaInstalledModels();
    detectedModels.push(...ollamaModels);
  }

  const onnxModels = getLocalOnnxModels();
  detectedModels.push(...onnxModels);

  // Determine top recommendation based on hardware and installed models
  let recommendation: { provider: 'ollama' | 'onnx'; modelName: string; reason: string };

  const hasOllamaBgeM3 = detectedModels.some(m => m.provider === 'ollama' && m.name.includes('bge-m3'));
  const hasOllamaE5 = detectedModels.some(m => m.provider === 'ollama' && m.name.includes('e5'));
  const hasAnyOllamaEmbed = detectedModels.find(m => m.provider === 'ollama' && (m.name.includes('embed') || m.name.includes('bge') || m.name.includes('e5')));

  if (ollamaStatus.running && hasOllamaBgeM3) {
    recommendation = {
      provider: 'ollama',
      modelName: 'bge-m3',
      reason: 'Ollama "bge-m3" yerel olarak yüklü. 8192 token bağlamı, 1024 boyutlu vektör ve GPU/Metal hızlandırmasıyla Türkçe hukuk metinleri için en yüksek doğruluğu sunar.'
    };
  } else if (ollamaStatus.running && hasOllamaE5) {
    const e5Model = detectedModels.find(m => m.provider === 'ollama' && m.name.includes('e5'))!;
    recommendation = {
      provider: 'ollama',
      modelName: e5Model.name,
      reason: `Ollama "${e5Model.name}" yüklü. Çok dilli E5 mimarisi Türkçe aramalar ve GPU hızlandırması için idealdir.`
    };
  } else if (ollamaStatus.running && hasAnyOllamaEmbed) {
    recommendation = {
      provider: 'ollama',
      modelName: hasAnyOllamaEmbed.name,
      reason: `Ollama "${hasAnyOllamaEmbed.name}" hazır ve GPU/Metal donanım hızlandırmasından faydalanır.`
    };
  } else if (hardware.tier === 'pro' && ollamaStatus.running) {
    recommendation = {
      provider: 'ollama',
      modelName: 'bge-m3',
      reason: `${hardware.cpuModel} (${hardware.ramGB} GB RAM) donanımı tespit edildi. Ollama üzerinden "bge-m3" indirilmesi Türkçe hukuk belgeleri için en iyi sonucu verir.`
    };
  } else if (hardware.tier === 'pro') {
    recommendation = {
      provider: 'onnx',
      modelName: 'Xenova/bge-m3',
      reason: `${hardware.cpuModel} (${hardware.ramGB} GB RAM) donanımı tespit edildi. Yüksek doğruluklu çok dilli BGE-M3 modeli önerilir.`
    };
  } else {
    recommendation = {
      provider: 'onnx',
      modelName: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      reason: 'Hafif, hızlı (~120MB) ve dahili ONNX çalışma zamanıyla harici servis gerektirmeden sorunsuz çalışır.'
    };
  }

  return {
    hardware,
    ollamaInstalled,
    ollamaRunning: ollamaStatus.running,
    ollamaVersion: ollamaStatus.version,
    detectedModels,
    recommendation
  };
}
