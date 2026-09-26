import fs from "node:fs/promises";
import path from "node:path";
import { DocumentParser } from "./doc-parser.js";

export interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".codegraph",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
  ".Trashes",
  ".fseventsd",
  ".Spotlight-V100",
]);

// macOS dataless placeholder flag (iCloud / OneDrive Files On-Demand)
const SF_DATALESS = 0x40000000;

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
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

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
