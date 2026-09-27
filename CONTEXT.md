# Domain Model & Glossary

This document defines the domain concepts and ubiquitous language for Izbul Reborn.

## Core Concepts

### Document
An indexed filesystem file (e.g., UDF, PDF, DOCX, TXT) containing metadata (path, filename, extension, size, modification time) and optionally a text body.
- **UDF Document**: A specialized document formatted as an XML-based zip file used in the Turkish judiciary system (UYAP). Its content is extracted and parsed.
- **Metadata-Only Document**: A document (like PDF, DOCX) where only the path and filename are indexed, rather than the content.

### Monitored Folder
A filesystem directory registered by the user. The application walks this folder to index documents and monitors it in real-time for changes (additions, updates, deletions).

### Content Index
The FTS (Full-Text Search) virtual table mapping document content and filenames to their SQLite row IDs to enable fast keyword queries.

### Search Query
A user-provided search term or expression, potentially containing Boolean operators (`AND`, `OR`, `NOT`), groupings, negative filters, or natural language questions. It specifies the information need across four distinct retrieval modes:
- **Keyword (FTS5)**: BM25-ranked full-text matching against document bodies and filenames with Turkish linguistic tokenization.
- **Infix / Trigram**: Character n-gram matching supporting arbitrary substring and partial-word searches (minimum 3 characters).
- **Semantic**: Dense vector similarity search comparing query embeddings against chunked document vector embeddings via cosine similarity.
- **Hybrid**: Multi-modal retrieval combining keyword and semantic ranking using Reciprocal Rank Fusion (RRF).
- **Metadata Filtering**: Optional exact facet filters on `document_type` (e.g. `Cevap Dilekçesi`), `case_kind` (e.g. `ESAS`, `SORUSTURMA`, `TAKIP`), or `court_name`.

### Search Engine
The unified retrieval module executing Search Queries. It encapsulates query syntax sanitization, on-demand query vector generation, multi-index execution across the Content Index, Reciprocal Rank Fusion, and legal metadata enrichment. It guarantees graceful degradation to keyword search if vector model dependencies fail.

### Document Repository
The persistence boundary encapsulating document storage, full-text indexes (BM25 and Trigram), legal metadata (`case_number`, `case_kind`, `court_name`, `document_type`, `document_date`, `plaintiff`, `defendant`), and chunk embeddings. It guarantees atomic multi-table writes during sync operations, abstracts SQLite internal tables, and prevents foreign key leakage to callers.

### Document Ingestor
The deep ingestion module transforming a raw filesystem file or buffer into an atomic, indexable document record. It encapsulates multi-format text extraction (UDF, DOCX, DOC, PDF, TXT), heuristic legal entity extraction, optional AI metadata/summary synthesis, and text chunking with vector embedding generation.
- **Legal Entity Extraction Engine**: Zero-external-dependency rule and pattern matcher derived from field-proven Turkish legal practice:
  - **Authority Normalization**: Resolves courts (Hukuk, Ceza, Aile, BAM), prosecution offices, enforcement offices, arbitration commissions (Sigorta Tahkim), and public authorities.
  - **Reference Classification (`case_kind`)**: Distinguishes `ESAS`, `SORUSTURMA`, `DEGISIK_IS`, `TAKIP`, and `BASVURU` (Tahkim) while guarding against citation tails of past judicial precedents.
  - **Party Hygiene**: Strips TCKN, tax numbers, addresses, and corporate entity noise, differentiating principals from counsel (`VEKİLİ`, `MÜDAFİİ`).
  - **Canonical Document Type Taxonomy**: Classifies 40+ Turkish legal document types into canonical categories (Dilekçeler, Tutanaklar, Karar ve İlamlar, Bilirkişi, vb.) via structural inference and guards.
  - **Document Date Extraction (`document_date`)**: Detects decision, hearing, report, or notification dates via proximity anchors.
  - **UYAP Filename Evidence Fallback**: Uses structured UYAP file name patterns (`YYYY_SEQ_Tür_DD_MM_YYYY`) as a fallback when body text is absent or ambiguous.
- **Architectural Boundary Invariant**: Ingestion is strictly read-only and non-destructive. Buluver never renames, moves, or alters files or directory structures on the user's filesystem.

### Folder Store
The persistence boundary managing registered Monitored Folders, their registration timestamps, and folder-level deletion cascades.

### Settings Store
The key-value persistence boundary managing runtime configuration such as active embedding models, text chunking parameters, and LLM provider credentials.

### Sync / Index Process
The background process that brings the Content Index up-to-date with the filesystem. It involves walking folders, comparing file sizes and modification times (mtime) against cached values, parsing modified/new documents, batch writing to the database, and pruning deleted files.

