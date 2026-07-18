import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  search: (query: string) => ipcRenderer.invoke('search', query),
  getFolders: () => ipcRenderer.invoke('get-folders'),
  addFolder: (path: string) => ipcRenderer.invoke('add-folder', path),
  removeFolder: (path: string) => ipcRenderer.invoke('remove-folder', path),
  getStatus: () => ipcRenderer.invoke('get-status'),
  scanFolders: () => ipcRenderer.invoke('scan-folders'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  onStatusChange: (callback: (status: any) => void) => {
    const subscription = (_event: any, value: any) => callback(value);
    ipcRenderer.on('status-change', subscription);
    return () => {
      ipcRenderer.removeListener('status-change', subscription);
    };
  }
});
