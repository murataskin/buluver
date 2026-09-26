import fs from "node:fs/promises";
import path from "node:path";

export interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
  ".Trashes",
  ".fseventsd",
  ".Spotlight-V100",
]);

// Extensions the app understands: content-searched (UDF) + name-only (everything else, per legacy behavior)
const NAME_ONLY_EXTS = new Set([".docx", ".doc", ".pdf", ".xlsx", ".xls", ".txt"]);

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
      continue; // permission denied / dir vanished mid-scan - skip, don't crash the whole scan
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".udf" && !NAME_ONLY_EXTS.has(ext)) continue;

      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      chunk.push({ path: full, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
      if (chunk.length >= chunkSize) {
        yield chunk;
        chunk = [];
      }
    }

    // Yield to the event loop periodically between directories so a huge
    // tree never monopolizes the process - this alone fixes "UI feels frozen
    // while scanning" even before any DB work happens.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  if (chunk.length > 0) yield chunk;
}
