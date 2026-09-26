import { useState, useEffect } from 'react';
import { Plus, Search, RefreshCw } from 'lucide-react';

interface LogMessage {
  time: string;
  level: 'info' | 'call' | 'db' | 'error';
  message: string;
}

type TabType = 'status' | 'search' | 'folders' | 'logs' | 'guide' | 'settings';

interface FileMetadata {
  summary?: string;
  tags?: string[];
  case_number?: string;
  court_name?: string;
  document_type?: string;
  plaintiff?: string;
  defendant?: string;
}

interface SearchResult {
  path: string;
  filename: string;
  snippet: string;
  score?: number;
  mode?: string;
  metadata?: FileMetadata;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('folders');
  const [folders, setFolders] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic' | 'hybrid'>('hybrid');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [previewFileText, setPreviewFileText] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Embedding model download progress state
  const [modelStatus, setModelStatus] = useState<{
    status: string;
    progress: number;
    file: string;
  } | null>(null);

  // LLM (metadata/summary) model download progress state
  const [llmModelStatus, setLlmModelStatus] = useState<{
    status: string;
    progress: number;
    file: string;
  } | null>(null);

  // LLM provider settings state
  const [llmSettings, setLlmSettings] = useState<{
    provider: 'ollama' | 'openai' | 'gemini';
    model: string;
    apiKey: string;
    baseUrl: string;
  }>({ provider: 'ollama', model: 'qwen2.5:7b', apiKey: '', baseUrl: 'http://localhost:11434' });
  const [llmTestStatus, setLlmTestStatus] = useState<null | 'testing' | { ok: boolean; message: string }>(null);

  // Metadata editing state
  const [editingMetadataResult, setEditingMetadataResult] = useState<SearchResult | null>(null);
  const [editCourtName, setEditCourtName] = useState('');
  const [editCaseNumber, setEditCaseNumber] = useState('');
  const [editDocumentType, setEditDocumentType] = useState('');
  const [editPlaintiff, setEditPlaintiff] = useState('');
  const [editDefendant, setEditDefendant] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editTags, setEditTags] = useState('');

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advAll, setAdvAll] = useState('');
  const [advExact, setAdvExact] = useState('');
  const [advAny, setAdvAny] = useState('');
  const [advExclude, setAdvExclude] = useState('');

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const [logs, setLogs] = useState<LogMessage[]>([
    { time: '14:00:13', level: 'info', message: 'FastMCP sunucusu 3012 portunda dinleniyor...' },
    { time: '14:00:15', level: 'info', message: 'SQLite veritabanı FTS5 indeksleri yükliyor...' },
    { time: '14:00:16', level: 'info', message: 'Konfigürasyondan 2 kök dizin başarıyla yüklendi.' }
  ]);

  // Load directories and initial status on mount
  useEffect(() => {
    const api = (window as any).api;
    if (!api) return;

    api.getFolders().then((fs: string[]) => setFolders(fs));
    api.getStatus().then((status: any) => {
      setIsScanning(status.isScanning);
      setScanProgress(status.progress);
      setTotalFiles(status.filesCount);
      if (status.folders) setFolders(status.folders);
    });
    // Load LLM settings
    if (api.getLlmSettings) {
      api.getLlmSettings().then((s: any) => {
        if (s) setLlmSettings(s);
      });
    }

    // Listen for background status updates
    const unsubscribe = api.onStatusChange((status: any) => {
      setIsScanning(status.isScanning);
      setScanProgress(status.progress);
      setTotalFiles(status.filesCount);
      if (status.folders) setFolders(status.folders);

      if (status.info) {
        setLogs(prev => [
          ...prev,
          { time: new Date().toTimeString().split(' ')[0], level: 'info', message: status.info }
        ]);
      }
    });

    // Listen for embedding model download progress
    const unsubscribeModel = api.onEmbeddingProgress((data: any) => {
      if (data.status === 'progress') {
        setModelStatus({
          status: 'downloading',
          progress: Math.round(data.progress || 0),
          file: data.file || ''
        });
      } else if (data.status === 'ready' || data.status === 'done') {
        setModelStatus(null);
      } else if (data.status === 'downloading') {
        setModelStatus({
          status: 'downloading',
          progress: 0,
          file: data.file || ''
        });
      }
    });

    // Listen for LLM (metadata/summary) model download progress
    const unsubscribeLlm = api.onLlmProgress((data: any) => {
      if (data.status === 'progress') {
        setLlmModelStatus({
          status: 'downloading',
          progress: Math.round(data.progress || 0),
          file: data.file || ''
        });
      } else if (data.status === 'ready' || data.status === 'done') {
        setLlmModelStatus(null);
      } else if (data.status === 'downloading') {
        setLlmModelStatus({
          status: 'downloading',
          progress: 0,
          file: data.file || ''
        });
      }
    });

    return () => {
      unsubscribe();
      unsubscribeModel();
      unsubscribeLlm();
    };
  }, []);

  // Handle full-text search trigger
  useEffect(() => {
    const api = (window as any).api;
    if (!api || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const delaySearch = setTimeout(() => {
      api.search(searchQuery, searchMode).then((results: SearchResult[]) => {
        setSearchResults(results);
      });
    }, 150); // debounce input

    return () => clearTimeout(delaySearch);
  }, [searchQuery, searchMode]);

  // Handle metadata editing side effect
  useEffect(() => {
    if (editingMetadataResult && editingMetadataResult.metadata) {
      setEditCourtName(editingMetadataResult.metadata.court_name || '');
      setEditCaseNumber(editingMetadataResult.metadata.case_number || '');
      setEditDocumentType(editingMetadataResult.metadata.document_type || '');
      setEditPlaintiff(editingMetadataResult.metadata.plaintiff || '');
      setEditDefendant(editingMetadataResult.metadata.defendant || '');
      setEditSummary(editingMetadataResult.metadata.summary || '');
      setEditTags(editingMetadataResult.metadata.tags ? editingMetadataResult.metadata.tags.join(', ') : '');
    } else {
      setEditCourtName('');
      setEditCaseNumber('');
      setEditDocumentType('');
      setEditPlaintiff('');
      setEditDefendant('');
      setEditSummary('');
      setEditTags('');
    }
  }, [editingMetadataResult]);

  // Combine advanced search parameters dynamically
  useEffect(() => {
    if (!showAdvanced) return;

    const parts: string[] = [];
    if (advAll.trim()) {
      parts.push(advAll.trim());
    }
    if (advExact.trim()) {
      const term = advExact.trim();
      const wrapped = term.startsWith('"') && term.endsWith('"') ? term : `"${term}"`;
      parts.push(wrapped);
    }
    if (advAny.trim()) {
      const terms = advAny.trim().split(/\s+/).join(' OR ');
      parts.push(`(${terms})`);
    }
    if (advExclude.trim()) {
      const terms = advExclude.trim().split(/\s+/).map(t => t.startsWith('-') ? t : `-${t}`).join(' ');
      parts.push(terms);
    }

    setSearchQuery(parts.join(' '));
  }, [advAll, advExact, advAny, advExclude, showAdvanced]);

  const selectAndAddFolder = async () => {
    const api = (window as any).api;
    if (api) {
      const selectedPath = await api.selectFolder();
      if (selectedPath && !folders.includes(selectedPath)) {
        await api.addFolder(selectedPath);
        setFolders(prev => [...prev, selectedPath]);
      }
    }
  };

  const removeFolder = async (folder: string) => {
    const api = (window as any).api;
    if (api) {
      await api.removeFolder(folder);
      setFolders(prev => prev.filter(f => f !== folder));
    }
  };

  const triggerRescan = async () => {
    const api = (window as any).api;
    if (api) {
      await api.scanFolders();
    }
  };

  const saveMetadata = async () => {
    if (!editingMetadataResult) return;
    const api = (window as any).api;
    if (api) {
      const tagsArray = editTags.split(',').map(t => t.trim()).filter(Boolean);
      const success = await api.updateMetadata(editingMetadataResult.path, {
        court_name: editCourtName,
        case_number: editCaseNumber,
        document_type: editDocumentType,
        plaintiff: editPlaintiff,
        defendant: editDefendant,
        summary: editSummary,
        tags: tagsArray
      });
      if (success) {
        api.search(searchQuery, searchMode).then((results: SearchResult[]) => {
          setSearchResults(results);
        });
        setEditingMetadataResult(null);
      }
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0d0d0e] text-[#c5c5c7] font-sans selection:bg-[#f05252]/30 select-none">
      <aside className="w-64 border-r border-[#1c1d1e] p-6 flex flex-col gap-6 bg-[#0a0a0b] flex-shrink-0">
        {/* Brand Logo & Name */}
        <div className="flex items-center gap-2 mt-2">
          <span className="font-serif text-2xl font-semibold tracking-tight text-white">İzBul</span>
          <span className="text-[10px] tracking-wide px-2 py-0.5 rounded bg-white/10 text-white font-bold font-mono">PRO</span>
        </div>

        {/* Navigation Sidebar menu items */}
        <nav className="flex flex-col gap-1 mt-4">
          <div
            onClick={() => setActiveTab('status')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'status' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            Durum
          </div>
          <div
            onClick={() => setActiveTab('search')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'search' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            Evrak Arama
          </div>
          <div
            onClick={() => setActiveTab('folders')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'folders' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            Dizin Yönetimi
          </div>
          <div
            onClick={() => setActiveTab('logs')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'logs' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            FastMCP Logları
          </div>
          <div
            onClick={() => setActiveTab('guide')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'guide' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            MCP Kurulumu
          </div>
          <div
            onClick={() => setActiveTab('settings')}
            className={"px-4 py-2.5 rounded-xl cursor-pointer text-sm font-medium transition-all " + (activeTab === 'settings' ? "bg-white/10 text-white" : "text-[#9fa0a3] hover:text-white hover:bg-white/5")}
          >
            Ayarlar
          </div>
        </nav>

        {/* Sidebar Footer */}
        <div className="mt-auto pt-6 border-t border-[#1c1d1e] flex items-center justify-between text-xs text-slate-500 font-mono">
          <span>FastMCP: active</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-y-auto content-glow flex flex-col gap-6 relative">

        {/* ==================== TAB 1: DİZİN YÖNETİMİ ==================== */}
        {activeTab === 'folders' && (
          <div className="flex flex-col gap-6 animate-fade-in">

            {/* Header controls row */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-serif text-3xl text-white tracking-tight">Dizin Yönetimi</h2>
                <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">{folders.length} Dizin listeleniyor</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={selectAndAddFolder}
                  className="px-4 py-2 rounded-full border border-slate-800 hover:border-slate-700 text-xs font-medium text-white transition-all bg-white/5 hover:bg-white/10 flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Yeni Dizin Ekle
                </button>
              </div>
            </div>

            {/* Simulated progress indicator if indexing */}
            {isScanning && (
              <div className="p-5 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400 font-medium flex items-center gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#f05252]" /> Dizin taranıyor ve UDF verileri çözümleniyor...
                  </span>
                  <span className="font-mono text-white">{scanProgress}%</span>
                </div>
                <div className="w-full bg-[#141517] rounded-full h-1 overflow-hidden">
                  <div className="bg-[#f05252] h-full transition-all duration-300" style={{ width: `${scanProgress}%` }}></div>
                </div>
              </div>
            )}

            {/* Directories Cards List (Matching Yargı PRO item styling) */}
            <div className="flex flex-col gap-3 mt-2">
              {folders.length === 0 ? (
                <div className="p-10 rounded-2xl border border-dashed border-slate-800 text-center text-slate-500 text-sm">
                  Henüz izlenen bir dizin bulunmuyor. Yeni Dizin Ekle butonunu kullanarak başlayın.
                </div>
              ) : (
                folders.map((folder) => {
                  const folderName = folder.split('/').pop() || folder;
                  return (
                    <div
                      key={folder}
                      className="p-5 rounded-2xl bg-[#0a0a0b]/80 border border-[#1c1d1e] hover:border-slate-800 transition-all flex items-center justify-between"
                    >
                      <div className="flex flex-col gap-1 overflow-hidden">
                        <span className="text-sm font-semibold text-white tracking-wide truncate max-w-lg">{folderName}</span>
                        <p className="text-xs text-slate-500 font-mono truncate max-w-lg">{folder}</p>
                      </div>

                      <div className="flex items-center gap-4 flex-shrink-0">
                        {/* Tags */}
                        <span className="px-3 py-1 rounded-full border border-slate-800 text-[10px] text-slate-400 font-medium bg-white/5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          İzleniyor
                        </span>
                        <span className="px-3 py-1 rounded-full border border-slate-800 text-[10px] text-slate-400 font-medium bg-white/5 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          UDF Aktif
                        </span>

                        {/* Actions */}
                        <button
                          onClick={triggerRescan}
                          className="px-4 py-1.5 rounded-full border border-slate-850 hover:border-slate-700 bg-white/5 hover:bg-white/10 text-xs font-semibold text-white transition-all"
                        >
                          Şimdi Tara
                        </button>

                        <button
                          onClick={() => removeFolder(folder)}
                          className="px-4 py-1.5 rounded-full btn-glow-accent text-xs font-semibold"
                        >
                          Kaldır
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </div>
        )}

        {/* ==================== TAB 2: EVRAK ARAMA ==================== */}
        {activeTab === 'search' && (
          <div className="flex flex-col gap-6 animate-fade-in">
            <div className="flex justify-between items-start">
              <div>
                <h2 className="font-serif text-3xl text-white tracking-tight">Evrak Arama</h2>
                <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">UDF Dosya İçeriği Arama</p>
              </div>
            </div>

            {/* Search inputs bar */}
            <div className="flex flex-col gap-3 max-w-3xl">
              <div className="flex items-center bg-[#0a0a0b] rounded-2xl border border-[#1c1d1e] px-4 py-3 gap-3 shadow-sm">
                <Search className="w-5 h-5 text-[#f05252] flex-shrink-0" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Arama yapın (cümle, kelime veya boolean)..."
                  className="w-full bg-transparent border-none outline-none text-sm placeholder:text-slate-600 text-white"
                />

                {/* Search Mode Toggles */}
                <div className="flex items-center gap-1 bg-[#141517] p-1 rounded-xl border border-slate-850 flex-shrink-0">
                  <button
                    onClick={() => setSearchMode('keyword')}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${searchMode === 'keyword'
                        ? 'bg-white/10 text-white'
                        : 'text-slate-500 hover:text-slate-350'
                      }`}
                  >
                    Anahtar Kelime
                  </button>
                  <button
                    onClick={() => setSearchMode('semantic')}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${searchMode === 'semantic'
                        ? 'bg-white/10 text-white'
                        : 'text-slate-500 hover:text-slate-350'
                      }`}
                  >
                    Anlamsal
                  </button>
                  <button
                    onClick={() => setSearchMode('hybrid')}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all ${searchMode === 'hybrid'
                        ? 'bg-white/10 text-white'
                        : 'text-slate-500 hover:text-slate-350'
                      }`}
                  >
                    Hibrit
                  </button>
                </div>

                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className={`text-[10px] uppercase font-bold tracking-wider px-3 py-1.5 rounded-xl border transition-all flex-shrink-0 ${showAdvanced
                      ? 'border-[#f05252] bg-[#f05252]/10 text-[#f05252]'
                      : 'border-slate-800 hover:border-slate-700 bg-white/5 text-slate-400 hover:text-white'
                    }`}
                >
                  Gelişmiş
                </button>
              </div>

              {/* Advanced Search Options Grid */}
              {showAdvanced && (
                <div className="p-5 rounded-2xl bg-[#0a0a0b]/60 border border-[#1c1d1e] flex flex-col gap-4 animate-fade-in">
                  <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Gelişmiş Arama Filtreleri</span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-slate-400">Kelimelerin Hepsini İçersin (AND)</label>
                      <input
                        type="text"
                        value={advAll}
                        onChange={(e) => setAdvAll(e.target.value)}
                        placeholder="Örn: kira tespit"
                        className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-750 focus:outline-none focus:border-[#f05252]"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-slate-400">Aynen Eşleşecek İfade (Exact Phrase)</label>
                      <input
                        type="text"
                        value={advExact}
                        onChange={(e) => setAdvExact(e.target.value)}
                        placeholder="Örn: samimi ve zorunlu ihtiyaç"
                        className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-750 focus:outline-none focus:border-[#f05252]"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-slate-400">Kelimelerden Herhangi Biri (OR)</label>
                      <input
                        type="text"
                        value={advAny}
                        onChange={(e) => setAdvAny(e.target.value)}
                        placeholder="Örn: tahliye ihtar"
                        className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-750 focus:outline-none focus:border-[#f05252]"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[11px] font-semibold text-slate-400">Kelimelerin Hiçbirini İçermesin (NOT)</label>
                      <input
                        type="text"
                        value={advExclude}
                        onChange={(e) => setAdvExclude(e.target.value)}
                        placeholder="Örn: taslak örnek"
                        className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-750 focus:outline-none focus:border-[#f05252]"
                      />
                    </div>
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-slate-500 font-mono mt-1 border-t border-[#1c1d1e] pt-3">
                    <span className="truncate max-w-[80%]">Sorgu Stringi: <strong className="text-slate-350 font-semibold">{searchQuery || "(boş)"}</strong></span>
                    <button
                      onClick={() => {
                        setAdvAll('');
                        setAdvExact('');
                        setAdvAny('');
                        setAdvExclude('');
                        setSearchQuery('');
                      }}
                      className="text-[#f05252]/80 hover:text-[#f05252] transition-colors"
                    >
                      Temizle
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Results list */}
            {searchQuery.trim() && (
              <div className="flex flex-col gap-4 mt-4">
                <p className="text-xs text-slate-500 px-1 font-mono uppercase">{searchResults.length} Evrak Eşleşti</p>

                {searchResults.length === 0 ? (
                  <div className="p-8 rounded-2xl border border-slate-800 text-center text-slate-500 text-xs font-mono">
                    Herhangi bir eşleşme bulunamadı.
                  </div>
                ) : (
                  searchResults.map((result) => (
                    <div
                      key={result.path}
                      className="p-6 rounded-2xl bg-[#0a0a0b]/80 border border-[#1c1d1e] hover:border-slate-800 transition-all flex flex-col gap-4 animate-fade-in"
                    >
                      {/* Top Header Row */}
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex flex-col gap-1 overflow-hidden">
                          <span className="text-sm font-semibold text-white tracking-wide truncate max-w-lg">{result.filename}</span>
                          <p className="text-xs text-slate-500 font-mono truncate max-w-lg">{result.path}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {result.score !== undefined && (
                            <span className="px-2 py-0.5 rounded bg-white/5 border border-slate-800 text-[10px] text-slate-400 font-mono">
                              Skor: {result.score.toFixed(4)}
                            </span>
                          )}
                          <span className={`px-3 py-1 rounded-full border text-[10px] font-medium flex items-center gap-1.5 ${result.mode === 'keyword'
                              ? 'border-blue-900 bg-blue-950/20 text-blue-400'
                              : result.mode === 'semantic'
                                ? 'border-amber-900 bg-amber-950/20 text-amber-400'
                                : 'border-purple-900 bg-purple-950/20 text-purple-400'
                            }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${result.mode === 'keyword' ? 'bg-blue-400' : result.mode === 'semantic' ? 'bg-amber-400' : 'bg-purple-400'
                              }`} />
                            {result.mode === 'keyword' ? 'Anahtar Kelime' : result.mode === 'semantic' ? 'Anlamsal' : 'Hibrit'}
                          </span>
                        </div>
                      </div>

                      {/* Case Metadata Grid */}
                      {result.metadata && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 bg-[#040506] p-4 rounded-xl border border-[#151618] text-xs">
                          {result.metadata.court_name && (
                            <div className="flex flex-col gap-0.5 col-span-2">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Mahkeme</span>
                              <span className="text-white truncate">{result.metadata.court_name}</span>
                            </div>
                          )}
                          {result.metadata.case_number && (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Dosya No</span>
                              <span className="text-white font-mono">{result.metadata.case_number}</span>
                            </div>
                          )}
                          {result.metadata.document_type && (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Belge Türü</span>
                              <span className="text-white truncate">{result.metadata.document_type}</span>
                            </div>
                          )}
                          {result.metadata.plaintiff && (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Davacı/Müşteki</span>
                              <span className="text-white truncate">{result.metadata.plaintiff}</span>
                            </div>
                          )}
                          {result.metadata.defendant && (
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Davalı/Sanık</span>
                              <span className="text-white truncate">{result.metadata.defendant}</span>
                            </div>
                          )}
                          {result.metadata.summary && (
                            <div className="flex flex-col gap-0.5 col-span-2 md:col-span-4 border-t border-[#1c1d1e] pt-2 mt-1">
                              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Özet</span>
                              <span className="text-slate-350 leading-relaxed text-justify">{result.metadata.summary}</span>
                            </div>
                          )}
                          {result.metadata.tags && result.metadata.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 col-span-2 md:col-span-4 mt-1">
                              {result.metadata.tags.map(tag => (
                                <span key={tag} className="px-2 py-0.5 rounded bg-[#f05252]/10 border border-[#f05252]/20 text-[9px] text-[#f05252] font-semibold">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Snippet Row */}
                      {result.snippet && (
                        <div
                          className="text-xs leading-relaxed text-slate-400 bg-white/[0.01] p-3 rounded-lg border border-slate-900/60 max-h-24 overflow-y-auto"
                          dangerouslySetInnerHTML={{ __html: result.snippet }}
                        />
                      )}

                      {/* Actions Row */}
                      <div className="flex justify-end items-center gap-3">
                        <button
                          onClick={() => setEditingMetadataResult(result)}
                          className="px-3.5 py-1.5 rounded-full border border-slate-850 hover:border-slate-700 bg-white/5 hover:bg-white/10 text-[11px] font-semibold text-white transition-all"
                        >
                          Metadatayı Düzenle
                        </button>
                        <button
                          onClick={() => setPreviewFileText(result.snippet || '<i>Bu belge için içerik bulunmuyor.</i>')}
                          className="px-3.5 py-1.5 rounded-full border border-slate-850 hover:border-slate-700 bg-white/5 hover:bg-white/10 text-[11px] font-semibold text-white transition-all"
                        >
                          Tam Metin Önizle
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* ==================== TAB 3: DURUM ==================== */}
        {activeTab === 'status' && (
          <div className="flex flex-col gap-6 animate-fade-in">
            <div>
              <h2 className="font-serif text-3xl text-white tracking-tight">Sistem Durumu</h2>
              <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">İndeksleme & Dizin İstatistikleri</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-2">
              <div className="bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col justify-between h-40">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tarama Durumu</span>
                <div>
                  <div className="text-3xl font-bold text-white mt-2">{isScanning ? 'Taranıyor' : 'Hazır'}</div>
                  <p className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    {isScanning ? 'Dizinlerde yeni dosya araması yapılıyor...' : 'Tüm dizinler güncel durumda'}
                  </p>
                </div>
              </div>

              <div className="bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col justify-between h-40">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">İndekslenen UDF</span>
                <div>
                  <div className="text-3xl font-bold text-white mt-2 font-mono">{totalFiles}</div>
                  <p className="text-xs text-slate-500 mt-1">İzleme altındaki toplam belge adedi</p>
                </div>
              </div>

              <div className="bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col justify-between h-40">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">İzlenen Dizin</span>
                <div>
                  <div className="text-3xl font-bold text-white mt-2 font-mono">{folders.length}</div>
                  <p className="text-xs text-slate-500 mt-1">Sistem tarafından taranan kök yollar</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== TAB 4: LOGLAR ==================== */}
        {activeTab === 'logs' && (
          <div className="flex flex-col gap-6 animate-fade-in h-full">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-serif text-3xl text-white tracking-tight">FastMCP Logları</h2>
                <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">AI Ajanı Sunucu Günlükleri</p>
              </div>
              <button
                onClick={triggerRescan}
                className="px-4 py-1.5 rounded-full border border-slate-800 hover:border-slate-700 bg-white/5 hover:bg-white/10 text-xs font-semibold text-white transition-all flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Dizinleri Yeniden Tara
              </button>
            </div>

            <div className="bg-[#040506] rounded-2xl p-6 font-mono text-xs leading-relaxed text-slate-400 overflow-y-auto flex-1 border border-[#1c1d1e] max-h-[480px]">
              {logs.map((log, index) => {
                let colorClass = 'text-slate-400';
                if (log.level === 'info') colorClass = 'text-emerald-500/90';
                else if (log.level === 'call') colorClass = 'text-amber-500/90';
                else if (log.level === 'db') colorClass = 'text-slate-500';
                else if (log.level === 'error') colorClass = 'text-red-400/90';

                return (
                  <p key={index} className="mb-1">
                    <span className="text-slate-600 mr-2">[{log.time}]</span>
                    <span className={colorClass}>{log.message}</span>
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {/* ==================== TAB 5: MCP SETUP GUIDE ==================== */}
        {activeTab === 'guide' && (
          <div className="flex flex-col gap-6 animate-fade-in max-w-4xl pb-12">
            <div>
              <h2 className="font-serif text-3xl text-white tracking-tight">MCP Kurulum Kılavuzu</h2>
              <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">İzBul Pro'yu Yapay Zeka Ajanlarına Bağlayın</p>
            </div>

            {/* Warning Callout Box */}
            <div className="p-4 rounded-xl border border-amber-500/25 bg-amber-500/5 flex flex-col gap-1 relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-amber-500" />
              <span className="text-xs font-bold text-amber-500 uppercase tracking-wide">Önemli Gereksinim</span>
              <p className="text-xs text-slate-350 leading-relaxed">
                İzBul MCP sunucusunun bağlantıları yanıtlayabilmesi için bilgisayarınızda **İzBul** uygulamasının arka planda açık ve çalışır durumda olması gerekmektedir. Sunucu yerel olarak <strong>http://localhost:3012/mcp</strong> adresini dinler.
              </p>
            </div>

            {/* Guide Sections Grid */}
            <div className="flex flex-col gap-6 mt-2">

              {/* Claude Desktop Setup */}
              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-base font-semibold text-white">Claude Desktop</h3>
                  <span className="text-[10px] text-slate-500 font-mono uppercase">Önerilen</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Claude Desktop uygulamasını yerel İzBul sunucuna bağlamak için yapılandırma dosyasına ekleme yapın:
                </p>
                <div className="text-xs text-slate-400 flex flex-col gap-2 bg-slate-900/50 p-3 rounded-lg border border-slate-800/80">
                  <p>1. macOS işletim sisteminde <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> dosyasını açın (Windows: <code>%APPDATA%\Claude\claude_desktop_config.json</code>).</p>
                  <p>2. Dosya içerisindeki <code>mcpServers</code> bloğuna aşağıdaki JSON nesnesini ekleyin:</p>
                </div>

                {/* Code block with copy action */}
                <div className="relative group mt-1">
                  <button
                    onClick={() => copyToClipboard(
                      JSON.stringify({
                        mcpServers: {
                          "izbul-mcp-pro": {
                            "command": "npx",
                            "args": ["-y", "mcp-remote", "http://localhost:3012/mcp"]
                          }
                        }
                      }, null, 2),
                      'claude'
                    )}
                    className="absolute right-2 top-2 px-2.5 py-1 rounded bg-[#1c1d1e] hover:bg-slate-800 border border-[#2f3031] text-[10px] font-semibold text-white transition-all"
                  >
                    {copiedId === 'claude' ? 'Kopyalandı!' : 'Kopyala'}
                  </button>
                  <pre className="p-4 rounded-xl bg-[#040506] border border-[#1c1d1e] text-xs font-mono text-[#ff6363] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {`{
  "mcpServers": {
    "izbul-mcp-pro": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://localhost:3012/mcp"
      ]
    }
  }
}`}
                  </pre>
                </div>
              </div>

              {/* Cursor Setup */}
              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-3">
                <h3 className="text-base font-semibold text-white">Cursor IDE</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Cursor ayarlarında <strong>Settings</strong> → <strong>Features</strong> (veya Tools & MCP) → <strong>Add new MCP server</strong> yolunu izleyin:
                </p>
                <div className="grid grid-cols-3 gap-2 text-xs p-3.5 bg-slate-900/50 rounded-lg border border-slate-800/80">
                  <div><strong>Name:</strong> <code className="text-[#ff6363]">İzBul</code></div>
                  <div><strong>Type:</strong> <code className="text-[#ff6363]">SSE</code></div>
                  <div className="col-span-1"><strong>URL:</strong> <code className="text-[#ff6363]">http://localhost:3012/mcp</code></div>
                </div>
                <p className="text-xs text-slate-450 mt-1">
                  Alternatif olarak, Cursor yapılandırma dosyasını (<code>~/.cursor/mcp.json</code>) doğrudan güncelleyebilirsiniz:
                </p>

                <div className="relative group">
                  <button
                    onClick={() => copyToClipboard(
                      JSON.stringify({
                        mcpServers: {
                          "izbul-mcp-pro": {
                            "type": "sse",
                            "url": "http://localhost:3012/mcp"
                          }
                        }
                      }, null, 2),
                      'cursor'
                    )}
                    className="absolute right-2 top-2 px-2.5 py-1 rounded bg-[#1c1d1e] hover:bg-slate-800 border border-[#2f3031] text-[10px] font-semibold text-white transition-all"
                  >
                    {copiedId === 'cursor' ? 'Kopyalandı!' : 'Kopyala'}
                  </button>
                  <pre className="p-4 rounded-xl bg-[#040506] border border-[#1c1d1e] text-xs font-mono text-[#ff6363] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {`{
  "mcpServers": {
    "izbul-mcp-pro": {
      "type": "sse",
      "url": "http://localhost:3012/mcp"
    }
  }
}`}
                  </pre>
                </div>
              </div>

              {/* Google Antigravity Setup */}
              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-3">
                <h3 className="text-base font-semibold text-white">Google Antigravity</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Antigravity ve Gemini ile yerel UDF indekslerinizi sorgulamak için işletim sisteminize uygun kodu terminalde çalıştırın:
                </p>

                {/* macOS / Linux command */}
                <div className="flex flex-col gap-1.5 mt-1">
                  <span className="text-[10px] font-mono text-slate-500 uppercase">macOS / Linux</span>
                  <div className="relative group">
                    <button
                      onClick={() => copyToClipboard(
                        `node - <<'IZBUL'\nconst fs=require("fs"),os=require("os"),path=require("path");\nconst dir=path.join(os.homedir(),".gemini","config"),file=path.join(dir,"mcp_config.json");\nfs.mkdirSync(dir,{recursive:true});\nlet cfg={};try{cfg=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}\nif(typeof cfg!=="object"||cfg===null||Array.isArray(cfg))cfg={};\nif(typeof cfg.mcpServers!=="object"||cfg.mcpServers===null)cfg.mcpServers={};\ncfg.mcpServers["izbul-mcp-pro"]={command:"npx",args:["-y","mcp-remote","http://localhost:3012/mcp"]};\nfs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");\nconsole.log("izbul-mcp-pro eklendi -> "+file);\nIZBUL`,
                        'gemini-mac'
                      )}
                      className="absolute right-2 top-2 px-2.5 py-1 rounded bg-[#1c1d1e] hover:bg-slate-800 border border-[#2f3031] text-[10px] font-semibold text-white transition-all"
                    >
                      {copiedId === 'gemini-mac' ? 'Kopyalandı!' : 'Kopyala'}
                    </button>
                    <pre className="p-4 rounded-xl bg-[#040506] border border-[#1c1d1e] text-[10px] font-mono text-[#ff6363] overflow-x-auto whitespace-pre-wrap leading-normal">
                      {`node - <<'IZBUL'
const fs=require("fs"),os=require("os"),path=require("path");
const dir=path.join(os.homedir(),".gemini","config"),file=path.join(dir,"mcp_config.json");
fs.mkdirSync(dir,{recursive:true});
let cfg={};try{cfg=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
if(typeof cfg!=="object"||cfg===null||Array.isArray(cfg))cfg={};
if(typeof cfg.mcpServers!=="object"||cfg.mcpServers===null)cfg.mcpServers={};
cfg.mcpServers["izbul-mcp-pro"]={command:"npx",args:["-y","mcp-remote","http://localhost:3012/mcp"]};
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");
console.log("izbul-mcp-pro eklendi -> "+file);
IZBUL`}
                    </pre>
                  </div>
                </div>

                {/* Windows command */}
                <div className="flex flex-col gap-1.5 mt-2">
                  <span className="text-[10px] font-mono text-slate-500 uppercase">Windows (PowerShell)</span>
                  <div className="relative group">
                    <button
                      onClick={() => copyToClipboard(
                        `@'\nconst fs=require("fs"),os=require("os"),path=require("path");\nconst dir=path.join(os.homedir(),".gemini","config"),file=path.join(dir,"mcp_config.json");\nfs.mkdirSync(dir,{recursive:true});\nlet cfg={};try{cfg=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}\nif(typeof cfg!=="object"||cfg===null||Array.isArray(cfg))cfg={};\nif(typeof cfg.mcpServers!=="object"||cfg.mcpServers===null)cfg.mcpServers={};\ncfg.mcpServers["izbul-mcp-pro"]={command:"cmd",args:["/c","npx","-y","mcp-remote","http://localhost:3012/mcp"]};\nfs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");\nconsole.log("izbul-mcp-pro eklendi -> "+file);\n'@ | node -`,
                        'gemini-win'
                      )}
                      className="absolute right-2 top-2 px-2.5 py-1 rounded bg-[#1c1d1e] hover:bg-slate-800 border border-[#2f3031] text-[10px] font-semibold text-white transition-all"
                    >
                      {copiedId === 'gemini-win' ? 'Kopyalandı!' : 'Kopyala'}
                    </button>
                    <pre className="p-4 rounded-xl bg-[#040506] border border-[#1c1d1e] text-[10px] font-mono text-[#ff6363] overflow-x-auto whitespace-pre-wrap leading-normal">
                      {`@'
const fs=require("fs"),os=require("os"),path=require("path");
const dir=path.join(os.homedir(),".gemini","config"),file=path.join(dir,"mcp_config.json");
fs.mkdirSync(dir,{recursive:true});
let cfg={};try{cfg=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
if(typeof cfg!=="object"||cfg===null||Array.isArray(cfg))cfg={};
if(typeof cfg.mcpServers!=="object"||cfg.mcpServers===null)cfg.mcpServers={};
cfg.mcpServers["izbul-mcp-pro"]={command:"cmd",args:["/c","npx","-y","mcp-remote","http://localhost:3012/mcp"]};
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\\n");
console.log("izbul-mcp-pro eklendi -> "+file);
'@ | node -`}
                    </pre>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}
        {/* ==================== TAB 6: AYARLAR ==================== */}
        {activeTab === 'settings' && (
          <div className="flex flex-col gap-6 animate-fade-in max-w-3xl">
            <div>
              <h2 className="font-serif text-3xl text-white tracking-tight">Ayarlar</h2>
              <p className="text-xs text-slate-500 mt-2 font-mono uppercase tracking-wider">Model ve Arama Konfigürasyonu</p>
            </div>

            <div className="flex flex-col gap-4 mt-2">
              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-3">
                <h3 className="text-base font-semibold text-white">Anlamsal Arama (Embedding) Modeli</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Evraklarınızı parçalara ayırmak ve anlamsal vektörlerini çıkarmak için yerel olarak çalışan Hugging Face ONNX modeli.
                </p>
                <div className="flex items-center justify-between p-4 bg-slate-900/50 rounded-xl border border-slate-800/85 mt-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-semibold text-white font-mono">Xenova/paraphrase-multilingual-MiniLM-L12-v2</span>
                    <span className="text-[10px] text-slate-500">Türkçe dahil çok dilli destek, hafif (~45MB), 384 vektör boyutu</span>
                  </div>
                  <span className="px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-500 text-[10px] font-bold font-mono">AKTİF & YEREL</span>
                </div>
              </div>

              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-3">
                <h3 className="text-base font-semibold text-white">Hibrit Arama (RRF) Ağırlıklandırması</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Reciprocal Rank Fusion (RRF) formülü, anahtar kelime eşleşmesi (FTS5) ve anlamsal aramayı birleştirerek en iyi sıralamayı üretir.
                </p>
                <pre className="p-3 rounded-lg bg-[#040506] border border-[#1c1d1e] text-[10px] font-mono text-slate-500">
                  RRF(d) = 1 / (60 + Rank_FTS(d)) + 1 / (60 + Rank_Semantic(d))
                </pre>
              </div>

              {/* LLM Provider Config Card */}
              <div className="p-6 rounded-2xl bg-[#0a0a0b] border border-[#1c1d1e] flex flex-col gap-4">
                <div>
                  <h3 className="text-base font-semibold text-white">AI Metadata & Özet Sağlayıcı</h3>
                  <p className="text-xs text-slate-400 leading-relaxed mt-1">
                    Evraklardan otomatik özet ve etiket üretmek için kullanılacak LLM. Şu an yerel Ollama,
                    ilerleyen aşamada OpenAI veya Gemini'ye geçilebilir.
                  </p>
                </div>

                {/* Provider selector */}
                <div className="flex gap-2">
                  {(['ollama', 'openai', 'gemini'] as const).map(p => (
                    <button
                      key={p}
                      onClick={() => setLlmSettings(s => ({ ...s, provider: p }))}
                      className={`flex-1 py-2 rounded-xl border text-xs font-semibold transition-all ${llmSettings.provider === p
                          ? 'bg-violet-600/25 border-violet-500/60 text-violet-300'
                          : 'bg-white/3 border-white/10 text-slate-400 hover:text-white hover:bg-white/8'
                        }`}
                    >
                      {p === 'ollama' ? '🦙 Ollama' : p === 'openai' ? '⚡ OpenAI' : '✦ Gemini'}
                    </button>
                  ))}
                </div>

                {/* Model name */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Model</label>
                  <input
                    type="text"
                    value={llmSettings.model}
                    onChange={e => setLlmSettings(s => ({ ...s, model: e.target.value }))}
                    placeholder={llmSettings.provider === 'ollama' ? 'qwen2.5:7b' : llmSettings.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-2.0-flash'}
                    className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/50 font-mono"
                  />
                  {llmSettings.provider === 'ollama' && (
                    <p className="text-[10px] text-slate-600">
                      Ollama'da mevcut modeller: <span className="font-mono text-slate-500">qwen2.5:7b, gemma3:4b, llama3.2:3b, mistral:7b</span>
                    </p>
                  )}
                </div>

                {/* Base URL — Ollama or custom OpenAI-compatible */}
                {(llmSettings.provider === 'ollama' || llmSettings.provider === 'openai') && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                      {llmSettings.provider === 'ollama' ? 'Ollama URL' : 'API Base URL'}
                    </label>
                    <input
                      type="text"
                      value={llmSettings.baseUrl}
                      onChange={e => setLlmSettings(s => ({ ...s, baseUrl: e.target.value }))}
                      placeholder={llmSettings.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/50 font-mono"
                    />
                  </div>
                )}

                {/* API Key — OpenAI / Gemini */}
                {llmSettings.provider !== 'ollama' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">API Key</label>
                    <input
                      type="password"
                      value={llmSettings.apiKey}
                      onChange={e => setLlmSettings(s => ({ ...s, apiKey: e.target.value }))}
                      placeholder="sk-..."
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-sm text-white placeholder:text-slate-700 focus:outline-none focus:border-violet-500/50 font-mono"
                    />
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={async () => {
                      const api = (window as any).api;
                      if (!api) return;
                      await api.setLlmSettings(llmSettings);
                      setLlmTestStatus('testing');
                      const result = await api.testLlmConnection();
                      setLlmTestStatus(result);
                      setTimeout(() => setLlmTestStatus(null), 4000);
                    }}
                    className="flex-1 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-xs font-semibold text-white transition-all"
                  >
                    Kaydet & Test Et
                  </button>
                  <button
                    onClick={() => {
                      const api = (window as any).api;
                      if (api) api.enrichMetadata();
                    }}
                    className="flex-1 py-2 rounded-xl bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 text-xs font-semibold text-violet-300 transition-all"
                  >
                    Eksik Özetleri Üret
                  </button>
                </div>

                {/* Test status feedback */}
                {llmTestStatus !== null && (
                  <div className={`px-4 py-2.5 rounded-xl text-xs font-mono ${llmTestStatus === 'testing'
                      ? 'bg-slate-800/50 text-slate-400'
                      : (llmTestStatus as any).ok
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                    }`}>
                    {llmTestStatus === 'testing'
                      ? '⏳ Bağlantı test ediliyor...'
                      : (llmTestStatus as any).ok
                        ? `✓ ${(llmTestStatus as any).message}`
                        : `✗ ${(llmTestStatus as any).message}`
                    }
                  </div>
                )}

                <p className="text-[10px] text-slate-600 leading-relaxed -mt-1">
                  "Eksik Özetleri Üret" — henüz işlenmemiş evraklara AI özet + etiket ekler. İlerlemeyi Durum sekmesinden takip edin.
                </p>
              </div>
            </div>
          </div>
        )}



        {/* ============================================================= */}
        {/* DETAILS DOCUMENT PREVIEW OVERLAY MODAL                        */}
        {/* ============================================================= */}
        {previewFileText && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in p-6">
            <div className="w-full max-w-2xl bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col gap-4 shadow-2xl h-5/6">
              <div className="flex justify-between items-start border-b border-[#1c1d1e] pb-3">
                <div>
                  <h3 className="text-lg font-serif text-white tracking-tight">Eşleşme Detayları</h3>
                  <p className="text-xs text-slate-500 font-mono mt-0.5">Metin Eşleşme Kesiti</p>
                </div>
                <button
                  onClick={() => setPreviewFileText(null)}
                  className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-full border border-slate-800 hover:border-slate-700 bg-white/5 transition-all"
                >
                  Kapat
                </button>
              </div>

              <div
                className="flex-1 overflow-y-auto bg-[#040506] rounded-xl p-6 border border-[#1c1d1e] font-sans text-sm leading-relaxed text-slate-300 text-justify select-text select-all"
                dangerouslySetInnerHTML={{ __html: previewFileText }}
              />
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/* METADATA EDIT OVERLAY MODAL                                   */}
        {/* ============================================================= */}
        {editingMetadataResult && (
          <div className="fixed inset-0 bg-black/65 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in p-6">
            <div className="w-full max-w-xl bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col gap-4 shadow-2xl max-h-[90%] overflow-y-auto">
              <div className="flex justify-between items-start border-b border-[#1c1d1e] pb-3">
                <div>
                  <h3 className="text-lg font-serif text-white tracking-tight font-semibold">Evrak Metadatasını Düzenle</h3>
                  <p className="text-xs text-slate-500 font-mono mt-0.5 truncate max-w-md">{editingMetadataResult.filename}</p>
                </div>
                <button
                  onClick={() => setEditingMetadataResult(null)}
                  className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-full border border-slate-800 hover:border-slate-700 bg-white/5 transition-all"
                >
                  İptal
                </button>
              </div>

              <div className="flex flex-col gap-3.5 text-xs">
                <div className="grid grid-cols-2 gap-3.5">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-slate-400">Esas / Karar No</label>
                    <input
                      type="text"
                      value={editCaseNumber}
                      onChange={(e) => setEditCaseNumber(e.target.value)}
                      placeholder="Örn: 2024/105"
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-slate-400">Belge / Karar Türü</label>
                    <input
                      type="text"
                      value={editDocumentType}
                      onChange={(e) => setEditDocumentType(e.target.value)}
                      placeholder="Örn: Gerekçeli Karar"
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-400">Mahkeme Adı</label>
                  <input
                    type="text"
                    value={editCourtName}
                    onChange={(e) => setEditCourtName(e.target.value)}
                    placeholder="Örn: Ankara 2. Asliye Hukuk Mahkemesi"
                    className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3.5">
                  <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-slate-400">Davacı / Müşteki</label>
                    <input
                      type="text"
                      value={editPlaintiff}
                      onChange={(e) => setEditPlaintiff(e.target.value)}
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-slate-400">Davalı / Sanık</label>
                    <input
                      type="text"
                      value={editDefendant}
                      onChange={(e) => setEditDefendant(e.target.value)}
                      className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-400">Özet</label>
                  <textarea
                    value={editSummary}
                    onChange={(e) => setEditSummary(e.target.value)}
                    rows={4}
                    placeholder="Evrakın kısa özeti..."
                    className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252] resize-none leading-relaxed"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-semibold text-slate-400">Etiketler (Virgülle ayırın)</label>
                  <input
                    type="text"
                    value={editTags}
                    onChange={(e) => setEditTags(e.target.value)}
                    placeholder="Örn: kira, tahliye, asliye hukuk"
                    className="bg-[#141517] border border-[#1c1d1e] rounded-xl px-3 py-2 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#f05252]"
                  />
                </div>

                <button
                  onClick={saveMetadata}
                  className="mt-2 w-full py-2.5 rounded-xl btn-glow-accent font-semibold text-white"
                >
                  Metadataları Kaydet
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================= */}
        {/* MODEL DOWNLOAD OVERLAY PROGRESS MODAL                          */}
        {/* ============================================================= */}
        {modelStatus && modelStatus.status === 'downloading' && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in p-6">
            <div className="w-full max-w-md bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col gap-4 shadow-2xl text-center">
              <h3 className="text-lg font-serif text-white tracking-tight">Anlamsal Arama Modeli İndiriliyor</h3>
              <p className="text-xs text-slate-500 font-mono leading-relaxed">
                Yerel anlamsal arama modeli ilk kullanım için indiriliyor. Bu işlem bağlantı hızınıza bağlı olarak birkaç dakika sürebilir (~45MB).
              </p>
              <div className="flex flex-col gap-2 mt-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400 font-mono truncate max-w-[70%]">{modelStatus.file}</span>
                  <span className="font-mono text-white font-bold">{modelStatus.progress}%</span>
                </div>
                <div className="w-full bg-[#141517] rounded-full h-2 overflow-hidden">
                  <div className="bg-[#f05252] h-full transition-all duration-300 animate-pulse" style={{ width: `${modelStatus.progress}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* LLM model download progress modal */}
        {llmModelStatus && llmModelStatus.status === 'downloading' && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50 animate-fade-in p-6">
            <div className="w-full max-w-md bg-[#0a0a0b] border border-[#1c1d1e] rounded-2xl p-6 flex flex-col gap-4 shadow-2xl text-center">
              <h3 className="text-lg font-serif text-white tracking-tight">AI Dil Modeli İndiriliyor</h3>
              <p className="text-xs text-slate-500 font-mono leading-relaxed">
                Metadata ve özet üretimi için yerel AI modeli indiriliyor (~500MB).
                Bu işlem bağlantı hızınıza bağlı olarak birkaç dakika sürebilir.
              </p>
              <div className="flex flex-col gap-2 mt-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-400 font-mono truncate max-w-[70%]">{llmModelStatus.file}</span>
                  <span className="font-mono text-white font-bold">{llmModelStatus.progress}%</span>
                </div>
                <div className="w-full bg-[#141517] rounded-full h-2 overflow-hidden">
                  <div className="bg-violet-500 h-full transition-all duration-300 animate-pulse" style={{ width: `${llmModelStatus.progress}%` }}></div>
                </div>
              </div>
            </div>
          </div>
        )}

      </main>

    </div>
  );
}
