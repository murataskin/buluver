---
name: buluver
description: Search and retrieve pre-written Turkish legal documents (.udf, .docx, .pdf, .txt) from the lawyer's local archive to understand their writing style, tone, and legal language ("ilham almak") before drafting. Prevents writing generic legal texts from scratch.
---

# Buluver

Local-first Turkish legal document search engine, CLI, and FastMCP server. Indexes and searches `.udf` (UYAP XML), `.docx`, `.pdf`, and `.txt` files with SQLite FTS5 lexical matching, local ONNX vector embeddings, and Reciprocal Rank Fusion (RRF) hybrid retrieval.

## When to Reach

- **Drafting with the Lawyer's Voice ("İlham Almak"):** When asked to write or propose a petition, response, objection, contract, or legal memo, search the user's past documents first. Understand their actual writing style, vocabulary, tone, and argumentation habits to avoid drafting generic text from scratch.
- **Find Relevant Past Work & Precedents:** Locate Turkish court decisions, petitions, hearing minutes, or past case files across local directories.
- **Extract & Read Authentic Text:** Read clean text and legal metadata from `.udf` (UYAP), `.docx`, or `.pdf` files without launching office applications.
- **Query by Metadata or Concepts:** Query legal case records by court name, case/esas number, parties (davacı, davalı), or conceptual topic.
- **Manage Local Index:** Manage monitored folders, ONNX embedding models, and local LLM connections.

## Interface Selection

Two equivalent interfaces are available:

1. **FastMCP Server (Preferred for AI Agents):** When connected as an MCP client, call tools directly (`search`, `read_document`, `status`, `get_config`, `set_config`, `add_folder`).
2. **Terminal CLI (`buluver`):** Run shell commands directly (`buluver search`, `buluver read`, `buluver add`, `buluver config`).

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
  - `hybrid` (Default): Combines FTS5 lexical match and cosine vector similarity using Reciprocal Rank Fusion. Best for conceptual legal queries (e.g., `kıdem tazminatı fazla mesai`, `haksız fesih`).
  - `keyword`: Exact lexical matching via SQLite FTS5 `unicode61`. Best for specific file names, exact case numbers, or explicit party names (e.g., `2024/3682`, `Doğuş Otel`).
  - `semantic`: Pure vector cosine similarity over 800-character chunks. Best for natural language questions.
- **MCP:** Call `search({ query: string, mode?: "hybrid" | "keyword" | "semantic", limit?: number })`.
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

### 4. Index New Directories
Add new folders to the monitored list and trigger indexing.

- **MCP:** Call `add_folder({ folderPath: string, scanNow: true })`.
- **CLI:** Run `buluver add "<folderPath>" --index`.
- **Completion criteria:** Folder is recorded in `folders` table and new documents are parsed into `files`, `files_fts`, and `file_chunks`.

### 5. Configure Embedding Model and LLM Connection
Manage active ONNX embedding pipelines or external LLM providers (Ollama / OpenAI / Gemini).

- **MCP:** Call `get_config()`, `set_config({...})`, or `test_llm()`.
- **CLI:**
  - View settings: `buluver config`.
  - Change embedding model: `buluver config model <modelName> [--rebuild]`.
  - Adjust chunking: `buluver config chunking --size <n> --overlap <n> [--rebuild]`.
  - Set LLM: `buluver config llm --provider ollama|openai|gemini --model <name> --base-url <url> --api-key <key>`.
  - Test LLM: `buluver test-llm`.
  - Re-index vectors: `buluver reindex-embeddings`.
- **Completion criteria:** Settings saved to `app_settings` and verified.

---

## Reference & Query Syntax

### Search Query Syntax (FTS5)
- **Exact Phrase:** `"kıdem tazminatı"`
- **Boolean AND:** `işçi AND fesih` (default for separated terms)
- **Boolean OR:** `ihbar OR kıdem`
- **Exclusion (NOT):** `tahliye NOT kira` or `-icra`
- **Prefix / Wildcard:** `tazmin*`

### Supported Document Types
- `.udf`: UYAP document format (ZIP container with XML CDATA text).
- `.docx`: Microsoft Word OpenXML via `mammoth`.
- `.pdf`: Portable Document Format text layers via `pdf-parse`.
- `.txt`, `.md`: Plain text UTF-8 files.

### Storage Locations
- Database: `~/.buluver/buluver.db` (override with `BULUVER_DB_PATH`).
- ONNX Models: `~/.buluver/models`.
