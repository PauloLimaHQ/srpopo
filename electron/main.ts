import path from 'path';
import { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';

import { appRoot } from '../server/paths';
import { resolveClaudeEnv } from './resolve-env';

// Pin the name so dev and packaged builds resolve the SAME userData folder
// (~/Library/Application Support/Sr. Popo) instead of splitting on package name.
app.setName('Sr. Popo');

// Repair PATH (and pin CLAUDE_BIN) BEFORE requiring the server: a Finder/Dock-
// launched app doesn't inherit the shell PATH, so `claude` would otherwise be
// unresolvable. runner.ts reads CLAUDE_BIN at import time, so this must run first.
resolveClaudeEnv();

// Persist Sr. Popo's data (db.json + logs) in a writable per-user location.
// The server module reads this before it touches the filesystem — so require it
// (in place) only AFTER the env var is set, rather than importing it at the top
// where the binding would hoist above this assignment.
process.env.SRPOPO_DATA_DIR = path.join(app.getPath('userData'), 'data');

const server = require('../server/index') as typeof import('../server/index');
const store = require('../server/store') as typeof import('../server/store'); // read live task state for the tray
const bus = require('../server/bus') as typeof import('../server/bus'); // task/log events → refresh the tray menu

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let httpUrl = '';
let isQuitting = false;
let updateReadyVersion: string | null = null; // set once electron-updater has a downloaded update waiting

// Single-instance: focus the existing window instead of spawning a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Sr. Popo',
    backgroundColor: '#1a1436',
    titleBarStyle: 'hiddenInset', // native mac traffic lights over the UI
    show: false,
    icon: path.join(appRoot(), 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(httpUrl);

  mainWindow.once('ready-to-show', () => mainWindow!.show());

  // Open external links (e.g. claude.com) in the default browser, not in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides to the tray instead of quitting (mac menu-bar app feel).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow!.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'darwin') app.dock?.show();
}

// Forward a menu click to the renderer, which owns the actual modals/behavior.
// Ensures a window exists and has finished its first load before delivering it,
// mirroring openTask()'s "wait for the page" handling below.
function sendMenuAction(action: string): void {
  showWindow();
  if (!mainWindow) return;
  const send = () => mainWindow!.webContents.send('srpopo:menu-action', action);
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

// Native macOS menu bar. Everything that isn't a plain OS role (About, Hide,
// clipboard roles, zoom, …) is delegated to the renderer via sendMenuAction so
// there's a single source of truth for opening each modal.
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => sendMenuAction('settings'),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Task…',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-task'),
        },
        {
          label: 'Brief an Idea…',
          accelerator: 'Shift+CmdOrCtrl+N',
          click: () => sendMenuAction('brief-idea'),
        },
        { type: 'separator' },
        {
          label: 'Manage Repositories…',
          accelerator: 'Shift+CmdOrCtrl+O',
          click: () => sendMenuAction('repos'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendMenuAction('palette'),
        },
        {
          label: 'Find Tasks',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendMenuAction('find'),
        },
        {
          label: 'Toggle Theme',
          click: () => sendMenuAction('toggle-theme'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', role: 'windowMenu' },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        {
          label: 'Sr. Popo Documentation',
          click: () => shell.openExternal('https://github.com/PauloLimaHQ/srpopo#readme'),
        },
        {
          label: 'Report an Issue…',
          click: () => shell.openExternal('https://github.com/PauloLimaHQ/srpopo/issues'),
        },
        { type: 'separator' },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => sendMenuAction('shortcuts'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Show the board and jump straight to a task's drawer via the #task/<id> deep
// link the renderer understands. Waits for the page if it's still loading.
function openTask(taskId: string): void {
  showWindow();
  if (!mainWindow) return;
  const go = () =>
    mainWindow!.webContents
      .executeJavaScript(
        `location.hash = ${JSON.stringify('#task/' + taskId)};` +
          `window.dispatchEvent(new HashChangeEvent('hashchange'));`
      )
      .catch(() => {}); // renderer may not be ready; the retry below covers it
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', go);
  } else {
    go();
  }
}

// Human-friendly elapsed time since an ISO timestamp, e.g. "3m 20s".
function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function runningTasks() {
  return store.db.tasks.filter((t) => t.status === 'running' && !t.archived);
}

// ── desktop notifications ──
// A task (or grooming card) is "live" while its claude child process runs; when
// it leaves that state the run has just finished. We remember each record's
// last-seen status so we can fire a native notification on that transition only.
const lastStatus = new Map<string, string>(); // task/grooming id -> last status seen on the bus

function notificationsEnabled(): boolean {
  return !store.db.settings || store.db.settings.notifications !== false;
}

// Fire a native notification when a task finishes. Only on a running→finished
// transition, and never for a user-initiated stop (they already know).
function maybeNotify(task: import('../server/types').Task): void {
  const prev = lastStatus.get(task.id);
  lastStatus.set(task.id, task.status);
  if (prev !== 'running' || task.status === 'running') return;
  if (task.lastOutcome === 'stopped') return;
  if (!notificationsEnabled() || !Notification.isSupported()) return;

  let title: string, body: string;
  if (task.status === 'failed') {
    title = `❌ Task failed — ${task.title}`;
    body = task.lastError ? String(task.lastError).slice(0, 140) : task.repoName;
  } else {
    title = `✅ Task finished — ${task.title}`;
    const bits = [task.repoName];
    if (task.costUsd > 0) bits.push(`$${task.costUsd.toFixed(2)}`);
    if (task.numTurns != null) bits.push(`${task.numTurns} turns`);
    body = bits.join(' · ');
  }

  const note = new Notification({ title, body, silent: false });
  note.on('click', () => openTask(task.id)); // jump straight to the task
  note.show();
}

// Same transition watch for grooming cards: notify when one finishes or fails.
function maybeNotifyGrooming(grooming: import('../server/types').Grooming): void {
  const prev = lastStatus.get(grooming.id);
  lastStatus.set(grooming.id, grooming.status);
  if (prev !== 'running' || grooming.status === 'running') return;
  if (grooming.lastOutcome === 'stopped') return;
  if (!notificationsEnabled() || !Notification.isSupported()) return;

  let title: string, body: string;
  if (grooming.status === 'failed') {
    title = `❌ Grooming failed — ${grooming.title}`;
    body = grooming.lastError ? String(grooming.lastError).slice(0, 140) : grooming.repoName;
  } else {
    const n = (grooming.taskIds || []).length;
    title = `✨ Idea groomed — ${grooming.title}`;
    body = `${grooming.repoName} · ${n} task${n === 1 ? '' : 's'} created`;
  }

  const note = new Notification({ title, body, silent: false });
  note.on('click', () => showWindow());
  note.show();
}

// Rebuild the tray context menu from the current set of running tasks so the
// list (and each task's elapsed time) stays live in the menu bar.
function refreshTray(): void {
  if (!tray) return;
  const running = runningTasks();

  const items: Electron.MenuItemConstructorOptions[] = [];
  if (updateReadyVersion) {
    items.push({
      label: `Restart to Update (v${updateReadyVersion})`,
      click: () => autoUpdater.quitAndInstall(),
    });
    items.push({ type: 'separator' });
  }
  if (running.length) {
    items.push({ label: `Running (${running.length})`, enabled: false });
    for (const t of running) {
      const bits = [t.repoName, formatElapsed(t.startedAt)];
      if (t.activeSubagents > 0) {
        bits.push(`${t.activeSubagents} subagent${t.activeSubagents > 1 ? 's' : ''}`);
      }
      items.push({
        label: `  ${t.title}  —  ${bits.filter(Boolean).join(' · ')}`,
        click: () => openTask(t.id),
      });
    }
  } else {
    items.push({ label: 'No tasks running', enabled: false });
  }

  const menu = Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: 'Open Sr. Popo', click: () => showWindow() },
    {
      label: 'Open in Browser',
      click: () => httpUrl && shell.openExternal(httpUrl),
    },
    { type: 'separator' },
    {
      label: 'Quit Sr. Popo',
      accelerator: 'Command+Q',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  tray.setToolTip(
    running.length
      ? `Sr. Popo — ${running.length} task${running.length > 1 ? 's' : ''} running`
      : 'Sr. Popo'
  );
  // Mirror the count on the mac dock icon.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(running.length ? String(running.length) : '');
  }
}

function createTray(): void {
  // Monochrome menu-bar glyph. It's a macOS *template* image: a single-color
  // silhouette that macOS recolors to match the menu bar (light/dark/selected),
  // the way ChatGPT, Docker, and Dropbox render theirs. (@2x is picked up
  // automatically on retina — the size actually shown on modern Macs.)
  const trayIcon = nativeImage.createFromPath(
    path.join(appRoot(), 'assets', 'tray.png')
  );
  trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);
  refreshTray();

  // Rebuild on task lifecycle changes (log spam is ignored so we don't thrash),
  // and surface a desktop notification when a run finishes.
  bus.subscribe((msg: any) => {
    if (!msg) return;
    if (msg.type === 'task') {
      maybeNotify(msg.task);
      refreshTray();
    } else if (msg.type === 'grooming') {
      maybeNotifyGrooming(msg.grooming);
    } else if (msg.type === 'task-removed') {
      refreshTray();
    }
  });

  // Keep elapsed times ticking, but only while something is actually running.
  setInterval(() => {
    if (runningTasks().length) refreshTray();
  }, 1000);

  // Click the tray icon to toggle the window.
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    } else {
      showWindow();
    }
  });
}

app.whenReady().then(async () => {
  // Native "About Sr. Popo" panel (Sr. Popo ▸ About Sr. Popo) — otherwise macOS
  // shows a generic Electron entry with no icon or version.
  app.setAboutPanelOptions({
    applicationName: 'Sr. Popo',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: 'Copyright © 2026 Paulo Lima',
    credits: 'Local orchestrator hub for Claude Code — runs entirely on your machine, on your Claude subscription login.',
    iconPath: path.join(appRoot(), 'build', 'icon.png'),
  });
  buildAppMenu();

  try {
    const started = await server.start(isDev ? 7777 : 0); // fixed port in dev, free port when packaged
    httpUrl = started.url;
  } catch (_e) {
    // Fall back to an OS-assigned port if the preferred one is taken.
    const started = await server.start(0);
    httpUrl = started.url;
  }

  createTray();
  createWindow();

  // Auto-update: only against a real packaged build — dev has no update feed
  // and would just throw/log noise every time `npm start` runs.
  if (app.isPackaged) {
    autoUpdater.on('update-downloaded', (info) => {
      updateReadyVersion = info.version;
      if (mainWindow) mainWindow.webContents.send('srpopo:update-ready', info.version);
      refreshTray();
    });
    autoUpdater.on('error', (err) => {
      console.error('[autoUpdater]', err);
    });

    autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdater]', err));
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => console.error('[autoUpdater]', err));
    }, 4 * 60 * 60 * 1000); // re-check every 4 hours
  }

  app.on('activate', () => showWindow()); // dock icon click on mac
});

// Keep running in the tray when all windows are closed (don't quit on mac).
app.on('window-all-closed', () => {
  // no-op: Sr. Popo lives in the menu bar
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    server.runner.stopAll(); // terminate any live claude processes
    server.terminal.closeAll(); // kill any in-app shell sessions
  } catch (_) { /* nothing to stop */ }
});

// Let the renderer ask the main process for its own base URL if it ever needs it.
ipcMain.handle('srpopo:get-url', () => httpUrl);

// The renderer's "Relaunch to update" banner button — restarts into the
// already-downloaded update. Only ever reachable once update-downloaded fired.
ipcMain.handle('srpopo:restart-to-update', () => autoUpdater.quitAndInstall());

// Open the native folder picker so the user can select a repo instead of
// typing an absolute path. Returns the chosen path, or null if cancelled.
ipcMain.handle('srpopo:pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow!, {
    title: 'Select a repository folder',
    buttonLabel: 'Add Repository',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});
