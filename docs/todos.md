another ai model from openrouter- what would be our estimated cost?
maybe we can add tracking total tokens before and after calling llm

via openrouter
Latency1.20s
Throughput49 tps
Uptime94.57%
Input$0.06/M tokens
Output$0.33/M tokens
Context262.1K


add other file types such as .docx and .pdf
if the files have the same name but their extension is differs such as abc.docx and abc.pdf we should check the content if its the same we should mitigate recreating the vectors and metadata



move to monorepo, add backend/server, add auth we want to productize this app
we will move summary, embedding llm and embedding api calls to backend/server
do we have folder/subfolder support if not we will implement subfolder support and add toggle 
add polar, freemium credits etc
implement analytics, logging etc maybe even history
searching precedents inside the app
add the other mcps
add the chat ui

## Ideas & Features from MetinBul Analysis (Future Considerations)
- **macOS Cloud Placeholder (`SF_DATALESS`) Detection via batch `/usr/bin/stat`**:
  - Node.js `fs.stat()` does not return BSD file flags on macOS (`flags` is undefined).
  - Adopt MetinBul's chunked child_process call (`execFile('/usr/bin/stat', ['-L', '-f', '%@:%#Xf', ...])` in 200-file batches) in `walker.ts` to reliably detect and skip dataless placeholders on iCloud Drive, OneDrive Files On-Demand, and Google Drive without native C++ addons.
- **Search Roots Auto-Discovery (`buluver folder suggest` / setup wizard auto-discovery)**:
  - Add automatic detection of standard legal archive locations:
    - `~/Library/Mobile Documents/com~apple~CloudDocs` (macOS iCloud Drive)
    - `~/Library/CloudStorage/*` (Google Drive Desktop, OneDrive)
    - `/Volumes/*` (External USB flash drives, external HDDs/SSDs)
- [x] **Extended Directory Exclusions** (Completed):
  - Expanded `SKIP_DIRS` and added `shouldSkipDir()` in `walker.ts` and `indexer.ts` (chokidar watcher) to automatically skip `.venv`, `venv`, `env`, `.cargo`, `.rustup`, `.cache`, `caches`, `Application Support`, `Containers`, `logs`, `applications`, and `.app` bundles.
