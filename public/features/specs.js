/* Sr. Popo — specs. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { openReposModal } from './repos-modal.js';
import { loadLastUsed } from './task-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- create task(s) from repo specs ----------
// Unlike the Linear import, this is a direct import: a spec file's own
// content already reads like a self-contained instruction, so it becomes
// task.prompt as-is — no grooming/LLM pass in between.
let specsFiles = []; // last GET /api/repos/:id/specs result for the current repo
let specsSelected = new Set(); // checked paths, staged for import
let specsPreviewCache = new Map(); // "repoId:path" -> file content
// The statuses the list defaults to showing (repo-declared, else built-in);
// `specsShowAll` reveals the retired/shipped ones behind the "Show all" toggle.
let specsActionableStatuses = ['draft', 'in-progress', 'partial'];
let specsShowAll = false;

// A spec is actionable when its status is in the actionable set. Every listed
// spec carries a status — discovery only lists files with full frontmatter.
const specIsActionable = (f) => specsActionableStatuses.includes(f.status);
// The status chips and the "Show all" toggle only mean something once the repo
// actually has specs to show.
const specsHaveStatus = () => specsFiles.length > 0;
const statusSlug = (status) => String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Coarse "N time-unit(s) ago" label for a spec's mtime — good enough for a
// browse list; no need for anything fancier here.
function relativeTime(iso) {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

const specRoot = (specPath) => (specPath.startsWith('.specs/') ? '.specs' : 'specs');

function refreshSpecsRepoSelect() {
  const sel = $('#specs-repo');
  if (!sel) return;
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

function specsFilterQuery() {
  return $('#specs-filter').value.trim().toLowerCase();
}

function filteredSpecFiles() {
  const q = specsFilterQuery();
  return specsFiles.filter((f) => {
    if (!specsShowAll && !specIsActionable(f)) return false;
    if (!q) return true;
    return f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
  });
}

function updateSpecsSelectAllState() {
  const master = $('#specs-select-all');
  const files = filteredSpecFiles();
  const allChecked = files.length > 0 && files.every((f) => specsSelected.has(f.path));
  const someChecked = files.some((f) => specsSelected.has(f.path));
  master.disabled = !specsFiles.length;
  master.checked = allChecked;
  master.indeterminate = !allChecked && someChecked;
}

// The "Show all" toggle only makes sense for a frontmatter-driven repo (one
// with statuses); a plain-markdown repo hides it and behaves exactly as before.
function updateSpecsShowAllToggle() {
  const toggle = $('#specs-show-all-field');
  if (!toggle) return;
  toggle.classList.toggle('hidden', !specsHaveStatus());
}

function renderSpecsList() {
  updateSpecsShowAllToggle();
  const list = $('#specs-list');
  if (!specsFiles.length) {
    list.innerHTML = '<div class="specs-empty">No specs found under specs/ or .specs/ in this repo.</div>';
    updateSpecsSelectAllState();
    return;
  }
  const files = filteredSpecFiles();
  if (!files.length) {
    const msg = specsFilterQuery()
      ? 'No specs match your filter.'
      : 'No actionable specs. Turn on “Show all” to see implemented, superseded and reserved specs.';
    list.innerHTML = `<div class="specs-empty">${esc(msg)}</div>`;
    updateSpecsSelectAllState();
    return;
  }
  const groups = new Map(); // root -> files[]
  for (const f of files) {
    const root = specRoot(f.path);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(f);
  }
  let html = '';
  for (const [root, items] of groups) {
    html += `<div class="specs-group-label">${esc(root)}/</div>`;
    html += items.map((f) => {
      const num = f.number ? `<span class="spec-row-num">${esc(f.number)}</span> ` : '';
      const chip = f.status
        ? `<span class="spec-status spec-status-${esc(statusSlug(f.status))}">${esc(f.status)}</span>`
        : '';
      return `
        <div class="spec-row${specsSelected.has(f.path) ? ' picked' : ''}" data-path="${esc(f.path)}">
          <input type="checkbox" class="spec-row-check" ${specsSelected.has(f.path) ? 'checked' : ''} />
          <div class="spec-row-body">
            <span class="spec-row-title">${num}${esc(f.title)}</span>
            <span class="spec-row-meta">${chip}<span class="spec-row-path">${esc(f.path)}</span> · ${esc(relativeTime(f.updatedAt))}</span>
          </div>
        </div>`;
    }).join('');
  }
  list.innerHTML = html;
  updateSpecsSelectAllState();
}

function resetSpecsPreview() {
  $('#specs-preview').textContent = 'Select a spec to preview it.';
  $('#specs-preview').classList.add('muted');
}

async function previewSpec(relPath) {
  for (const row of $('#specs-list').querySelectorAll('.spec-row')) {
    row.classList.toggle('previewing', row.dataset.path === relPath);
  }
  const repoId = $('#specs-repo').value;
  const preview = $('#specs-preview');
  const cacheKey = `${repoId}:${relPath}`;
  if (specsPreviewCache.has(cacheKey)) {
    preview.textContent = specsPreviewCache.get(cacheKey);
    preview.classList.remove('muted');
    return;
  }
  preview.textContent = 'Loading…';
  preview.classList.add('muted');
  try {
    const { content } = await api('GET', `/api/repos/${repoId}/specs/preview?path=${encodeURIComponent(relPath)}`);
    specsPreviewCache.set(cacheKey, content);
    preview.textContent = content;
    preview.classList.remove('muted');
  } catch (e) {
    preview.textContent = e.message;
  }
}

async function loadSpecsList() {
  const repoId = $('#specs-repo').value;
  const list = $('#specs-list');
  if (!repoId) { specsFiles = []; renderSpecsList(); return; }
  list.innerHTML = '<div class="muted specs-loading">Loading specs…</div>';
  try {
    const { specs, actionableStatuses } = await api('GET', `/api/repos/${repoId}/specs`);
    specsFiles = specs || [];
    if (Array.isArray(actionableStatuses) && actionableStatuses.length) specsActionableStatuses = actionableStatuses;
  } catch (e) {
    specsFiles = [];
    list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    return;
  }
  renderSpecsList();
}

function openSpecsModal() {
  refreshSpecsRepoSelect();
  const last = loadLastUsed();
  $('#specs-filter').value = '';
  $('#specs-target').value = 'backlog';
  $('#specs-model').value = last.model || 'default';
  if (currentWorkspaceRepoId()) $('#specs-repo').value = currentWorkspaceRepoId();
  else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#specs-repo').value = last.repoId;
  specsSelected = new Set();
  specsPreviewCache = new Map();
  specsShowAll = false;
  if ($('#specs-show-all')) $('#specs-show-all').checked = false;
  resetSpecsPreview();
  $('#modal-specs').classList.remove('hidden');
  loadSpecsList();
}

async function submitSpecsImport() {
  const repoId = $('#specs-repo').value;
  if (!repoId) { toast('Add a repository first'); return; }
  const paths = Array.from(specsSelected);
  if (!paths.length) { toast('Pick at least one spec file'); return; }
  try {
    const { tasks, skipped } = await api('POST', `/api/repos/${repoId}/specs/import`, {
      paths, target: $('#specs-target').value, model: $('#specs-model').value,
    });
    $('#modal-specs').classList.add('hidden');
    const n = tasks.length;
    toast(
      skipped.length ? `Imported ${n} task${n === 1 ? '' : 's'}, skipped ${skipped.length}` : `Imported ${n} task${n === 1 ? '' : 's'}`,
      'info',
    );
  } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-specs').addEventListener('click', openSpecsModal);
  $('#specs-cancel').addEventListener('click', () => $('#modal-specs').classList.add('hidden'));
  $('#specs-submit').addEventListener('click', submitSpecsImport);
  $('#specs-add-repo').addEventListener('click', () => {
    $('#modal-specs').classList.add('hidden');
    openReposModal();
  });
  $('#specs-repo').addEventListener('change', () => {
    specsSelected = new Set();
    specsPreviewCache = new Map();
    resetSpecsPreview();
    loadSpecsList();
  });
  $('#specs-filter').addEventListener('input', renderSpecsList);
  $('#specs-show-all').addEventListener('change', () => {
    specsShowAll = $('#specs-show-all').checked;
    renderSpecsList();
  });
  $('#specs-select-all').addEventListener('change', () => {
    const checked = $('#specs-select-all').checked;
    for (const f of filteredSpecFiles()) {
      if (checked) specsSelected.add(f.path); else specsSelected.delete(f.path);
    }
    renderSpecsList();
  });
  $('#specs-list').addEventListener('click', (e) => {
    const row = e.target.closest('.spec-row');
    if (!row || e.target.closest('.spec-row-check')) return;
    previewSpec(row.dataset.path);
  });
  $('#specs-list').addEventListener('change', (e) => {
    const cb = e.target.closest('.spec-row-check');
    if (!cb) return;
    const row = cb.closest('.spec-row');
    if (cb.checked) specsSelected.add(row.dataset.path); else specsSelected.delete(row.dataset.path);
    row.classList.toggle('picked', cb.checked);
    updateSpecsSelectAllState();
  });
}


export { openSpecsModal };
