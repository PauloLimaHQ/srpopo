/* Sr. Popo — task-modal. No build step: native ES module. */
import { api, esc, lookup, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { repoSettingsFor, wsConfigured, wsTaskDefaults } from './repo-settings.js';
import { openReposModal } from './repos-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- new task modal ----------
function refreshRepoSelect() {
  const sel = $('#task-repo');
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

// Show the repo's live current branch (not the stale snapshot taken when it
// was added) next to a repo <select>, so the user knows what a non-worktree
// task would run against. `hintEl` is a <span> updated in place; a repo with
// no branch (detached HEAD, lookup failure) clears the hint quietly.
async function refreshRepoBranchHint(repoId, hintEl) {
  if (!repoId) { hintEl.textContent = ''; return; }
  try {
    const { branch } = await api('GET', `/api/repos/${repoId}/branch`);
    hintEl.textContent = branch ? `Repo is currently on ${branch}` : '';
  } catch {
    hintEl.textContent = '';
  }
}

// Populate the base-branch <select> for a repo: every local branch, with the
// one currently checked out flagged. The picker defaults to `selected` (a task's
// stored baseBranch) or the current branch. `dataset.current` remembers the live
// branch so saveTask can tell "left on the default" from an explicit pick.
async function refreshBaseBranchPicker(repoId, selectEl, selected) {
  selectEl.dataset.current = '';
  if (!repoId) { selectEl.innerHTML = ''; selectEl.disabled = true; return; }
  selectEl.disabled = true;
  selectEl.innerHTML = '<option>Loading…</option>';
  let current = null, branches = [];
  try { ({ current, branches } = await api('GET', `/api/repos/${repoId}/branches`)); } catch { /* leave empty */ }
  // Guard against a racing repo switch that already moved on to another repo.
  if ($('#task-repo').value && $('#task-repo').value !== repoId && !editingTaskId) return;
  if (current && !branches.includes(current)) branches = [current, ...branches];
  const want = (selected && branches.includes(selected)) ? selected : current;
  selectEl.dataset.current = current || '';
  selectEl.innerHTML = branches.length
    ? branches.map((b) => `<option value="${esc(b)}"${b === want ? ' selected' : ''}>${esc(b)}${b === current ? ' (current)' : ''}</option>`).join('')
    : '<option value="">No branches</option>';
  selectEl.disabled = !branches.length;
}

// Optional task behaviors — icon toggle chips derived from the /api/addons
// catalog, sitting in the same row as the worktree toggle so the whole set of
// "extra behavior" costs one line instead of a stack of labelled checkboxes.
// The `pull_request` addon gets a sibling segmented control so both PR modes —
// ready for review or draft — are one click away; it stays inert until the
// addon itself is on.
//
// The markup is shared with the workspace-settings modal
// (features/repo-settings.js) so there is one source of it. `prMode` is what
// adds that segmented control — only the New Task composer wants it; a
// workspace default has no PR mode of its own.
function addonChipsHtml(selected = [], prDraft = false, prMode = true) {
  const chosen = new Set(selected);
  return state.addons.map((a) => {
    const checked = chosen.has(a.id);
    const chip = `
        <label class="opt-chip" title="${esc(a.hint || a.label)}">
          <input type="checkbox" data-addon="${esc(a.id)}" ${checked ? 'checked' : ''} />
          ${icon(a.icon || 'sparkles')}${esc(a.short || a.label)}
        </label>`;
    if (a.id !== 'pull_request' || !prMode) return chip;
    return chip + `
        <span class="seg pr-mode ${checked ? '' : 'pr-mode-disabled'}" role="radiogroup" aria-label="Pull request mode">
          <label class="seg-opt" title="Open the pull request ready for review">
            <input type="radio" name="task-pr-mode" value="ready" ${prDraft ? '' : 'checked'} ${checked ? '' : 'disabled'} />Ready
          </label>
          <label class="seg-opt" title="Open the pull request as a draft">
            <input type="radio" name="task-pr-mode" value="draft" ${prDraft ? 'checked' : ''} ${checked ? '' : 'disabled'} />Draft
          </label>
        </span>`;
  }).join('');
}

function renderAddonOptions(selected = [], prDraft = false) {
  $('#task-addon-list').innerHTML = addonChipsHtml(selected, prDraft, true);
  // Enable/disable the ready-vs-draft radios as the PR checkbox is toggled —
  // the choice only means something once "Create a Pull Request" is checked.
  const prCheckbox = document.querySelector('#task-addon-list input[data-addon="pull_request"]');
  const prModeEl = document.querySelector('#task-addon-list .pr-mode');
  if (prCheckbox && prModeEl) {
    prCheckbox.addEventListener('change', () => {
      prModeEl.classList.toggle('pr-mode-disabled', !prCheckbox.checked);
      prModeEl.querySelectorAll('input').forEach((r) => { r.disabled = !prCheckbox.checked; });
    });
  }
}

function selectedAddons() {
  return [...document.querySelectorAll('#task-addons input[data-addon]:checked')]
    .map((el) => el.dataset.addon);
}

// Whether the "draft" radio is picked for the pull_request addon's PR mode.
// Meaningless (and ignored server-side) unless that addon is also selected.
function selectedPrDraft() {
  const el = document.querySelector('input[name="task-pr-mode"][value="draft"]');
  return !!(el && el.checked);
}

// The chosen base branch, but only when it differs from the repo's current
// branch — leaving the picker on the default keeps the historical behavior
// (worktree cut from HEAD at dispatch), so we send an empty value there.
function selectedBaseBranch() {
  const sel = $('#task-base-branch');
  const val = sel.value.trim();
  return val && val !== (sel.dataset.current || '') ? val : '';
}

// Expert personas — a compact, Claude-style multi-select instead of a wall of
// checkboxes. Selected personas show as removable chips; more are added from a
// searchable, keyboard-navigable popover. A selected persona is prepended to
// the prompt as a role preamble at dispatch.
const personaPicker = {
  selected: new Set(), // chosen persona ids
  activeIndex: 0,      // highlighted option within the currently filtered list
};

// Seed the picker when the modal opens (create or edit); keep only known ids.
function initPersonaPicker(selected = []) {
  const known = new Set(state.personas.map((p) => p.id));
  personaPicker.selected = new Set(selected.filter((id) => known.has(id)));
  closePersonaMenu();
  renderPersonaChips();
}

// Selected ids in catalog order — matches how the server sanitizes them.
function selectedPersonas() {
  return state.personas.filter((p) => personaPicker.selected.has(p.id)).map((p) => p.id);
}

function renderPersonaChips() {
  const box = $('#task-persona-chips');
  const ids = selectedPersonas();
  // No placeholder text when nothing is picked — the "Persona" button next to
  // it already says what the control is, and the row stays one line tall.
  if (!ids.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = ids.map((id) => {
    const p = state.personas.find((x) => x.id === id);
    const label = p ? p.label : id;
    return `<span class="persona-tag" role="listitem">
          <span class="persona-tag-label">${icon('persona')} ${esc(label)}</span>
          <button type="button" class="persona-tag-x" data-remove="${esc(id)}"
                  title="Remove ${esc(label)}" aria-label="Remove ${esc(label)}">${icon('x')}</button>
        </span>`;
  }).join('');
}

function personaMenuOpen() {
  return !$('#task-persona-menu').classList.contains('hidden');
}

// Catalog filtered by the search box (matches label or hint).
function visiblePersonas() {
  const q = $('#task-persona-search').value.trim().toLowerCase();
  if (!q) return state.personas;
  return state.personas.filter((p) =>
    p.label.toLowerCase().includes(q) || (p.hint || '').toLowerCase().includes(q));
}

function renderPersonaMenu() {
  const list = $('#task-persona-options');
  const opts = visiblePersonas();
  if (personaPicker.activeIndex > opts.length - 1) personaPicker.activeIndex = opts.length - 1;
  if (personaPicker.activeIndex < 0) personaPicker.activeIndex = 0;
  // Point the combobox at the highlighted option for screen readers.
  const active = opts[personaPicker.activeIndex];
  $('#task-persona-search').setAttribute('aria-activedescendant', active ? `persona-opt-${active.id}` : '');
  if (!opts.length) {
    list.innerHTML = '<div class="persona-none">No matching persona</div>';
    return;
  }
  list.innerHTML = opts.map((p, i) => {
    const on = personaPicker.selected.has(p.id);
    const active = i === personaPicker.activeIndex;
    return `<div class="persona-option${on ? ' on' : ''}${active ? ' active' : ''}"
          role="option" id="persona-opt-${esc(p.id)}" aria-selected="${on}"
          data-persona="${esc(p.id)}">
          <span class="persona-check" aria-hidden="true">${on ? icon('check') : ''}</span>
          <span class="addon-text">
            <span class="addon-label">${esc(p.label)}</span>
            ${p.hint ? `<span class="addon-hint">${esc(p.hint)}</span>` : ''}
          </span>
        </div>`;
  }).join('');
}

function scrollActiveOptionIntoView() {
  const el = $('#task-persona-options').querySelector('.persona-option.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function openPersonaMenu() {
  $('#task-persona-menu').classList.remove('hidden');
  $('#task-persona-add').setAttribute('aria-expanded', 'true');
  $('#task-persona-search').value = '';
  personaPicker.activeIndex = 0;
  renderPersonaMenu();
  $('#task-persona-search').focus();
}

function closePersonaMenu() {
  $('#task-persona-menu').classList.add('hidden');
  $('#task-persona-add').setAttribute('aria-expanded', 'false');
}

function togglePersona(id) {
  if (personaPicker.selected.has(id)) personaPicker.selected.delete(id);
  else personaPicker.selected.add(id);
  renderPersonaChips();
  renderPersonaMenu();
}

// "Auto persona" hands the choice to the run itself (it picks an expert hat
// from the same catalog before it starts), so the manual picker is hidden
// while it's on. The selection is kept, not cleared — turning it back off
// restores whatever was chosen.
function syncAutoPersona() {
  const auto = $('#task-auto-persona').checked;
  $('#task-persona-menu').closest('.persona-picker').classList.toggle('hidden', auto);
  if (auto) closePersonaMenu();
}

// The branch-name override only means anything for a worktree run.
function syncWorktreeFields() {
  $('#task-branch-field').classList.toggle('hidden', !$('#task-worktree').checked);
}

// Remember the settings used on the last created task so a new task defaults
// to them instead of the hardcoded defaults — no need to re-pick every time.
const LAST_USED_KEY = 'srpopo.lastTaskSettings';
function loadLastUsed() {
  try { return JSON.parse(localStorage.getItem(LAST_USED_KEY)) || {}; }
  catch { return {}; }
}
function saveLastUsed(fields, repoId) {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify({
      agent: fields.agent,
      model: fields.model,
      permissionMode: fields.permissionMode,
      allowedTools: fields.allowedTools,
      useWorktree: fields.useWorktree,
      addons: fields.addons,
      prDraft: fields.prDraft,
      autoCodeReview: fields.autoCodeReview,
      personas: fields.personas,
      autoPersona: fields.autoPersona,
      repoId,
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

// null => create mode; a task => edit that task.
let editingTaskId = null;
// Attachments held for the modal: `staged` are File objects not yet uploaded
// (create mode — uploaded after the task exists); `saved` are Attachment
// entries already on the server (edit mode — removable via the delete route).
let stagedFiles = [];
let savedAttachments = [];

// An ES module's exports are read-only bindings, so the attachments module —
// which drops a saved attachment via the delete route — replaces the list
// through here instead of assigning to the import.
function setSavedAttachments(list) {
  savedAttachments = list;
}

// Extensions the server will hand back through the attachment preview route
// (server/index.ts PREVIEW_TYPES). Anything else gets a file glyph instead.
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

// Object URLs for staged image files, so a dropped screenshot shows a real
// thumbnail before the task (and therefore the upload route) exists. Revoked
// when the file is removed or the modal is reopened, so nothing leaks.
const stagedPreviews = new Map(); // File -> object URL

function releaseStagedPreviews() {
  stagedPreviews.forEach((url) => URL.revokeObjectURL(url));
  stagedPreviews.clear();
}

function stagedPreviewUrl(file) {
  if (!PREVIEWABLE.test(file.name)) return '';
  if (!stagedPreviews.has(file)) stagedPreviews.set(file, URL.createObjectURL(file));
  return stagedPreviews.get(file);
}

// One attachment as a compact card with a thumbnail — the "mini preview" a
// modern prompt input shows for whatever you dropped on it.
function attachmentCard(removeAttr, key, name, size, url) {
  const thumb = url
    ? `<img class="att-thumb" src="${esc(url)}" alt="" />`
    : `<span class="att-thumb att-glyph">${icon(PREVIEWABLE.test(name) ? 'image' : 'file')}</span>`;
  return `<div class="att-card" title="${esc(name)} · ${esc(fmtBytes(size))}">
        ${thumb}
        <span class="att-meta">
          <span class="att-name">${esc(name)}</span>
          <span class="att-size">${esc(fmtBytes(size))}</span>
        </span>
        <button type="button" class="att-x" ${removeAttr}="${esc(key)}"
                title="Remove" aria-label="Remove ${esc(name)}">${icon('x')}</button>
      </div>`;
}

function renderAttachments() {
  const cards = [
    ...savedAttachments.map((a) => attachmentCard(
      'data-remove-saved', a.name, a.name, a.size,
      editingTaskId && PREVIEWABLE.test(a.name)
        ? `/api/tasks/${editingTaskId}/attachments/${encodeURIComponent(a.name)}/preview`
        : '')),
    ...stagedFiles.map((f, i) => attachmentCard(
      'data-remove-staged', String(i), f.name, f.size, stagedPreviewUrl(f))),
  ];
  const el = $('#task-attachment-list');
  el.innerHTML = cards.join('');
  // Collapse the tray entirely when there's nothing attached.
  el.classList.toggle('hidden', !cards.length);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// Upload one File to a task's attachment route as raw bytes.
async function uploadAttachment(taskId, file) {
  const res = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload of ${file.name} failed (${res.status})`);
  return data;
}

// Add files chosen via the picker or dropped on the zone. In edit mode they
// upload immediately; in create mode they stage until the task is created.
async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (editingTaskId) {
    try {
      let task;
      for (const f of files) task = await uploadAttachment(editingTaskId, f);
      if (task) {
        state.tasks.set(task.id, task);
        renderBoard();
        savedAttachments = task.attachments || [];
        renderAttachments();
      }
    } catch (e) { toast(e.message); }
  } else {
    stagedFiles.push(...files);
    renderAttachments();
  }
}

// Seed every run-setting field of the composer. Where the values come from:
//   - editing a task     — the task's own values, always;
//   - a configured repo  — the workspace's defaults (features/repo-settings.js),
//                          which beat the browser's last-used memory outright;
//   - anything else      — the last task the user created, as before.
// Whatever the source leaves unset falls back to the hardcoded defaults here,
// so this is unchanged for a workspace with nothing configured.
function prefillTaskDefaults(task) {
  const ws = repoSettingsFor(task ? task.repoId : $('#task-repo').value);
  const src = task ? {} : (wsConfigured(ws) ? wsTaskDefaults(ws) : loadLastUsed());
  $('#task-agent').value = task ? (task.agent || 'claude') : (src.agent || 'claude');
  $('#task-model').value = task ? (task.model || 'default') : (src.model || 'default');
  // Show only the selected agent's models; drops the selection back to "default"
  // if the restored model belongs to the other agent. Also toggles the Codex
  // permissions hint.
  syncAgentModels();
  $('#task-perm').value = task ? (task.permissionMode || 'acceptEdits') : (src.permissionMode || 'acceptEdits');
  $('#task-allowed-tools').value = task ? (task.allowedTools || '') : (src.allowedTools || '');
  $('#task-worktree').checked = task ? !!task.useWorktree : (src.useWorktree ?? true);
  $('#task-auto-code-review').checked = task ? !!task.autoCodeReview : !!src.autoCodeReview;
  renderAddonOptions(task ? (task.addons || []) : (src.addons || []), task ? !!task.prDraft : !!src.prDraft);
  initPersonaPicker(task ? (task.personas || []) : (src.personas || []));
  $('#task-auto-persona').checked = task ? !!task.autoPersona : !!src.autoPersona;
  syncAutoPersona();
  syncBranchHint(ws);
}

// The workspace's branch convention is what a new task's branch is actually
// named when the field below is left blank, so show it as the field's
// placeholder and say so in its hint.
function syncBranchHint(ws) {
  const template = ws.branchTemplate || '';
  $('#task-branch').placeholder = template || 'e.g. feature/ABC-123, matching your repo\'s convention';
  $('#task-branch-hint').innerHTML = template
    ? `— optional, defaults to this workspace's <code>${esc(template)}</code>`
    : '— optional, defaults to <code>srpopo/&lt;task&gt;-&lt;id&gt;</code>';
}

function openTaskModal(task = null) {
  editingTaskId = task ? task.id : null;
  releaseStagedPreviews();
  stagedFiles = [];
  savedAttachments = task ? (task.attachments || []).slice() : [];
  renderAttachments();
  refreshRepoSelect();
  // The repo is resolved *first*: which workspace a new task lands in is what
  // decides where the rest of the form's defaults come from.
  $('#task-repo-field').classList.toggle('hidden', !!task);
  if (task) $('#task-repo').value = task.repoId;
  else {
    const last = loadLastUsed();
    if (currentWorkspaceRepoId()) $('#task-repo').value = currentWorkspaceRepoId();
    // Restore the last-used repo if it still exists in the current list.
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#task-repo').value = last.repoId;
  }
  $('#task-title').value = task ? task.title : '';
  $('#task-prompt').value = task ? task.prompt : '';
  prefillTaskDefaults(task);
  // A materialized worktree can't be toggled off; the repo can't move after creation.
  $('#task-worktree').disabled = !!(task && task.worktreePath);
  $('#task-branch').value = task ? (task.branchName || '') : '';
  // The branch is fixed once the worktree is materialized.
  $('#task-branch').disabled = !!(task && task.worktreePath);
  syncWorktreeFields();
  // Advanced starts folded away, and only unfolds when it has something to show.
  $('#task-advanced').open = !!($('#task-branch').value || $('#task-allowed-tools').value);
  refreshRepoBranchHint($('#task-repo').value, $('#task-repo-branch'));
  // The base branch is fixed once the worktree is materialized.
  const baseLocked = !!(task && task.worktreePath);
  $('#task-new-branch').disabled = baseLocked;
  const wsBase = repoSettingsFor($('#task-repo').value).baseBranch || null;
  refreshBaseBranchPicker($('#task-repo').value, $('#task-base-branch'), task ? task.baseBranch : wsBase)
    .then(() => { if (baseLocked) $('#task-base-branch').disabled = true; });

  $('#task-modal-title').innerHTML = `${icon(task ? 'pencil' : 'sparkles')}${task ? 'Edit Task' : 'New Task'}`;
  $('#task-create').innerHTML = `${icon('inbox')}${task ? 'Save' : 'Create in Backlog'}`;
  $('#task-create-run').innerHTML = `${icon('play')}${task ? 'Save & Run' : 'Create & Run'}`;

  $('#modal-task').classList.remove('hidden');
  // New tasks lead with the prompt (title is optional/derived); editing an
  // existing task leads with the title, since that's the field most likely
  // to need a manual tweak.
  (task ? $('#task-title') : $('#task-prompt')).focus();
}

async function saveTask(run) {
  const title = $('#task-title').value.trim();
  const prompt = $('#task-prompt').value.trim();
  if (!prompt) { toast('Prompt is required'); return; }
  const fields = {
    // Left blank, the server derives one from the prompt — no title round-trip
    // through an LLM just for a label. Omitted (not sent empty) so an edit with
    // a blank field doesn't clear an existing/derived title.
    ...(title ? { title } : {}),
    prompt,
    agent: $('#task-agent').value,
    model: $('#task-model').value,
    permissionMode: $('#task-perm').value,
    allowedTools: $('#task-allowed-tools').value,
    useWorktree: $('#task-worktree').checked,
    branchName: $('#task-branch').value.trim(),
    // Only pin a base branch when the user picked one other than the repo's
    // current branch; otherwise keep the historical "cut from HEAD" default.
    baseBranch: selectedBaseBranch(),
    addons: selectedAddons(),
    prDraft: selectedPrDraft(),
    autoCodeReview: $('#task-auto-code-review').checked,
    personas: selectedPersonas(),
    // When on, the run picks its own hat and `personas` is ignored server-side
    // — but we still send the selection so toggling it back off restores it.
    autoPersona: $('#task-auto-persona').checked,
  };
  try {
    let task;
    if (editingTaskId) {
      task = await api('PATCH', `/api/tasks/${editingTaskId}`, fields);
    } else {
      const repoId = $('#task-repo').value;
      if (!repoId) { toast('Add a repository first'); return; }
      task = await api('POST', '/api/tasks', { ...fields, repoId, status: run ? 'ready' : 'backlog' });
      saveLastUsed(fields, repoId);
      // Uploads are keyed by task id, so they wait until the task exists.
      for (const f of stagedFiles) task = await uploadAttachment(task.id, f);
      stagedFiles = [];
      releaseStagedPreviews();
    }
    state.tasks.set(task.id, task);
    $('#modal-task').classList.add('hidden');
    if (run) await api('POST', `/api/tasks/${task.id}/dispatch`);
  } catch (e) { toast(e.message); }
}

// What the Permissions choice actually means on a backend that has no per-tool
// approval prompt. Claude is absent on purpose — it asks, so the picker already
// reads literally there and needs no footnote.
const PERM_HINTS = {
  codex: 'Codex maps this to a sandbox level (read-only / workspace-write); there is no per-tool prompt.',
  grok: 'Grok maps this to its own permission mode; there is no per-tool prompt, so "Ask by default" denies anything outside the allow-list instead of asking.',
};

// Show only the chosen agent's models in the New-Task model picker and set the
// permissions hint for it. Options tagged data-agent (or data-custom, which
// are Claude/Bedrock models) are shown only for their agent; the untagged
// "Account default" is always available. Resets to default if the current
// selection belongs to another agent.
function syncAgentModels() {
  const agent = $('#task-agent').value;
  const sel = $('#task-model');
  for (const opt of sel.options) {
    const a = opt.dataset.agent || (opt.dataset.custom ? 'claude' : null);
    opt.hidden = a ? a !== agent : false;
  }
  if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden) sel.value = 'default';
  // Neither Codex nor Grok has a per-tool approval prompt, and each reinterprets
  // the permission choice above in its own terms. Say so in the form so the
  // choice isn't misleading (see server/agents/codex.ts and grok.ts).
  const hint = $('#task-perm-agent-hint');
  hint.textContent = lookup(PERM_HINTS, agent) || '';
  hint.classList.toggle('hidden', !hint.textContent);
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // --- persona picker wiring (elements are static, so wire once) ---
  $('#task-persona-add').addEventListener('click', () => {
    if (personaMenuOpen()) { closePersonaMenu(); $('#task-persona-add').focus(); }
    else openPersonaMenu();
  });
  $('#task-persona-chips').addEventListener('click', (e) => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (id) togglePersona(id);
  });
  $('#task-persona-options').addEventListener('click', (e) => {
    const id = e.target.closest('[data-persona]')?.dataset.persona;
    if (id) { togglePersona(id); $('#task-persona-search').focus(); }
  });
  $('#task-persona-search').addEventListener('input', () => {
    personaPicker.activeIndex = 0;
    renderPersonaMenu();
  });
  $('#task-persona-search').addEventListener('keydown', (e) => {
    const opts = visiblePersonas();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      personaPicker.activeIndex = Math.min(opts.length - 1, personaPicker.activeIndex + 1);
      renderPersonaMenu(); scrollActiveOptionIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      personaPicker.activeIndex = Math.max(0, personaPicker.activeIndex - 1);
      renderPersonaMenu(); scrollActiveOptionIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = opts[personaPicker.activeIndex];
      if (p) togglePersona(p.id);
    } else if (e.key === 'Escape') {
      // Close just the menu — don't let the global handler dismiss the modal.
      e.preventDefault(); e.stopPropagation();
      closePersonaMenu(); $('#task-persona-add').focus();
    }
  });
  // Click anywhere outside the picker closes the menu.
  document.addEventListener('click', (e) => {
    if (personaMenuOpen() && !e.target.closest('.persona-picker')) closePersonaMenu();
  });
  $('#task-auto-persona').addEventListener('change', syncAutoPersona);
  $('#task-worktree').addEventListener('change', syncWorktreeFields);
  $('#task-agent').addEventListener('change', syncAgentModels);

  $('#btn-new-task').addEventListener('click', () => openTaskModal());
  $('#task-cancel').addEventListener('click', () => $('#modal-task').classList.add('hidden'));
  $('#task-create').addEventListener('click', () => saveTask(false));
  $('#task-create-run').addEventListener('click', () => saveTask(true));
  $('#task-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#task-create-run').click();
  });
  $('#task-add-repo').addEventListener('click', () => {
    $('#modal-task').classList.add('hidden');
    openReposModal();
  });
  $('#task-repo').addEventListener('change', () => {
    const repoId = $('#task-repo').value;
    refreshRepoBranchHint(repoId, $('#task-repo-branch'));
    // Switching repo mid-compose re-seeds the form from the new workspace — its
    // defaults are the whole point, and they'd otherwise be a reopen away. Only
    // in create mode: the picker is hidden while editing an existing task.
    if (!editingTaskId) prefillTaskDefaults(null);
    refreshBaseBranchPicker(repoId, $('#task-base-branch'),
      editingTaskId ? null : (repoSettingsFor(repoId).baseBranch || null));
  });
  // Create a fresh branch (checked out from the repo's current one) and select it.
  $('#task-new-branch').addEventListener('click', async () => {
    const repoId = editingTaskId ? (state.tasks.get(editingTaskId)?.repoId) : $('#task-repo').value;
    if (!repoId) { toast('Add a repository first'); return; }
    const current = $('#task-base-branch').dataset.current || '';
    const name = (prompt(current ? `New branch name (checked out from ${current}):` : 'New branch name:') || '').trim();
    if (!name) return;
    try {
      await api('POST', `/api/repos/${repoId}/branches`, { name });
      await refreshBaseBranchPicker(repoId, $('#task-base-branch'), name);
      refreshRepoBranchHint(repoId, $('#task-repo-branch'));
      toast(`Created and checked out ${name}`, 'info');
    } catch (e) { toast(e.message); }
  });
}


export { addFiles, addonChipsHtml, editingTaskId, fmtBytes, loadLastUsed, openTaskModal, refreshRepoBranchHint, refreshRepoSelect, renderAttachments, setSavedAttachments, stagedFiles, stagedPreviews };
