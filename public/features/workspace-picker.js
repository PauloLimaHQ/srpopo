/* Sr. Popo — workspace-picker. No build step: native ES module. */
import { esc } from '../core/api.js';
import { $, icon, isLive, state } from '../core/state.js';
import { tasksForRepo } from './filters.js';
import { enterWorkspace, exitWorkspace } from './workspaces.js';


// ---------- workspace quick switcher (anchored popover) ----------
// Jump straight from one workspace to another (or back to Super View) without
// detouring through the Super View grid. Modeled on the command palette: a
// filterable, arrow-key-navigable list, but anchored under the header title.
let wsPickerResults = []; // flat, in on-screen order: { kind:'super' } | { kind:'repo', repo }
let wsPickerActive = 0;

function wsPickerIsCurrent(entry) {
  return entry.kind === 'super'
    ? state.view.mode === 'super'
    : state.view.mode === 'workspace' && state.view.repoId === entry.repo.id;
}

function renderWorkspacePicker(query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text) => tokens.every((t) => text.includes(t));
  wsPickerResults = [];
  if (matches('super view all workspaces home')) wsPickerResults.push({ kind: 'super' });
  for (const r of state.repos) {
    if (matches(`${r.name} ${r.path}`.toLowerCase())) wsPickerResults.push({ kind: 'repo', repo: r });
  }
  // Start the highlight on the current workspace so Enter is a no-op, not a surprise.
  const curIdx = wsPickerResults.findIndex(wsPickerIsCurrent);
  wsPickerActive = curIdx >= 0 ? curIdx : 0;

  const list = $('#workspace-popover-list');
  if (!wsPickerResults.length) {
    list.innerHTML = '<div class="palette-empty">No matching workspaces</div>';
    return;
  }
  list.innerHTML = wsPickerResults.map((e, i) => {
    let iconName, label, hint;
    if (e.kind === 'super') {
      iconName = 'arrow-left'; label = 'Super View'; hint = 'All workspaces';
    } else {
      iconName = 'folder'; label = e.repo.name;
      const tasks = tasksForRepo(e.repo.id);
      const live = tasks.filter(isLive).length;
      const count = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
      hint = live ? `${count} · ${live} live` : count;
    }
    return `<div class="palette-option" data-index="${i}" role="menuitem">
        <span class="palette-option-icon">${icon(iconName)}</span>
        <span class="palette-option-body">
          <span class="palette-option-label">${esc(label)}</span>
          <span class="palette-option-hint">${esc(hint)}</span>
        </span>
        ${wsPickerIsCurrent(e) ? `<span class="ws-check" title="Current">${icon('check')}</span>` : ''}
      </div>`;
  }).join('');
  updateWsPickerActive();
}

function updateWsPickerActive() {
  const list = $('#workspace-popover-list');
  list.querySelectorAll('.palette-option').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.index) === wsPickerActive);
  });
  list.querySelector('.palette-option.active')?.scrollIntoView({ block: 'nearest' });
}

function moveWsPicker(delta) {
  if (!wsPickerResults.length) return;
  wsPickerActive = (wsPickerActive + delta + wsPickerResults.length) % wsPickerResults.length;
  updateWsPickerActive();
}

function activateWsPicker(index) {
  const entry = wsPickerResults[index];
  if (!entry) return;
  closeWorkspacePicker();
  if (entry.kind === 'super') exitWorkspace();
  else enterWorkspace(entry.repo.id);
}

const wsPickerOpen = () => !$('#workspace-popover').classList.contains('hidden');
function openWorkspacePicker() {
  $('#workspace-popover-search').value = '';
  renderWorkspacePicker('');
  $('#workspace-popover').classList.remove('hidden');
  $('#workspace-switcher').setAttribute('aria-expanded', 'true');
  $('#workspace-popover-search').focus();
}
function closeWorkspacePicker() {
  $('#workspace-popover').classList.add('hidden');
  $('#workspace-switcher').setAttribute('aria-expanded', 'false');
}
function toggleWorkspacePicker() { wsPickerOpen() ? closeWorkspacePicker() : openWorkspacePicker(); }

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#workspace-switcher').addEventListener('click', (e) => { e.stopPropagation(); toggleWorkspacePicker(); });
  $('#workspace-popover-search').addEventListener('input', (e) => renderWorkspacePicker(e.target.value));
  $('#workspace-popover-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveWsPicker(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveWsPicker(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activateWsPicker(wsPickerActive); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWorkspacePicker(); $('#workspace-switcher').focus(); }
  });
  $('#workspace-popover-list').addEventListener('click', (e) => {
    const row = e.target.closest('.palette-option');
    if (row) activateWsPicker(Number(row.dataset.index));
  });
  $('#workspace-popover-list').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.palette-option');
    if (row && Number(row.dataset.index) !== wsPickerActive) {
      wsPickerActive = Number(row.dataset.index);
      updateWsPickerActive();
    }
  });
  // Click anywhere outside the popover (or its trigger) closes it.
  document.addEventListener('click', (e) => {
    if (wsPickerOpen() && !e.target.closest('#workspace-popover') && !e.target.closest('#workspace-switcher')) {
      closeWorkspacePicker();
    }
  });
}


export { closeWorkspacePicker };
