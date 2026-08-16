'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', Object.freeze({
  getStatus: () => ipcRenderer.invoke('license:status'),
  getHardwareId: () => ipcRenderer.invoke('license:hardware-id'),
  startTrial: () => ipcRenderer.invoke('license:start-trial'),
  activate: licenseKey => ipcRenderer.invoke('license:activate', licenseKey),
  importFile: () => ipcRenderer.invoke('license:import-file'),
  copyText: text => ipcRenderer.invoke('license:copy-text', text),
  readClipboard: () => ipcRenderer.invoke('license:read-clipboard'),
  exit: () => ipcRenderer.send('license:exit')
}));
