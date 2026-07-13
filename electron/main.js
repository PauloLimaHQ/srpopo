'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } = require('electron');

// Pin the name so dev and packaged builds resolve the SAME userData folder
// (~/Library/Application Support/Sr. Popo) instead of splitting on package name.
app.setName('Sr. Popo');

// Persist Sr. Popo's data (db.json + logs) in a writable per-user location.
// The server module reads this before it touches the filesystem.
process.env.SRPOPO_DATA_DIR = path.join(app.getPath('userData'), 'data');

const server = require('../server/index');
const store = require('../server/store'); // read live task state for the tray
const bus = require('../server/bus'); // task/log events → refresh the tray menu

const isDev = !app.isPackaged;

let mainWindow = null;
let tray = null;
let httpUrl = null;
let isQuitting = false;

// Single-instance: focus the existing window instead of spawning a second app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'Sr. Popo',
    backgroundColor: '#1a1436',
    titleBarStyle: 'hiddenInset', // native mac traffic lights over the UI
    show: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(httpUrl);

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  if (process.platform === 'darwin') app.dock.show();
}

// Show the board and jump straight to a task's drawer via the #task/<id> deep
// link the renderer understands. Waits for the page if it's still loading.
function openTask(taskId) {
  showWindow();
  if (!mainWindow) return;
  const go = () =>
    mainWindow.webContents
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
function formatElapsed(startedAt) {
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

// Rebuild the tray context menu from the current set of running tasks so the
// list (and each task's elapsed time) stays live in the menu bar.
function refreshTray() {
  if (!tray) return;
  const running = runningTasks();

  const items = [];
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

function createTray() {
  // Full-color Sr. Popo logo in the menu bar (@2x is picked up automatically on
  // retina). Not a template image, so the brand colors show through as-is.
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, '..', 'assets', 'tray.png')
  );

  tray = new Tray(trayIcon);
  refreshTray();

  // Rebuild on task lifecycle changes (log spam is ignored so we don't thrash).
  bus.subscribe((msg) => {
    if (msg && (msg.type === 'task' || msg.type === 'task-removed')) refreshTray();
  });

  // Keep elapsed times ticking, but only while something is actually running.
  setInterval(() => {
    if (runningTasks().length) refreshTray();
  }, 1000);

  // Click the tray icon to toggle the window.
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock.hide();
    } else {
      showWindow();
    }
  });
}

app.whenReady().then(async () => {
  try {
    const started = await server.start(isDev ? 7777 : 0); // fixed port in dev, free port when packaged
    httpUrl = started.url;
  } catch (e) {
    // Fall back to an OS-assigned port if the preferred one is taken.
    const started = await server.start(0);
    httpUrl = started.url;
  }

  createTray();
  createWindow();

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
  } catch (_) {}
});

// Let the renderer ask the main process for its own base URL if it ever needs it.
ipcMain.handle('srpopo:get-url', () => httpUrl);

// Open the native folder picker so the user can select a repo instead of
// typing an absolute path. Returns the chosen path, or null if cancelled.
ipcMain.handle('srpopo:pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a repository folder',
    buttonLabel: 'Add Repository',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});
