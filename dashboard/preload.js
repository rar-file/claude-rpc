const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig:    () => ipcRenderer.invoke('load-config'),
  // base = settings as shown before any edits, edited = after; main writes only the difference.
  saveConfig:    (base, edited) => ipcRenderer.invoke('save-config', { base, edited }),
  daemonStatus:  () => ipcRenderer.invoke('daemon-status'),
  runSetup:      () => ipcRenderer.invoke('run-setup'),
  onSetupResult: (handler) => ipcRenderer.on('setup-result', (_, payload) => handler(payload)),
  daemonStart:   () => ipcRenderer.invoke('daemon-start'),
  daemonStop:    () => ipcRenderer.invoke('daemon-stop'),
  daemonRestart: () => ipcRenderer.invoke('daemon-restart'),
  tailLog:       () => ipcRenderer.invoke('tail-log'),
  listVars:      () => ipcRenderer.invoke('list-vars'),
  startServe:    () => ipcRenderer.invoke('start-serve'),
  exportData:    (format) => ipcRenderer.invoke('export-data', format),
  listWorkspaces: () => ipcRenderer.invoke('list-workspaces'),
  setWorkspaceVisibility: (cwd, level) => ipcRenderer.invoke('set-workspace-visibility', { cwd, level }),
  getRpcPort:    () => ipcRenderer.invoke('get-rpc-port'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),
});
