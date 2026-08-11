/* Sr. Popo — settings-modal. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderPlugins } from './autonomous.js';
import { editorById, editors, loadDesktop, syncDesktopLabels } from './desktop.js';
import { renderCustomModels } from './models.js';
import { renderRemoteAccess } from './remote.js';
import { resourceMonitorOn } from './resources.js';
import { notificationsOn, updateNotifNote } from './settings.js';
import { soundsOn } from './sounds.js';
import { currentLayout, currentTheme } from './theme.js';
import { loadUsage, usageRepoOptionsHtml } from './usage.js';


// ---------- settings modal ----------
function showSettingsSection(name) {
  for (const item of document.querySelectorAll('.settings-nav-item')) {
    item.classList.toggle('active', item.dataset.section === name);
  }
  for (const sec of document.querySelectorAll('.settings-section')) {
    sec.classList.toggle('hidden', sec.dataset.section !== name);
  }
  if (name === 'usage') {
    const select = $('#usage-repo-filter');
    const prev = select.value;
    select.innerHTML = usageRepoOptionsHtml();
    select.value = state.repos.some((r) => r.id === prev) ? prev : '';
    loadUsage();
  }
}

// The per-session memory budget + MCP isolation controls. "Auto" is labeled
// with what it actually works out to on this machine (the server derives it
// from total RAM and the parallel-session cap), so the choice is legible.
function renderSessionMemorySetting() {
  const auto = state.settings.sessionMemoryAutoMb;
  const autoOption = $('#setting-session-memory').querySelector('option[value="auto"]');
  autoOption.textContent = auto ? `Auto (${(auto / 1024).toFixed(auto % 1024 ? 1 : 0)} GB per session)` : 'Auto';
  const value = state.settings.sessionMemoryMb;
  $('#setting-session-memory').value = value === undefined || value === 'auto' ? 'auto' : String(value);
  $('#setting-isolate-mcp').checked = state.settings.isolateMcpServers !== false;
}

// `section` may be a string ('general' | 'plugins') or a DOM event (from the
// header button); anything non-string falls back to the General section.
function openSettingsModal(section) {
  $('#setting-notifications').checked = notificationsOn();
  $('#setting-sounds').checked = soundsOn();
  updateNotifNote();
  $('#setting-max-parallel').value = state.settings.maxParallelSessions || 3;
  $('#setting-merge-strategy').value = state.settings.mergeStrategy || 'merge';
  $('#setting-min-merge-grade').value = String(state.settings.minMergeGrade || 4);
  $('#setting-auto-resolve-conflicts').checked = !!state.settings.autoResolveConflicts;
  $('#setting-assign-pr-to-self').checked = !!state.settings.assignPrToSelf;
  $('#setting-memory').checked = !!state.settings.memory;
  $('#setting-resource-monitor').checked = resourceMonitorOn();
  renderSessionMemorySetting();
  $('#setting-theme').value = currentTheme();
  $('#setting-layout').value = currentLayout();
  renderEditorSetting();
  renderPlugins();
  renderCustomModels();
  renderRemoteAccess();
  showSettingsSection(typeof section === 'string' ? section : 'general');
  $('#modal-settings').classList.remove('hidden');
}

async function saveSettings(patch) {
  try {
    state.settings = await api('PATCH', '/api/settings', patch);
  } catch (e) { toast(e.message); }
}

// ---------- default IDE (Settings → General → External tools) ----------
// The <select> lists every editor Sr. Popo knows how to launch; the ones it
// can't find on this machine stay selectable but are marked, so choosing one
// (e.g. before installing its launcher) is possible without being a trap.
function renderEditorSetting() {
  const sel = $('#setting-default-editor');
  if (!sel) return;
  const current = state.settings.defaultEditor || '';
  const options = editors().map((e) => `<option value="${esc(e.id)}"${e.available ? '' : ' data-missing="1"'}>${esc(e.label)}${e.available ? '' : ' — not found'}</option>`).join('');
  sel.innerHTML = `<option value="">Ask me each time</option>${options}`;
  // A default naming an editor this machine doesn't have would silently fail on
  // click; keep it selected anyway (it may be a shared db.json / a pending
  // install) — the note below spells out why nothing happens.
  if (current && !editors().some((e) => e.id === current)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(current)}">${esc(current)} — unknown</option>`);
  }
  sel.value = current;
  // Warn when the chosen editor isn't installed here — otherwise clicking
  // "Open in IDE" would just toast an error with no hint of why. The note goes
  // after the <label>, not inside it (a <p> isn't valid label content).
  $('#setting-editor-missing')?.remove();
  const chosen = editorById(current);
  if (chosen && !chosen.available) {
    sel.closest('label').insertAdjacentHTML('afterend',
      `<p class="addon-hint warn" id="setting-editor-missing">${icon('triangle-alert')} <span>${esc(chosen.label)} isn't on this machine yet. ${esc(chosen.hint)}</span></p>`);
  }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#setting-default-editor').addEventListener('change', async (e) => {
    await saveSettings({ defaultEditor: e.target.value });
    syncDesktopLabels();
    renderEditorSetting();
  });
  $('#setting-editor-rescan').addEventListener('click', async () => {
    await loadDesktop(true);
    const found = editors().filter((x) => x.available).length;
    toast(found ? `Found ${found} editor${found === 1 ? '' : 's'}` : 'No supported editor found', 'info');
  });
}


export { openSettingsModal, renderEditorSetting, renderSessionMemorySetting, saveSettings, showSettingsSection };
