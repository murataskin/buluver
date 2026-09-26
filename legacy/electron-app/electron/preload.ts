import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  search: (query: string, mode?: string) => ipcRenderer.invoke('search', query, mode),
  getFolders: () => ipcRenderer.invoke('get-folders'),
  addFolder: (path: string) => ipcRenderer.invoke('add-folder', path),
  removeFolder: (path: string) => ipcRenderer.invoke('remove-folder', path),
  getStatus: () => ipcRenderer.invoke('get-status'),
  scanFolders: () => ipcRenderer.invoke('scan-folders'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  updateMetadata: (filePath: string, metadata: any) => ipcRenderer.invoke('update-metadata', filePath, metadata),
  getActiveModel: () => ipcRenderer.invoke('get-active-model'),
  setActiveModel: (modelName: string) => ipcRenderer.invoke('set-active-model', modelName),
  installModel: () => ipcRenderer.invoke('install-model'),
  getFilesDetail: () => ipcRenderer.invoke('get-files-detail'),
  // LLM (metadata / summary) provider settings
  getLlmSettings: () => ipcRenderer.invoke('get-llm-settings'),
  setLlmSettings: (settings: any) => ipcRenderer.invoke('set-llm-settings', settings),
  testLlmConnection: () => ipcRenderer.invoke('test-llm-connection'),
  enrichMetadata: () => ipcRenderer.invoke('enrich-metadata'),
  onStatusChange: (callback: (status: any) => void) => {
    const subscription = (_event: any, value: any) => callback(value);
    ipcRenderer.on('status-change', subscription);
    return () => {
      ipcRenderer.removeListener('status-change', subscription);
    };
  },
  onEmbeddingProgress: (callback: (progress: any) => void) => {
    const subscription = (_event: any, value: any) => callback(value);
    ipcRenderer.on('embedding-model-progress', subscription);
    return () => {
      ipcRenderer.removeListener('embedding-model-progress', subscription);
    };
  },
  onLlmProgress: (callback: (progress: any) => void) => {
    const subscription = (_event: any, value: any) => callback(value);
    ipcRenderer.on('llm-model-progress', subscription);
    return () => {
      ipcRenderer.removeListener('llm-model-progress', subscription);
    };
  },
});
