import { pipeline, env } from '@huggingface/transformers';
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { DatabaseService } from './database';

// Configure transformers cache directory to be inside Electron's userData
let userDataPath: string;
try {
  userDataPath = app.getPath('userData');
} catch {
  userDataPath = path.join(process.cwd(), '.cache');
}
env.cacheDir = path.join(userDataPath, 'onnx_models');

let extractor: any = null;
let lastProgressEmit = 0;

export function reloadPipeline(): void {
  extractor = null;
}

function broadcastProgress(status: any) {
  const now = Date.now();
  if (status.status === 'progress' && now - lastProgressEmit < 100) {
    return;
  }
  lastProgressEmit = now;
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('embedding-model-progress', status);
  }
}

export async function getEmbeddingPipeline(): Promise<any> {
  if (extractor) return extractor;
  
  const modelName = DatabaseService.getSetting('active_model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  
  extractor = await pipeline('feature-extraction', modelName, {
    progress_callback: (data: any) => {
      broadcastProgress({ ...data, modelName });
    }
  });
  
  // Make sure we notify the frontend that download / load is complete
  broadcastProgress({ status: 'ready', file: modelName });
  return extractor;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const model = await getEmbeddingPipeline();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export function chunkText(text: string, chunkSize = 800, overlap = 150): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  
  // Normalize whitespace: replace multiple spaces/newlines with a single space
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }
  
  let start = 0;
  while (start < cleanText.length) {
    const end = Math.min(start + chunkSize, cleanText.length);
    let chunk = cleanText.slice(start, end);
    
    // Attempt to align chunk boundary to a space to avoid cutting words
    if (end < cleanText.length) {
      const lastSpace = chunk.lastIndexOf(' ');
      if (lastSpace > chunkSize - 100) {
        chunk = chunk.slice(0, lastSpace);
      }
    }
    
    chunks.push(chunk);
    start += chunk.length - overlap;
    
    // Safety check to prevent infinite loops
    if (chunk.length <= overlap) {
      break;
    }
  }
  
  return chunks;
}
