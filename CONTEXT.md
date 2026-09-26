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
A user-provided search term, potentially containing Boolean operators (`AND`, `OR`, `NOT`), groupings, and negative filters, used to search the Content Index.

### Sync / Index Process
The background process that brings the Content Index up-to-date with the filesystem. It involves walking folders, comparing file sizes and modification times (mtime) against cached values, parsing modified/new documents, batch writing to the database, and pruning deleted files.
