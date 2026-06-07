const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig:    () => ipcRenderer.invoke('load-config'),
  saveConfig:    (cfg) => ipcRenderer.invoke('save-config', cfg),
  pickConfig:    () => ipcRenderer.invoke('pick-config'),
  daemonStatus:  () => ipcRenderer.invoke('daemon-status'),
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
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateEvent:   (handler) => {
    const wrap = (channel) => (_, payload) => handler({ channel, ...payload });
    ipcRenderer.on('update-available',  wrap('available'));
    ipcRenderer.on('update-progress',   wrap('progress'));
    ipcRenderer.on('update-downloaded', wrap('downloaded'));
  },
});
