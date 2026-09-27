import fs from "node:fs/promises";
import path from "node:path";
import { DocumentParser } from "./doc-parser.js";

export interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".codegraph",
  "$recycle.bin",
  "system volume information",
  ".trash",
  ".trashes",
  ".fseventsd",
  ".spotlight-v100",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cargo",
  ".rustup",
  ".venv",
  "venv",
  "env",
  ".cache",
  "caches",
  "application support",
  "containers",
  "logs",
  "applications",
]);

export function shouldSkipDir(dirName: string): boolean {
  const lower = dirName.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  if (lower.endsWith(".app")) return true;
  return false;
}

// macOS dataless placeholder flag (iCloud / OneDrive Files On-Demand)
const SF_DATALESS = 0x40000000;

export function shouldSkipFile(filename: string): boolean {
  if (filename.startsWith('~$') || filename.startsWith('._')) return true;
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tmp') || lower === '.ds_store' || lower === 'thumbs.db') return true;
  return false;
}

export async function* walk(
  rootDir: string,
  chunkSize = 200
): AsyncGenerator<WalkedFile[], void, void> {
  let chunk: WalkedFile[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied / dir vanished mid-scan - skip
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || shouldSkipDir(entry.name)) {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name)) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!DocumentParser.isSupported(full)) continue;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      // Skip dataless cloud placeholders on macOS
      if (typeof (stat as any).flags === "number" && ((stat as any).flags & SF_DATALESS) !== 0) {
        continue;
      }

      // Skip zero-byte files
      if (stat.size === 0) continue;

      chunk.push({ path: full, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk = [];
      }
    }

    // Yield to the event loop periodically
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  if (chunk.length > 0) yield chunk;
}
