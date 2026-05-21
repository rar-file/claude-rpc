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
  openExternal:  (url) => ipcRenderer.invoke('open-external', url),
});
