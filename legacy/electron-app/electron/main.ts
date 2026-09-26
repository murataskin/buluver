// Prevent crashes when stdout/stderr are closed or detached (e.g. write EIO, EPIPE)
if (process.stdout) {
  process.stdout.on('error', (err: any) => {
    if (err.code === 'EIO' || err.code === 'EPIPE') {
      // Ignore console write errors on closed pipes
    }
  });
}
if (process.stderr) {
  process.stderr.on('error', (err: any) => {
    if (err.code === 'EIO' || err.code === 'EPIPE') {
      // Ignore console write errors on closed pipes
    }
  });
}
process.on('uncaughtException', (err: any) => {
  if (err.code === 'EIO' || err.code === 'EPIPE') {
    return; // Ignore broken pipes/EIO crashes from console logging
  }
  console.error('Unhandled Exception:', err);
});

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray } from 'electron';
import * as path from 'node:path';
import { DatabaseService } from './services/database';
import { IndexerService } from './services/indexer';
import { McpServerService } from './services/mcp';
import { generateEmbedding } from './services/embeddings';
import { getLLMSettings, saveLLMSettings, testLLMConnection } from './services/llm';

let mainWindow: BrowserWindow | null = null;
let searchWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('close', (e) => {
    // If not exiting the app, just hide the window to run in tray
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSearchWindow() {
  searchWindow = new BrowserWindow({
    width: 750,
    height: 480,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    searchWindow.loadURL('http://localhost:5173#/search');
  } else {
    searchWindow.loadFile(path.join(__dirname, '../dist/index.html'), { hash: 'search' });
  }

  searchWindow.on('blur', () => {
    searchWindow?.hide();
  });
}

function toggleSearchWindow() {
  if (!searchWindow) {
    createSearchWindow();
  }

  if (searchWindow?.isVisible()) {
    searchWindow.hide();
  } else {
    searchWindow?.show();
    searchWindow?.focus();
  }
}

function createTray() {
  // Use a placeholder icon or system default template icon
  tray = new Tray(path.join(__dirname, '../../resources/tray-icon.png'));

  const contextMenu = Menu.buildFromTemplate([
    { label: 'İzBul Aç', click: () => mainWindow?.show() },
    { label: 'Hızlı Arama (F3)', click: () => toggleSearchWindow() },
    { type: 'separator' },
    {
      label: 'Çıkış', click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('İzBul');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
  });
}

app.whenReady().then(() => {
  createMainWindow();
  createSearchWindow();

  // Set up Indexer real-time progress broadcast callback
  IndexerService.setProgressCallback((status) => {
    mainWindow?.webContents.send('status-change', status);
    searchWindow?.webContents.send('status-change', status);
  });

  // Start watches on configured folders
  IndexerService.startWatchingAll();

  // Run initial scan in the background, then backfill AI metadata for any files missing summaries
  IndexerService.scanAllRegisteredFolders()
    .then(() => IndexerService.enrichMissingMetadata())
    .catch(console.error);

  // Start embedded FastMCP server
  McpServerService.start(3012).catch(console.error);

  try {
    createTray();
  } catch (err) {
    console.error('Tray creation failed, continuing without tray:', err);
  }

  // Register Global F3 Shortcut
  globalShortcut.register('F3', () => {
    toggleSearchWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('will-quit', () => {
  // Stop all watches and MCP server before quitting
  IndexerService.stopWatchingAll();
  McpServerService.stop().catch(console.error);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// =============================================================
// IPC HANDLERS DEFINITION
// =============================================================

ipcMain.handle('search', async (_, query: string, mode: 'keyword' | 'semantic' | 'hybrid' = 'hybrid') => {
  try {
    let queryEmbedding: Float32Array | undefined;
    if (mode === 'semantic' || mode === 'hybrid') {
      try {
        queryEmbedding = await generateEmbedding(query);
      } catch (err) {
        console.error('Failed to generate embedding for search query:', err);
      }
    }
    return DatabaseService.search(query, mode, queryEmbedding);
  } catch (err) {
    console.error('IPC search failed:', err);
    return [];
  }
});

ipcMain.handle('update-metadata', async (_, filePath: string, metadata: any) => {
  try {
    const file = DatabaseService.getFile(filePath);
    if (!file || file.id === undefined) {
      throw new Error(`Dosya bulunamadı veya ID'si eksik: ${filePath}`);
    }
    DatabaseService.upsertFileMetadata(file.id, metadata);
    return true;
  } catch (err) {
    console.error('IPC update-metadata failed:', err);
    return false;
  }
});

ipcMain.handle('get-folders', async () => {
  try {
    return DatabaseService.getFolders().map(f => f.path);
  } catch (err) {
    console.error('IPC get-folders failed:', err);
    return [];
  }
});

ipcMain.handle('add-folder', async (_, folderPath: string) => {
  try {
    DatabaseService.addFolder(folderPath);
    IndexerService.startWatchingFolder(folderPath);
    // Trigger scanning in background
    IndexerService.scanAllRegisteredFolders().catch(console.error);
    return true;
  } catch (err) {
    console.error('IPC add-folder failed:', err);
    return false;
  }
});

ipcMain.handle('remove-folder', async (_, folderPath: string) => {
  try {
    IndexerService.stopWatchingFolder(folderPath);
    DatabaseService.removeFolder(folderPath);
    // Send status refresh
    IndexerService.emitStatus('Klasör kaldırıldı', 100);
    return true;
  } catch (err) {
    console.error('IPC remove-folder failed:', err);
    return false;
  }
});

ipcMain.handle('get-status', async () => {
  try {
    const folders = DatabaseService.getFolders().map(f => f.path);
    const files = DatabaseService.getAllFiles();
    return {
      isScanning: IndexerService.isCurrentlyIndexing(),
      progress: IndexerService.isCurrentlyIndexing() ? 50 : 0, // mock progress if scanning
      info: IndexerService.isCurrentlyIndexing() ? 'Dizinler taranıyor ve UDF verileri çözümleniyor...' : 'Hazır',
      folders,
      filesCount: files.length
    };
  } catch (err) {
    console.error('IPC get-status failed:', err);
    return {
      isScanning: false,
      progress: 0,
      info: 'Hata oluştu',
      folders: [],
      filesCount: 0
    };
  }
});

ipcMain.handle('scan-folders', async () => {
  try {
    IndexerService.scanAllRegisteredFolders().catch(console.error);
    return true;
  } catch (err) {
    console.error('IPC scan-folders failed:', err);
    return false;
  }
});

ipcMain.handle('select-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'İndekslenecek Klasörü Seçin'
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.error('IPC select-folder failed:', err);
    return null;
  }
});

ipcMain.handle('get-active-model', async () => {
  try {
    return DatabaseService.getSetting('active_model', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  } catch (err) {
    console.error('IPC get-active-model failed:', err);
    return 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  }
});

ipcMain.handle('set-active-model', async (_, modelName: string) => {
  try {
    DatabaseService.setSetting('active_model', modelName);
    const { reloadPipeline } = require('./services/embeddings');
    reloadPipeline();
    return true;
  } catch (err) {
    console.error('IPC set-active-model failed:', err);
    return false;
  }
});

ipcMain.handle('install-model', async () => {
  try {
    const { getEmbeddingPipeline } = require('./services/embeddings');
    // Trigger download & progress reporting in background
    getEmbeddingPipeline().catch((err: any) => {
      console.error('Background pipeline initialization failed:', err);
    });
    return true;
  } catch (err) {
    console.error('IPC install-model failed:', err);
    return false;
  }
});

ipcMain.handle('get-files-detail', async () => {
  try {
    return DatabaseService.getFilesDetail();
  } catch (err) {
    console.error('IPC get-files-detail failed:', err);
    return [];
  }
});

ipcMain.handle('get-active-llm-model', async () => {
  try {
    return DatabaseService.getSetting('active_llm_model', 'Xenova/LaMini-Flan-T5-248M');
  } catch (err) {
    console.error('IPC get-active-llm-model failed:', err);
    return 'Xenova/LaMini-Flan-T5-248M';
  }
});

ipcMain.handle('set-active-llm-model', async (_, modelName: string) => {
  try {
    DatabaseService.setSetting('active_llm_model', modelName);
    const { reloadLlmPipeline } = require('./services/llm');
    reloadLlmPipeline();
    return true;
  } catch (err) {
    console.error('IPC set-active-llm-model failed:', err);
    return false;
  }
});

ipcMain.handle('install-llm-model', async () => {
  // No-op for REST-based providers (Ollama/OpenAI/Gemini).
  // Model management is handled outside the app (e.g. `ollama pull <model>`).
  return true;
});

ipcMain.handle('get-llm-settings', async () => {
  try {
    return getLLMSettings();
  } catch (err) {
    console.error('IPC get-llm-settings failed:', err);
    return { provider: 'ollama', model: 'qwen2.5:7b', apiKey: '', baseUrl: 'http://localhost:11434' };
  }
});

ipcMain.handle('set-llm-settings', async (_, settings: any) => {
  try {
    saveLLMSettings(settings);
    return true;
  } catch (err) {
    console.error('IPC set-llm-settings failed:', err);
    return false;
  }
});

ipcMain.handle('test-llm-connection', async () => {
  try {
    return await testLLMConnection();
  } catch (err: any) {
    return { ok: false, message: err?.message ?? String(err) };
  }
});

ipcMain.handle('enrich-metadata', async () => {
  try {
    IndexerService.enrichMissingMetadata().catch(console.error);
    return true;
  } catch (err) {
    console.error('IPC enrich-metadata failed:', err);
    return false;
  }
});
