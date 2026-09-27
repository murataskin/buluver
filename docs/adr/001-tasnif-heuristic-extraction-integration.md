# ADR 001: Integration of Turkish Legal Heuristic Extraction from Tasnif

## Status
Accepted (2026-09-27)

## Context
Buluver (`izbul`) is a local-first Turkish legal document retrieval engine, CLI, and FastMCP server whose primary value proposition is helping lawyers find inspiration ("ilham almak") from their past work.

A reverse engineering evaluation of `Tasnif` (a proprietary desktop filing tool) revealed high-quality, production-tested regex and heuristic engines for extracting Turkish courts, case reference kinds (`ESAS`, `SORUSTURMA`, etc.), clean party identities, canonical document types (40+ types), and UYAP file name structures.

However, Tasnif is fundamentally a *mutating file organizer* (moves/copies files, renames documents, alters folder hierarchies, Electron GUI), whereas Buluver is strictly a *non-destructive retrieval engine* (read-only, fast, local-first search, CLI + MCP).

## Decision

We will integrate the heuristic extraction intelligence from Tasnif into Buluver under the following strict boundaries:

1. **Zero New Heavy Dependencies (No Native OCR)**:
   - We will **not** import `tesseract.js`, `@tesseract.js-data/tur`, or `@napi-rs/canvas`. Buluver remains ultra-lightweight, fast, and pure TypeScript/JavaScript.
2. **Transfer of Legal Entity & Classification Heuristics**:
   - Authority extraction & normalization (`DEFAULT_AUTHORITY_PATTERNS`, `normalizeAuthority`).
   - Case reference classification (`case_kind`: `ESAS`, `SORUSTURMA`, `DEGISIK_IS`, `TAKIP`, `BASVURU`) with precedent citation guards.
   - Party hygiene (`cleanPartyValue`: stripping TCKN, tax IDs, addresses, corporate noise) and counsel distinction (`representedRole`).
   - 40+ canonical document type taxonomy and structural inference (`DEFAULT_DOCUMENT_TYPE_RULES`, `RULES`).
   - Document date extraction (`document_date` via `DATE_PROXIMITY_KEYWORDS`).
   - UYAP filename evidence (`extractUyapFilenameEvidence`).
3. **Precedence Policy**:
   - **Body-First**: Document body text is the primary source of truth. UYAP filename patterns serve solely as fallback evidence when body text is absent, too short, or ambiguous.
4. **Schema & Retrieval Interface Expansion**:
   - Expand `files` SQLite table and `DocumentMetadata` with `case_kind` and `document_date`.
   - Incorporate these metadata fields into SQLite `files_fts` BM25 search.
   - Expose optional facet filters in CLI (`--type`, `--kind`) and MCP `search`.
5. **Absolute Boundary Invariant**:
   - Buluver will **never** adopt file movement, file renaming, directory creation, undo history, or desktop GUI code. Buluver remains 100% non-destructive and read-only.

## Consequences

- **Positive**:
  - Dramatically cleaner and more accurate metadata in SQLite and MCP `read_document`.
  - Richer search queries enabled (e.g. searching specifically within `Cevap Dilekçesi` or `SORUSTURMA` dockets).
  - High performance preserved with zero binary/native binding bloat.
  - Aligned with Buluver's core purpose ("ilham almak").
- **Negative / Trade-offs**:
  - Scanned PDF documents without embedded text layers still cannot be read without OCR (deferred to a future optional plugin if needed).
  - Minor schema migration required for existing SQLite databases.
