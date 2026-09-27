---
name: buluver
description: Search and retrieve local Turkish legal documents (.udf, .docx, .doc, .pdf) via keyword, hybrid vector RRF, or trigram infix, with court, case-kind, and document-type facet filters. Use to study the lawyer's authentic writing style, tone, and legal arguments before drafting petitions, contracts, or legal memos.
---

# Buluver

Local-first Turkish legal document search engine, CLI, and FastMCP server. Indexes `.udf` (UYAP XML), `.docx`, `.doc` (Word 97-2003), `.pdf`, and `.txt` files with SQLite FTS5 lexical matching, trigram infix retrieval, local vector embeddings (ONNX & Ollama), and Reciprocal Rank Fusion (RRF). Extracts Turkish legal metadata heuristics (court name, case/docket number, case kind, document type, document date, clean parties) directly from document bodies with UYAP filename fallback. Strictly non-destructive and read-only.

## When to Reach

- **Draft with Authentic Voice ("İlham Almak"):** Search past petitions, responses, appeals, or contracts to mirror the lawyer's exact terminology, argumentation flow, heading structure, and prayer for relief (`netice-i talep`).
- **Locate Precedents & Past Cases:** Retrieve specific court decisions, expert reports (`Bilirkişi Raporu`), hearing minutes (`Duruşma Tutanağı`), or arbitration filings.
- **Filter by Legal Facets:** Narrow queries by document category (e.g. `Dava Dilekçesi`, `Gerekçeli Karar`) or case kind (`ESAS`, `SORUSTURMA`, `DEGISIK_IS`, `TAKIP`, `BASVURU`).
- **Inspect Full Text & Parsed Heuristics:** Read extracted body text and parsed legal metadata without launching office software.
- **Manage Monitored Folders & Embeddings:** Register directories, manage embedding catalogs (`minilm-l12`, `nomic-embed`, `bge-m3`, `multilingual-e5`), and configure LLM endpoints.

## Interfaces

Choose between two equivalent interfaces:
- **FastMCP Server (Primary for AI Agents):** Direct tool calls (`search`, `read_document`, `status`, `add_folder`, `remove_folder`, `get_config`, `set_config`, `generate_embeddings`, `test_llm`).
- **Terminal CLI (`buluver`):** Direct shell execution (`buluver search`, `buluver read`, `buluver add`, `buluver status`, `buluver model`, `buluver config`).

---

## Workflow Steps

### 1. Check Corpus Health and Scope
Verify monitored directory paths and indexed file counts before running searches.

- **MCP:** Call `status()`.
- **CLI:** Run `buluver status` or `buluver folders`.
- **Completion criteria:** Total indexed file count and active watched directories are confirmed.

### 2. Search with Legal Facets and Modes
Execute targeted queries combining textual terms with document type and case kind filters.

- **Search Modes:**
  - `keyword` (Default): SQLite FTS5 BM25 lexical matching with full Boolean operators (`AND`, `OR`, `NOT`, `-`, `""`, `*`). Best for exact party names, statutory terms, or docket numbers.
  - `hybrid`: Reciprocal Rank Fusion combining FTS5 lexical match and vector cosine similarity. Degrades gracefully to `keyword` when embeddings are offline. Best for conceptual legal questions (e.g., `kıdem tazminatı zamanaşımı`).
  - `infix` (Trigram): SQLite FTS5 trigram tokenization for arbitrary substring matching (>=3 characters). Best for mid-word stems, partial docket numbers (e.g. `3682`), or statutory citations (e.g. `107/2`).
  - `semantic`: Vector cosine similarity over 800-character chunks. Degrades gracefully to `keyword` when embeddings are offline.
- **Facet Filters:**
  - `documentType`: Canonical Turkish document type (e.g., `"Dava Dilekçesi"`, `"Cevap Dilekçesi"`, `"Bilirkişi Raporu"`).
  - `caseKind`: Docket classification (`ESAS`, `SORUSTURMA`, `DEGISIK_IS`, `TAKIP`, `BASVURU`).
- **MCP:** Call `search({ query: string, mode?: "keyword" | "hybrid" | "infix" | "semantic", limit?: number, documentType?: string, caseKind?: "ESAS" | "SORUSTURMA" | "DEGISIK_IS" | "TAKIP" | "BASVURU" })`.
- **CLI:** Run `buluver search "<query>" --mode <mode> --type "<documentType>" --kind <caseKind> --limit <n> [--json]`.
- **Completion criteria:** Search returns candidate hits with file paths, scores, snippets, and parsed metadata.

### 3. Inspect Text and Absorb Legal Writing Style ("İlham Almak")
Examine extracted body text and parsed heuristics to understand the lawyer's tone, structure, and legal posture before drafting.

- **MCP:** Call `read_document({ filePath: string })`.
- **CLI:** Run `buluver read "<filePath>" [--meta-only]`.
- **Stylistic Elements to Adopt:**
  - **Heading Conventions:** Mirror court address format (e.g. `İSTANBUL ANADOLU NÖBETÇİ İŞ MAHKEMESİ'NE`).
  - **Party & Counsel Styling:** Check representation formatting and title conventions.
  - **Substantive Arguments:** Note statute references (e.g., HMK, TBK, İş K., İİK) and specific jurisprudence citations used for the issue.
  - **Prayer for Relief (`Netice-i Talep`):** Adopt the established phrasing for interest rates, litigation costs, and relief clauses.
- **Completion criteria:** Target document text reviewed, legal heuristics verified, and stylistic elements extracted for drafting.

### 4. Index Directories and Manage Watched Folders
Register folders to monitor and index files into SQLite FTS5 and vector tables.

- **MCP:**
  - Add folder: `add_folder({ folderPath: string, scanNow: true })` (collapses nested child paths automatically).
  - Unwatch folder safely: `remove_folder({ folderPath: string, keepFiles: true })` (preserves index while stopping directory watch).
- **CLI:**
  - Add & index: `buluver add "<folderPath>" --index` (collapses nested paths).
  - Unwatch safely: `buluver remove "<folderPath>" --keep-files`.
  - Full purge: `buluver remove "<folderPath>"` (removes folder and deletes all associated index records).
- **Large Archive Ingestion Strategy (1,000+ files):**
  1. Instant FTS indexing: `buluver add "<folderPath>" --index --no-embeddings`.
  2. Incremental vector generation: `buluver embed --limit 100` or MCP `generate_embeddings({ limit: 100 })`.
- **Completion criteria:** Directory paths recorded in `folders` table and documents parsed into `files`, `files_fts`, and `file_chunks`.

### 5. Configure Embedding Catalog and LLM Providers
Set active embedding models, adjust chunking, or connect external LLM providers.

- **MCP:** Call `get_config()`, `set_config({...})`, `generate_embeddings({ limit: n })`, or `test_llm()`.
- **CLI:**
  - View settings: `buluver config`.
  - Toggle embeddings: `buluver config embeddings [on|off]`.
  - Switch embedding model: `buluver model use <modelId>` (`minilm-l12`, `nomic-embed`, `bge-m3`, `multilingual-e5`).
  - Batch embed: `buluver embed [--limit <n>] [--all]`.
  - Adjust chunking: `buluver config chunking --size <n> --overlap <n> [--rebuild]`.
  - Configure LLM: `buluver config llm --provider ollama|openai|gemini --model <name> --base-url <url> --api-key <key>`.
  - Test LLM: `buluver test-llm`.
- **Completion criteria:** Configurations persisted to `app_settings` and validated.

---

## Reference

### Legal Metadata Heuristics
Heuristics extract legal metadata from document bodies, falling back to UYAP filename evidence (`UYAP_[court]_[kind]_[esas]_[type].udf`):

- **Case Kind (`case_kind`):**
  - `ESAS`: Standard civil, penal, administrative, or labor lawsuit dockets.
  - `SORUSTURMA`: Criminal investigation files from Chief Public Prosecutor offices (`Cumhuriyet Başsavcılığı`).
  - `DEGISIK_IS`: Miscellaneous judicial motions, preliminary injunctions, or evidence determinations (`D.İş`).
  - `TAKIP`: Enforcement office execution files (`İcra Dairesi`).
  - `BASVURU`: Arbitration and Insurance Arbitration Commission files (`Sigorta Tahkim Komisyonu`).
- **Canonical Document Types (`document_type`):**
  Over 40 canonical types recognized from title lines and structural keywords:
  - *Petitions:* `Dava Dilekçesi`, `Cevap Dilekçesi`, `Cevaba Cevap Dilekçesi`, `İkinci Cevap Dilekçesi`, `Beyan Dilekçesi`, `İtiraz Dilekçesi`, `İstinaf Dilekçesi`, `Temyiz Dilekçesi`.
  - *Minutes & Judgments:* `Tensip Zaptı`, `Duruşma Tutanağı`, `Gerekçeli Karar`, `Kısa Karar`, `İhtiyati Haciz Kararı`, `İhtiyati Tedbir Kararı`.
  - *Reports & Enforcement:* `Bilirkişi Raporu`, `İcra Takip Talebi`, `Ödeme Emri`, `İhtarname`, `Uzlaşma Tutanağı`.
- **Document Date (`document_date`):** Standardized ISO date (`YYYY-MM-DD`) parsed from date proximity keywords or header/footer lines.
- **Parties (`plaintiff`, `defendant`):** Cleaned of corporate noise, TCKN, VKN, and residential addresses. Legal representatives (`... Vekili Av. ...`) are separated into counsel metadata.

### FTS5 Search Query Syntax
- **Phrase:** `"kıdem tazminatı"`
- **Boolean AND:** `işçi AND fesih` (default for adjacent terms)
- **Boolean OR:** `ihbar OR kıdem`
- **Exclusion (NOT):** `tahliye NOT kira` or `-icra`
- **Prefix:** `tazmin*`

### Embedding Catalog Models
- `minilm-l12` (ONNX, 384d, ~120 MB): Default, built-in, local ONNX runtime with zero external dependencies.
- `nomic-embed` (Ollama, 768d, ~560 MB): Balanced semantic retrieval with 8192 context window.
- `bge-m3` (Ollama, 1024d, ~2.2 GB): Multilingual state-of-the-art embedding for legal semantics.
- `multilingual-e5` (Ollama, 1024d, ~2.5 GB): High-accuracy multilingual instruct embeddings.

### Supported File Formats
- `.udf`: UYAP document format (ZIP container holding XML CDATA text).
- `.docx`: Microsoft Word OpenXML.
- `.doc`: Legacy Microsoft Word 97-2003 binary format.
- `.pdf`: Standard PDF text layer.
- `.txt`, `.md`: UTF-8 plain text.

### Storage & Locations
- SQLite Database: `~/.buluver/buluver.db` (override via `BULUVER_DB_PATH`).
- ONNX Models: `~/.buluver/models`.
