/* Sr. Popo — grooming. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { openGroomingDrawer } from './drawer.js';
import { repoSettingsFor, wsConfigured, wsGroomDefaults } from './repo-settings.js';
import { openReposModal } from './repos-modal.js';
import { loadLastUsed, refreshRepoBranchHint } from './task-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- brief an idea (grooming) ----------
function refreshBriefRepoSelect() {
  const sel = $('#brief-repo');
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

// null => new grooming; a grooming card => edit that draft (or failed card).
let briefEditingId = null;

// Seed the model + target chips. Like the New Task composer: a workspace with
// anything configured (features/repo-settings.js) supplies them and beats the
// browser's last-used memory; anything it leaves unset keeps today's defaults.
function prefillBriefDefaults(grooming) {
  const ws = repoSettingsFor(grooming ? grooming.repoId : $('#brief-repo').value);
  const src = grooming ? {} : (wsConfigured(ws) ? wsGroomDefaults(ws) : loadLastUsed());
  $('#brief-target').value = grooming ? (grooming.target || 'backlog') : (src.target || 'backlog');
  $('#brief-model').value = grooming ? (grooming.model || 'default') : (src.model || 'default');
}

function openBriefModal(grooming = null) {
  // Guard: the header button passes its click event here — treat it as "new".
  if (!grooming || !grooming.id) grooming = null;
  briefEditingId = grooming ? grooming.id : null;
  refreshBriefRepoSelect();
  $('#brief-text').value = grooming ? grooming.idea : '';
  $('#brief-branch').value = grooming ? (grooming.branchName || '') : '';
  // The repo is resolved first (it decides the defaults), and is fixed once the
  // card exists — so the picker is hidden in edit mode.
  $('#brief-repo-field').classList.toggle('hidden', !!grooming);
  if (grooming) $('#brief-repo').value = grooming.repoId;
  else {
    const last = loadLastUsed();
    if (currentWorkspaceRepoId()) $('#brief-repo').value = currentWorkspaceRepoId();
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#brief-repo').value = last.repoId;
  }
  prefillBriefDefaults(grooming);
  refreshRepoBranchHint($('#brief-repo').value, $('#brief-repo-branch'));
  $('#brief-modal-title').innerHTML = `${icon('lightbulb')}${grooming ? 'Edit Draft' : 'Brief an Idea'}`;
  $('#brief-draft').textContent = grooming ? 'Save Draft' : 'Save as Draft';
  $('#modal-brief').classList.remove('hidden');
  $('#brief-text').focus();
}

// Create (or update) a grooming card. `run` starts the read-only session
// right away; otherwise the card stays parked in the Grooming column as a
// gray draft to groom later.
async function submitBrief(run) {
  const idea = $('#brief-text').value.trim();
  const repoId = $('#brief-repo').value;
  if (!idea) { toast('Describe your idea first'); return; }
  if (!briefEditingId && !repoId) { toast('Add a repository first'); return; }
  const fields = {
    idea,
    model: $('#brief-model').value,
    branchName: $('#brief-branch').value.trim(),
    target: $('#brief-target').value,
  };
  try {
    let grooming;
    if (briefEditingId) {
      grooming = await api('PATCH', `/api/groomings/${briefEditingId}`, fields);
      if (run) grooming = await api('POST', `/api/groomings/${grooming.id}/run`);
    } else {
      grooming = await api('POST', '/api/groomings', { ...fields, repoId, run: !!run });
    }
    state.groomings.set(grooming.id, grooming);
    $('#modal-brief').classList.add('hidden');
    briefEditingId = null;
    renderBoard();
    if (run) {
      toast('Grooming your idea into tasks…', 'info');
      openGroomingDrawer(grooming.id);
    }
  } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-brief').addEventListener('click', () => openBriefModal());
  $('#brief-cancel').addEventListener('click', () => $('#modal-brief').classList.add('hidden'));
  $('#brief-submit').addEventListener('click', () => submitBrief(true));
  $('#brief-draft').addEventListener('click', () => submitBrief(false));
  $('#brief-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitBrief(true);
  });
  $('#brief-add-repo').addEventListener('click', () => {
    $('#modal-brief').classList.add('hidden');
    openReposModal();
  });
  $('#brief-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#brief-repo').value, $('#brief-repo-branch'));
    // Re-seed from the newly picked workspace (create mode only — the picker is
    // hidden while editing an existing card).
    if (!briefEditingId) prefillBriefDefaults(null);
  });
}


export { openBriefModal, refreshBriefRepoSelect };
