# Implementation Plan: UDF Metadata Tracking

We want to track metadata for `.udf` documents in our local SQLite database. This includes:
- **Case/Legal Metadata**: Court Name (`court_name`), Case/File Number (`case_number`), Document Type (`document_type`), Plaintiff (`plaintiff`), Defendant (`defendant`).
- **AI-generated Metadata**: Summary (`summary`) and Tags (`tags`).

Based on our design decisions, here is the implementation plan:

## 1. Database Schema Updates
We will modify [database.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/database.ts) to:
- Enable SQLite foreign keys: `db.exec('PRAGMA foreign_keys = ON;')`.
- Create a new `file_metadata` table:
  ```sql
  CREATE TABLE IF NOT EXISTS file_metadata (
    file_id INTEGER PRIMARY KEY,
    summary TEXT,
    tags TEXT, -- JSON string array (e.g. '["Kira","Tahliye"]')
    case_number TEXT,
    court_name TEXT,
    document_type TEXT,
    plaintiff TEXT,
    defendant TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
  );
  ```

## 2. Deterministic Heuristics Parser
We will implement an extraction helper `extractMetadataHeuristics` in [udf-parser.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/udf-parser.ts):
- **Court Name**: Extracts leading sentences/phrases ending in court suffixes (e.g., `MAHKEMESİ`, `HAKİMLİĞİ'NE`, `BAŞKANLIĞI'NA`). Cleans digital barcode prefixes.
- **Case Number**: Matches pattern `(?:DOSYA|ESAS)\s*NO\s*:\s*([0-9\s/\\\-EeKk.–]+)`.
- **Plaintiff / Defendant**: Matches `DAVACI` / `DAVALI` prefixes, cleaning up trailing T.C. IDs, addresses, and `VEKİLİ` strings.
- **Document Type**: Uses subject (`KONU`) headers if present; falls back to the filename prefix.

## 3. Indexer Integration
- Update `indexWorker.ts` to execute `UdfParser.extractMetadataHeuristics(body, filename)` and return it inside the `ParsedRecord`.
- Update `database.ts`'s `upsertFilesBatch` and `upsertFile` to write this parsed metadata to `file_metadata` in the same transaction.

## 4. MCP Server Integration
We will update [mcp.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/mcp.ts):
- **`read_udf`**: Modify this tool to query both the file content and its metadata from the `file_metadata` table, returning both in the response.
- **`update_udf_metadata`**: Implement this tool to save/update the `summary`, `tags`, and other fields for a given `filePath`.

---

## Proposed Code Changes

### A. [database.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/database.ts)
- Add foreign keys configuration:
  ```typescript
  db.exec('PRAGMA foreign_keys = ON;');
  ```
- Add metadata table creation to `getDb()`.
- Add `getFileMetadata(filePath)` and `upsertFileMetadata(filePath, metadata)`.
- Modify `upsertFilesBatch` and `upsertFile` to accept the extracted metadata and insert/update `file_metadata`.

### B. [udf-parser.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/udf-parser.ts)
- Add `extractMetadataHeuristics(text: string, filename: string)` function.

### C. [indexWorker.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/indexWorker.ts)
- Extend `ParsedRecord` interface to include a `metadata` field.
- Invoke `UdfParser.extractMetadataHeuristics` in `parseOne`.

### D. [mcp.ts](file:///Users/muratcanaskin/coding/izbul/electron/services/mcp.ts)
- Update `read_udf` to merge metadata into its response.
- Register `update_udf_metadata` tool.
