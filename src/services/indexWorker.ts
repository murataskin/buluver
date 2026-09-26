import { parentPort } from "node:worker_threads";
import * as path from "node:path";
import { DocumentParser } from "./doc-parser.js";

export interface ParseTask {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface ParsedRecord {
  path: string;
  filename: string;
  ext: string;
  mtimeMs: number;
  size: number;
  body: string;
}

async function parseOne(task: ParseTask): Promise<ParsedRecord> {
  const ext = path.extname(task.path).toLowerCase();
  const filename = path.basename(task.path);
  let body = "";

  try {
    body = await DocumentParser.parse(task.path);
  } catch {
    body = ""; // Unreadable/locked file - still index filename
  }

  return { path: task.path, filename, ext, mtimeMs: task.mtimeMs, size: task.size, body };
}

parentPort?.on("message", async (tasks: ParseTask[]) => {
  try {
    const results = await Promise.all(tasks.map(parseOne));
    parentPort!.postMessage(results);
  } catch (err) {
    console.error("Worker tasks processing failed:", err);
    parentPort!.postMessage([]);
  }
});
