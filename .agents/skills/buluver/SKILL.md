---
name: buluver
description: Search and retrieve pre-written Turkish legal documents (.udf, .docx, .doc, .pdf, .txt) from the lawyer's local archive to understand their writing style, tone, and legal language ("ilham almak") before drafting. Prevents writing generic legal texts from scratch.
---

# Buluver

Local-first Turkish legal document search engine, CLI, and FastMCP server. Indexes and searches `.udf` (UYAP XML), `.docx`, `.doc` (Word 97-2003), `.pdf`, and `.txt` files with SQLite FTS5 lexical matching, trigram infix retrieval, curated local vector embeddings (ONNX & Ollama), and Reciprocal Rank Fusion (RRF) hybrid retrieval. Embeddings and LLMs are strictly optional: Buluver can run in pure FTS mode with zero AI overhead.

## When to Reach

- **Drafting with the Lawyer's Voice ("İlham Almak"):** When asked to write or propose a petition, response, objection, contract, or legal memo, search the user's past documents first. Understand their actual writing style, vocabulary, tone, and argumentation habits to avoid drafting generic text from scratch.
- **Find Relevant Past Work & Precedents:** Locate Turkish court decisions, petitions, hearing minutes, or past case files across local directories.
- **Extract & Read Authentic Text:** Read clean text and legal metadata from `.udf` (UYAP), `.docx`, `.doc`, or `.pdf` files without launching office applications.
- **Query by Metadata or Concepts:** Query legal case records by court name, case/esas number, parties (davacı, davalı), or conceptual topic.
- **Manage Local Index & Models:** Manage monitored folders, curated embedding catalog models (`minilm-l12`, `nomic-embed`, `bge-m3`, `multilingual-e5`), and local LLM connections.

## Interface Selection

Two equivalent interfaces are available:

1. **FastMCP Server (Preferred for AI Agents):** When connected as an MCP client, call tools directly (`search`, `read_document`, `status`, `get_config`, `set_config`, `add_folder`).
2. **Terminal CLI (`buluver`):** Run shell commands directly (`buluver search`, `buluver read`, `buluver add`, `buluver model`, `buluver setup`, `buluver config`).

---

## Workflow Steps

### 1. Check Index Scope and Health
Before searching, verify monitored directories and indexed document counts.

- **MCP:** Call `status()`.
- **CLI:** Run `buluver status` or `buluver folders`.
- **Completion criteria:** Total indexed files and monitored folder paths are confirmed.

### 2. Execute Document Search
Query the corpus using the optimal search mode:

- **Modes:**
  - `keyword` (Default): Fast, exact lexical matching via SQLite FTS5 with full Boolean expressions (`AND`, `OR`, `NOT`, `-`, `""`, `*`). Best for precise legal terms, specific file names, exact case numbers, or explicit party names.
  - `hybrid`: Combines FTS5 lexical match and cosine vector similarity using Reciprocal Rank Fusion. Best for broad conceptual legal queries (e.g., `kıdem tazminatı fazla mesai`). If embeddings are disabled, gracefully degrades to `keyword`.
  - `infix` (Trigram): Substring matching via SQLite FTS5 `trigram` tokenizer. Best for searching word fragments from the middle (e.g., `gıtay`), partial docket numbers (e.g., `3682`), or statutory articles (e.g., `107/2`). Requires >=3 characters.
  - `semantic`: Pure vector cosine similarity over 800-character chunks. Best for natural language questions. If embeddings are disabled, gracefully degrades to `keyword`.
- **MCP:** Call `search({ query: string, mode?: "hybrid" | "keyword" | "semantic" | "infix", limit?: number })`.
- **CLI:** Run `buluver search "<query>" --mode <mode> --limit <n> [--json]`.
- **Completion criteria:** Results returned with matching file paths, relevance scores, and highlighted snippets.

### 3. Inspect Pre-Written Documents & Absorb Writing Style ("İlham Almak")
Read clean authentic text and parsed legal heuristics for selected search hits to understand how the lawyer writes before drafting.

- **MCP:** Call `read_document({ filePath: string })`.
- **CLI:** Run `buluver read "<filePath>" [--meta-only]`.
- **Stylistic & Substance Inspiration ("Yazı Dili ve Üslubu"):**
  - **Tone & Voice:** Observe how the lawyer/user formulates arguments (e.g. rigorous statutory reasoning, assertive litigation tone, structured point-by-point rebuttals).
  - **Headings & Formalities:** Notice exact heading phrasing (e.g. `... NÖBETÇİ İŞ MAHKEMESİNE`), case/subject formatting, and party representations.
  - **Statutory References:** Check which specific codes (HMK, TBK, İş K., İİK) and jurisprudence patterns are referenced for this subject.
  - **Prayer for Relief (Netice-i Talep):** Review how requests, interest rates, and court expense allocations are worded.
- **Completion criteria:** Document content and authentic writing style are inspected, providing a concrete reference to draft with the lawyer's authentic voice.

### 4. Index New Directories & Manage Watched Folders
Add new folders to the monitored list or safely deregister them without losing indexed documents.

- **MCP:**
  - Add folder: `add_folder({ folderPath: string, scanNow: true })` (automatically deduplicates and consolidates child folders).
  - Safe deregister: `remove_folder({ folderPath: string, keepFiles: true })` (unregisters folder from watch list while preserving existing index & vectors).
- **CLI:**
  - Add & index: `buluver add "<folderPath>" --index` (automatically collapses nested child paths).
  - Safe deregister: `buluver remove "<folderPath>" --keep-files` (or `--unwatch`).
  - Destructive remove: `buluver remove "<folderPath>"` (removes folder and deletes all indexed files/chunks under it).

> [!TIP]
> **Large Archive Strategy (1,000+ to 10,000+ files):**
> 1. **Phase 1 (Instant FTS & Infix Search):** Index files with `buluver add "<folderPath>" --index --no-embeddings`. This scans recursively and indexes all `.udf`, `.docx`, `.doc`, `.pdf`, `.txt`, `.md` into SQLite FTS5 BM25 and trigram tables in minutes.
> 2. **Phase 2 (Background / Batch Vector Embeddings):** Run `buluver embed` (or `buluver embed --limit 100` / `buluver embed --all`) or MCP `generate_embeddings({ limit: 100 })` to generate vector embeddings incrementally without freezing the system.
- **Completion criteria:** Folder is recorded in `folders` table and new documents are parsed into `files`, `files_fts`, and optionally `file_chunks`.

### 5. Configure Embedding Model, Modes and LLM Connection
Manage operating modes (FTS-only vs Vector vs Full AI), curated embedding models, batch embeddings, or external LLM providers (Ollama / OpenAI / Gemini).

- **MCP:** Call `get_config()`, `set_config({...})`, `generate_embeddings({ limit: n })`, or `test_llm()`.
- **CLI:**
  - View settings: `buluver config`.
  - Toggle vector embeddings: `buluver config embeddings [on|off]`.
  - Toggle LLM metadata: `buluver config llm-enable [on|off]`.
  - List catalog models: `buluver model list` (shows `minilm-l12`, `nomic-embed`, `bge-m3`, `multilingual-e5`).
  - Check active model: `buluver model current`.
  - Switch model: `buluver model use <modelId>` (automatically re-indexes existing chunks if model changes).
  - Quick setup wizard: `buluver setup --mode <fts|embeddings|full>` or `buluver setup --fts-only`.
  - Batch / incremental embedding: `buluver embed [--limit <n>] [--all]`.
  - Adjust chunking: `buluver config chunking --size <n> --overlap <n> [--rebuild]`.
  - Set LLM: `buluver config llm --provider ollama|openai|gemini --model <name> --base-url <url> --api-key <key>`.
  - Test LLM: `buluver test-llm`.
  - Re-index all vectors from scratch: `buluver reindex-embeddings`.
- **Completion criteria:** Settings saved to `app_settings` and verified.

---

## Reference & Query Syntax

### Search Query Syntax (FTS5)
- **Exact Phrase:** `"kıdem tazminatı"`
- **Boolean AND:** `işçi AND fesih` (default for separated terms)
- **Boolean OR:** `ihbar OR kıdem`
- **Exclusion (NOT):** `tahliye NOT kira` or `-icra`
- **Prefix / Wildcard:** `tazmin*`

### Curated Embedding Catalog
- `minilm-l12` (ONNX, 384d, ~120 MB): Default, lightweight, zero external dependencies.
- `nomic-embed` (Ollama, 768d, ~560 MB): 8192 token context window, fast and balanced.
- `bge-m3` (Ollama, 1024d, ~2.2 GB): SOTA multilingual & legal semantic matching.
- `multilingual-e5` (Ollama, 1024d, ~2.5 GB): High quality multilingual instruct embedding.

### Supported Document Types
- `.udf`: UYAP document format (ZIP container with XML CDATA text).
- `.docx`: Microsoft Word OpenXML via `mammoth`.
- `.doc`: Legacy Microsoft Word 97-2003 binary via `word-extractor`.
- `.pdf`: Portable Document Format text layers via `pdf-parse`.
- `.txt`, `.md`: Plain text UTF-8 files.

### Storage Locations
- Database: `~/.buluver/buluver.db` (override with `BULUVER_DB_PATH`).
- ONNX Models: `~/.buluver/models`.
