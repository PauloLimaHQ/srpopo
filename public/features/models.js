/* Sr. Popo — models. No build step: native ES module. */
import { esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { syncResourceMonitor } from './resources.js';
import { openSettingsModal, renderSessionMemorySetting, saveSettings, showSettingsSection } from './settings-modal.js';
import { ensureNotifyPermission, showBrowserNotification, updateNotifNote } from './settings.js';
import { playSound } from './sounds.js';


// ---------- custom models ----------
const customModels = () => state.settings.customModels || [];

// Rebuild the custom-model <option>s in every model picker (New Task, Brief,
// Linear import, and the workspace-settings defaults for both). The built-in
// options stay in the HTML; we only manage the ones we tag data-custom, and
// preserve the current selection across a rebuild.
function syncCustomModelOptions() {
  for (const sel of document.querySelectorAll('#task-model, #brief-model, #linear-model, #repo-settings-model, #repo-settings-groom-model')) {
    const keep = sel.value;
    for (const opt of [...sel.querySelectorAll('option[data-custom]')]) opt.remove();
    for (const m of customModels()) {
      const opt = document.createElement('option');
      opt.value = m.model;
      opt.textContent = m.label;
      opt.dataset.custom = '1';
      sel.appendChild(opt);
    }
    // Keep the selection if it still exists; otherwise the browser falls back
    // to the first option (Account default), which is the right thing.
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }
}

// Parse the add-model env textarea (one KEY=value per line) into an object.
// Blank lines and #comments are skipped; ANTHROPIC_API_KEY is refused here too
// (the server strips it as well) so the subscription-only invariant holds.
function parseEnvLines(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || key === 'ANTHROPIC_API_KEY') continue;
    env[key] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function renderCustomModels() {
  const body = $('#settings-models-body');
  if (!body) return;
  const models = customModels();
  if (!models.length) {
    body.innerHTML = '<p class="plugin-empty">No custom models yet. Add one below.</p>';
    return;
  }
  body.innerHTML = models.map((m) => {
    const keys = Object.keys(m.env || {});
    const envStr = keys.length
      ? keys.map((k) => `${esc(k)}=${esc(m.env[k])}`).join(' · ')
      : 'no extra environment';
    return `
        <div class="model-row" data-id="${esc(m.id)}">
          <div class="model-row-main">
            <div class="model-row-label">${esc(m.label)}</div>
            <div class="model-row-id"><code>${esc(m.model)}</code></div>
            <div class="model-row-env">${envStr}</div>
          </div>
          <button class="btn icon danger model-remove" title="Remove" aria-label="Remove model">${icon('trash')}</button>
        </div>`;
  }).join('');
}

async function setCustomModels(models) {
  await saveSettings({ customModels: models });
  syncCustomModelOptions();
  renderCustomModels();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#model-add-btn').addEventListener('click', async () => {
    const label = $('#model-add-label').value.trim();
    const model = $('#model-add-id').value.trim();
    if (!label || !model) { toast('A model needs a name and a model id.'); return; }
    const env = parseEnvLines($('#model-add-env').value);
    await setCustomModels([...customModels(), { label, model, env }]);
    $('#model-add-label').value = '';
    $('#model-add-id').value = '';
    $('#model-add-env').value = '';
  });

  $('#settings-models-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.model-remove');
    if (!btn) return;
    const id = btn.closest('.model-row').dataset.id;
    await setCustomModels(customModels().filter((m) => m.id !== id));
  });

  for (const item of document.querySelectorAll('.settings-nav-item')) {
    item.addEventListener('click', () => showSettingsSection(item.dataset.section));
  }
  $('#btn-settings').addEventListener('click', () => openSettingsModal());
  $('#settings-close').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
  $('#setting-notifications').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (enabled) await ensureNotifyPermission(); // prompt on opt-in (browser only)
    await saveSettings({ notifications: enabled });
    updateNotifNote();
  });
  $('#setting-notif-test').addEventListener('click', () => {
    // Works in both modes: under Electron the Web Notification routes to a native one.
    showBrowserNotification('Sr. Popo', { body: 'Notifications are working.' }, true);
  });
  $('#setting-sounds').addEventListener('change', async (e) => {
    await saveSettings({ sounds: e.target.checked });
  });
  $('#setting-sound-test').addEventListener('click', () => playSound('finish', true));
  $('#setting-max-parallel').addEventListener('change', async (e) => {
    const n = Math.min(20, Math.max(1, Math.trunc(Number(e.target.value)) || 1));
    e.target.value = n;
    await saveSettings({ maxParallelSessions: n });
    // "Auto" is derived from this cap, so its label moves with it.
    renderSessionMemorySetting();
    renderBoard();
  });
  $('#setting-session-memory').addEventListener('change', async (e) => {
    const value = e.target.value === 'auto' ? 'auto' : Number(e.target.value);
    await saveSettings({ sessionMemoryMb: value });
    renderSessionMemorySetting();
  });
  $('#setting-isolate-mcp').addEventListener('change', async (e) => {
    await saveSettings({ isolateMcpServers: e.target.checked });
  });
  $('#setting-merge-strategy').addEventListener('change', async (e) => {
    await saveSettings({ mergeStrategy: e.target.value });
  });
  $('#setting-min-merge-grade').addEventListener('change', async (e) => {
    await saveSettings({ minMergeGrade: Number(e.target.value) });
  });
  $('#setting-auto-resolve-conflicts').addEventListener('change', async (e) => {
    await saveSettings({ autoResolveConflicts: e.target.checked });
  });
  $('#setting-assign-pr-to-self').addEventListener('change', async (e) => {
    await saveSettings({ assignPrToSelf: e.target.checked });
  });
  $('#setting-memory').addEventListener('change', async (e) => {
    await saveSettings({ memory: e.target.checked });
  });
  $('#setting-resource-monitor').addEventListener('change', async (e) => {
    await saveSettings({ resourceMonitor: e.target.checked });
    syncResourceMonitor();
  });
}


export { customModels, renderCustomModels, syncCustomModelOptions };
