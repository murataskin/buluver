import { spawn, execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { checkOllamaServer, isOllamaBinaryPresent } from './system-detector.js';

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export const OllamaManager = {
  /**
   * Checks if the Ollama binary is installed on the machine.
   */
  isInstalled(): boolean {
    return isOllamaBinaryPresent();
  },

  /**
   * Checks if Ollama HTTP server is responsive.
   */
  async isRunning(baseUrl = 'http://localhost:11434'): Promise<boolean> {
    const status = await checkOllamaServer(baseUrl);
    return status.running;
  },

  /**
   * Spawns `ollama serve` in the background if installed but not running.
   */
  async startDaemon(baseUrl = 'http://localhost:11434'): Promise<boolean> {
    if (await this.isRunning(baseUrl)) {
      return true;
    }

    if (!this.isInstalled()) {
      throw new Error('Ollama kurulu değil.');
    }

    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      // Poll until server responds (max 8 seconds)
      const start = Date.now();
      while (Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 400));
        if (await this.isRunning(baseUrl)) {
          return true;
        }
      }
      return false;
    } catch (err: any) {
      console.error('Ollama arka plan servisi başlatılamadı:', err?.message || err);
      return false;
    }
  },

  /**
   * Installs Ollama automatically using Homebrew or official scripts.
   */
  async installOllama(): Promise<{ success: boolean; message: string }> {
    const platform = process.platform;

    if (platform === 'darwin') {
      let hasBrew = false;
      try {
        execSync('which brew', { stdio: 'pipe' });
        hasBrew = true;
      } catch {}

      if (hasBrew) {
        try {
          execSync('brew install ollama', { stdio: 'inherit' });
          try {
            execSync('brew services start ollama', { stdio: 'pipe' });
          } catch {
            await this.startDaemon();
          }
          return {
            success: true,
            message: 'Ollama Homebrew üzerinden başarıyla kuruldu ve başlatıldı.'
          };
        } catch (err: any) {
          return {
            success: false,
            message: `Homebrew ile kurulum başarısız: ${err?.message || err}`
          };
        }
      } else {
        return {
          success: false,
          message: 'Homebrew bulunamadı. Lütfen https://ollama.com/download adresinden Ollama uygulamasını indirip kurun.'
        };
      }
    } else if (platform === 'linux') {
      try {
        execSync('curl -fsSL https://ollama.com/install.sh | sh', { stdio: 'inherit' });
        await this.startDaemon();
        return {
          success: true,
          message: 'Ollama resmi kurulum betiği ile başarıyla kuruldu.'
        };
      } catch (err: any) {
        return {
          success: false,
          message: `Linux kurulumu başarısız oldu: ${err?.message || err}`
        };
      }
    } else if (platform === 'win32') {
      try {
        execSync('winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements', { stdio: 'inherit' });
        return {
          success: true,
          message: 'Ollama winget üzerinden kuruldu.'
        };
      } catch (err: any) {
        return {
          success: false,
          message: `Windows winget kurulumu başarısız: ${err?.message || err}. Lütfen https://ollama.com adresinden indirin.`
        };
      }
    }

    return {
      success: false,
      message: `Desteklenmeyen işletim sistemi: ${platform}. Lütfen https://ollama.com adresinden manuel kurun.`
    };
  },

  /**
   * Pulls an embedding or LLM model from Ollama library with streaming progress.
   */
  async pullModel(
    modelName: string,
    onProgress?: (p: OllamaPullProgress) => void,
    baseUrl = 'http://localhost:11434'
  ): Promise<void> {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName, stream: true })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama model indirme hatası (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error('Yanıt akışı okunamadı.');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const json = JSON.parse(trimmed);
          const percent = json.total && json.completed ? Math.floor((json.completed / json.total) * 100) : undefined;
          if (onProgress) {
            onProgress({
              status: json.status || 'downloading',
              completed: json.completed,
              total: json.total,
              percent
            });
          }
        } catch {}
      }
    }
  },

  /**
   * Generates a normalized Float32Array embedding vector via Ollama REST API.
   */
  async generateEmbedding(
    modelName: string,
    text: string,
    baseUrl = 'http://localhost:11434'
  ): Promise<Float32Array> {
    // Try the modern /api/embed endpoint first
    try {
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, input: text }),
        signal: AbortSignal.timeout(30_000)
      });

      if (res.ok) {
        const data = (await res.json()) as any;
        const raw = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : data.embeddings;
        if (Array.isArray(raw) && raw.length > 0) {
          return normalizeVector(new Float32Array(raw));
        }
      }
    } catch {}

    // Fallback to classic /api/embeddings endpoint
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, prompt: text }),
      signal: AbortSignal.timeout(30_000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama embedding API hatası (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    if (!Array.isArray(data.embedding)) {
      throw new Error('Ollama embedding yanıtında vektör bulunamadı.');
    }

    return normalizeVector(new Float32Array(data.embedding));
  }
};

/**
 * Normalizes a vector to unit length (L2 norm) for accurate cosine similarity.
 */
function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  if (norm === 0) return vec;
  const sqrtNorm = Math.sqrt(norm);
  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i] / sqrtNorm;
  }
  return vec;
}
