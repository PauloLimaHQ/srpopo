/* Sr. Popo — electron. No build step: native ES module. */
import { showUpdateBanner, showUpdateDownloading, showUpdateInstallFailed, toast } from '../core/api.js';
import { $, isElectron } from '../core/state.js';
import { openBriefModal } from './grooming.js';
import { openPalette } from './palette.js';
import { openReposModal } from './repos-modal.js';
import { openSettingsModal } from './settings-modal.js';
import { pluginInstalled } from './settings.js';
import { modalOpen, openShortcutsModal } from './shortcuts.js';
import { closeActiveTab, duplicateTab } from './tabs.js';
import { openTaskModal } from './task-modal.js';
import { cycleTheme } from './theme.js';


// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // ---------- native menu bar (Electron) ----------
  // The main process owns no UI — it just forwards menu clicks here so every
  // action reuses the same modal/open functions as the on-screen buttons.
  if (isElectron && window.srpopo.onMenuAction) {
    window.srpopo.onMenuAction((action) => {
      switch (action) {
        case 'new-task': if (!modalOpen()) openTaskModal(); break;
        case 'brief-idea':
          if (modalOpen()) break;
          if (pluginInstalled('grooming')) openBriefModal();
          else toast('Install the Idea Grooming plugin (Settings → Plugins) first', 'info');
          break;
        case 'repos': if (!modalOpen()) openReposModal(); break;
        case 'settings': if ($('#modal-settings').classList.contains('hidden')) openSettingsModal(); break;
        case 'palette': if (!modalOpen()) openPalette(); break;
        case 'shortcuts': if (!modalOpen()) openShortcutsModal(); break;
        case 'find': $('#filter-search').focus(); break;
        // Both also have a keyboard path of their own (⌘W / ⌘D, handled in
        // features/tabs.js) — this is the menu item being clicked.
        case 'close-tab': if (!modalOpen()) closeActiveTab(); break;
        case 'duplicate-tab': if (!modalOpen()) duplicateTab(); break;
        case 'toggle-theme': cycleTheme(); break;
      }
    });
  }

  // ---------- auto-update (Electron) ----------
  // The main process downloads updates in the background (electron-updater) and
  // tells us when the download starts and when it's ready — never auto-restart
  // without the user clicking Relaunch.
  if (isElectron && window.srpopo.onUpdateReady) {
    window.srpopo.onUpdateReady((version) => showUpdateBanner(version));
    window.srpopo.onUpdateDownloading?.((version) => showUpdateDownloading(version));
    window.srpopo.onUpdateInstallFailed?.((releasesUrl) => showUpdateInstallFailed(releasesUrl));
    // The check may have landed before this window loaded — ask for the state.
    window.srpopo.getUpdateStatus?.().then((s) => {
      if (!s) return;
      if (s.installFailed) showUpdateInstallFailed(s.installFailed);
      else if (s.ready) showUpdateBanner(s.ready);
      else if (s.downloading) showUpdateDownloading(s.downloading);
    }).catch(() => { /* older shell without the handler */ });
  }
}

