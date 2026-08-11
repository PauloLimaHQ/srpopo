/* Sr. Popo — linear. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { openGroomingDrawer } from './drawer.js';
import { openReposModal } from './repos-modal.js';
import { openSettingsModal } from './settings-modal.js';
import { loadLastUsed, refreshRepoBranchHint } from './task-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- create task from linear ----------
const linearConfigured = () => !!state.settings.linearConfigured;
let linearSelectedId = null; // the Linear UUID picked from the browse list, if any

function refreshLinearRepoSelect() {
  const sel = $('#linear-repo');
  if (!sel) return;
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

// Toggle between the configured form and the "add a key first" note.
function renderLinearConfigState() {
  const configured = linearConfigured();
  $('#linear-unconfigured').classList.toggle('hidden', configured);
  $('#linear-config').classList.toggle('hidden', !configured);
}

function openLinearModal() {
  refreshLinearRepoSelect();
  const last = loadLastUsed();
  $('#linear-issue-id').value = '';
  $('#linear-branch').value = '';
  $('#linear-model').value = last.model || 'default';
  if (currentWorkspaceRepoId()) $('#linear-repo').value = currentWorkspaceRepoId();
  else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#linear-repo').value = last.repoId;
  refreshRepoBranchHint($('#linear-repo').value, $('#linear-repo-branch'));
  linearSelectedId = null;
  $('#linear-issue-list').innerHTML = '';
  renderLinearConfigState();
  $('#modal-linear').classList.remove('hidden');
  if (linearConfigured()) { loadLinearIssues(); $('#linear-issue-id').focus(); }
}

async function loadLinearIssues() {
  const list = $('#linear-issue-list');
  list.innerHTML = '<div class="muted linear-loading">Loading your issues…</div>';
  try {
    const { issues } = await api('GET', '/api/linear/issues');
    if (!issues || !issues.length) {
      list.innerHTML = '<div class="muted">No assigned issues found.</div>';
      return;
    }
    list.innerHTML = issues.map((i) => `
        <button type="button" class="linear-issue" data-id="${esc(i.id)}" data-identifier="${esc(i.identifier)}">
          <span class="linear-issue-id">${esc(i.identifier)}</span>
          <span class="linear-issue-title">${esc(i.title)}</span>
          ${i.state ? `<span class="chip">${esc(i.state)}</span>` : ''}
        </button>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
  }
}

async function submitLinear() {
  const repoId = $('#linear-repo').value;
  const typed = $('#linear-issue-id').value.trim();
  const issueId = typed || linearSelectedId;
  if (!repoId) { toast('Add a repository first'); return; }
  if (!issueId) { toast('Paste an issue ID or pick one from the list'); return; }
  try {
    const grooming = await api('POST', '/api/linear/briefs', {
      issueId, repoId, model: $('#linear-model').value, branchName: $('#linear-branch').value.trim(),
    });
    state.groomings.set(grooming.id, grooming);
    $('#modal-linear').classList.add('hidden');
    renderBoard();
    toast('Importing the Linear issue…', 'info');
    openGroomingDrawer(grooming.id);
  } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // Clicking an issue selects it: fill the id field with its identifier and
  // remember its UUID. Typing in the id field clears the selection (typed wins).
  $('#linear-issue-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.linear-issue');
    if (!btn) return;
    linearSelectedId = btn.dataset.id;
    $('#linear-issue-id').value = btn.dataset.identifier;
    // Suggest the issue's own identifier as the branch name unless the user
    // already typed a custom one.
    if (!$('#linear-branch').value.trim()) {
      $('#linear-branch').value = btn.dataset.identifier.toLowerCase();
    }
    for (const el of $('#linear-issue-list').querySelectorAll('.linear-issue')) el.classList.remove('selected');
    btn.classList.add('selected');
  });
  $('#linear-issue-id').addEventListener('input', () => {
    linearSelectedId = null;
    for (const el of $('#linear-issue-list').querySelectorAll('.linear-issue')) el.classList.remove('selected');
  });

  $('#btn-linear').addEventListener('click', openLinearModal);
  $('#linear-cancel').addEventListener('click', () => $('#modal-linear').classList.add('hidden'));
  $('#linear-submit').addEventListener('click', submitLinear);
  $('#linear-refresh').addEventListener('click', loadLinearIssues);
  $('#linear-issue-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitLinear();
  });
  $('#linear-add-repo').addEventListener('click', () => {
    $('#modal-linear').classList.add('hidden');
    openReposModal();
  });
  $('#linear-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#linear-repo').value, $('#linear-repo-branch'));
  });
  $('#linear-open-settings').addEventListener('click', () => {
    $('#modal-linear').classList.add('hidden');
    openSettingsModal('plugins');
  });
}


export { linearConfigured, openLinearModal, refreshLinearRepoSelect, renderLinearConfigState };
