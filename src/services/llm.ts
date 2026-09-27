import { SettingsStore } from './settings-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Provider types & config helpers
// ─────────────────────────────────────────────────────────────────────────────

export type LLMProvider = 'ollama' | 'openai' | 'gemini';

export interface LLMSettings {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export function isLlmEnabled(): boolean {
  return SettingsStore.get('llm_enabled', 'false') === 'true';
}

export function setLlmEnabled(enabled: boolean): void {
  SettingsStore.set('llm_enabled', enabled ? 'true' : 'false');
}

export function getLLMSettings(): LLMSettings {
  return {
    provider: SettingsStore.get('llm_provider', 'ollama') as LLMProvider,
    model: SettingsStore.get('llm_model', 'qwen2.5:7b'),
    apiKey: SettingsStore.get('llm_api_key', ''),
    baseUrl: SettingsStore.get('llm_base_url', 'http://localhost:11434'),
  };
}

export function saveLLMSettings(settings: Partial<LLMSettings>): void {
  if (settings.provider !== undefined) SettingsStore.set('llm_provider', settings.provider);
  if (settings.model !== undefined) SettingsStore.set('llm_model', settings.model);
  if (settings.apiKey !== undefined) SettingsStore.set('llm_api_key', settings.apiKey);
  if (settings.baseUrl !== undefined) SettingsStore.set('llm_base_url', settings.baseUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider-specific callers (all return raw text from the model)
// ─────────────────────────────────────────────────────────────────────────────

async function callOllama(model: string, prompt: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.response ?? '';
}

async function callOpenAI(model: string, prompt: string, apiKey: string, baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content ?? '';
}

async function callGemini(model: string, prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified dispatcher
// ─────────────────────────────────────────────────────────────────────────────

async function callLLM(prompt: string, cfg?: LLMSettings): Promise<string> {
  const s = cfg ?? getLLMSettings();
  switch (s.provider) {
    case 'ollama':
      return callOllama(s.model, prompt, s.baseUrl || 'http://localhost:11434');
    case 'openai':
      return callOpenAI(s.model, prompt, s.apiKey, s.baseUrl || 'https://api.openai.com/v1');
    case 'gemini':
      return callGemini(s.model, prompt, s.apiKey);
    default:
      throw new Error(`Unknown LLM provider: ${s.provider}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection test
// ─────────────────────────────────────────────────────────────────────────────

export async function testLLMConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await callLLM('Reply with exactly: {"ok":true}');
    const ok = result.includes('ok') || result.trim().length > 0;
    return { ok, message: ok ? 'Bağlantı başarılı.' : 'Model yanıt döndürmedi.' };
  } catch (err: any) {
    return { ok: false, message: err?.message ?? String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata generation
// ─────────────────────────────────────────────────────────────────────────────

export interface AIMetadata {
  summary?: string;
  tags?: string[];
}

const PROMPT = (text: string) =>
  `Sen bir Türk hukuk belgesi analistısin. Aşağıdaki belgeyi analiz et ve YALNIZCA geçerli bir JSON nesnesi döndür — başka hiçbir şey yazma.

Belge:
${text.slice(0, 3000)}

Döndür:
{
  "summary": "Belgenin 2-3 cümlelik Türkçe özeti",
  "tags": ["etiket1", "etiket2", "etiket3"]
}`;

export async function generateMetadata(text: string): Promise<AIMetadata> {
  try {
    const raw = await callLLM(PROMPT(text));

    // Extract the first JSON object from the response
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) {
      console.warn('[LLM] No JSON found in response. Raw:', raw.slice(0, 200));
      return {};
    }

    const parsed = JSON.parse(match[0]);

    return {
      summary:
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 5
          ? parsed.summary.trim()
          : undefined,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t: any) => typeof t === 'string' && t.trim().length > 0)
            .map((t: string) => t.trim())
            .slice(0, 6)
        : undefined,
    };
  } catch (err) {
    console.error('[LLM] generateMetadata error:', err);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy no-ops kept so main.ts IPC handlers compile without changes
// ─────────────────────────────────────────────────────────────────────────────

export function reloadLlmPipeline(): void { /* no-op for REST providers */ }
export async function getLlmPipeline(): Promise<void> { /* no-op for REST providers */ }
