'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe bridge. The UI talks to the embedded server over HTTP as before;
// this just lets it discover it's running inside Sr. Popo (and the base URL).
contextBridge.exposeInMainWorld('srpopo', {
  isElectron: true,
  getUrl: () => ipcRenderer.invoke('srpopo:get-url'),
  pickFolder: () => ipcRenderer.invoke('srpopo:pick-folder'),
});

// Electron-only presentation tweaks — untouched when the UI runs in a browser.
// 1) shift the top bar clear of the mac traffic lights (hiddenInset title bar)
// 2) make the top bar a draggable window region; keep controls clickable.
function applyElectronChrome() {
  document.documentElement.classList.add('is-electron');
  const style = document.createElement('style');
  style.textContent = `
    .is-electron .topbar {
      -webkit-app-region: drag;
      padding-left: 88px;
    }
    .is-electron .topbar button,
    .is-electron .topbar .health-chip,
    .is-electron .topbar input,
    .is-electron .topbar a {
      -webkit-app-region: no-drag;
    }
  `;
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', applyElectronChrome);
} else {
  applyElectronChrome();
}
