import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Tray } from 'electron';
import * as path from 'path';
import { DatabaseService } from './services/database';
import { IndexerService } from './services/indexer';
import { McpServerService } from './services/mcp';

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
    { label: 'TBB-İzBul Aç', click: () => mainWindow?.show() },
    { label: 'Hızlı Arama (F3)', click: () => toggleSearchWindow() },
    { type: 'separator' },
    { label: 'Çıkış', click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('TBB-İzBul');
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

  // Run initial scan in the background
  IndexerService.scanAllRegisteredFolders().catch(console.error);

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

ipcMain.handle('search', async (_, query: string) => {
  try {
    return DatabaseService.searchContent(query);
  } catch (err) {
    console.error('IPC search failed:', err);
    return [];
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
