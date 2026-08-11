/* Sr. Popo — grooming. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { openGroomingDrawer } from './drawer.js';
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

function openBriefModal(grooming = null) {
  // Guard: the header button passes its click event here — treat it as "new".
  if (!grooming || !grooming.id) grooming = null;
  briefEditingId = grooming ? grooming.id : null;
  refreshBriefRepoSelect();
  const last = loadLastUsed();
  $('#brief-text').value = grooming ? grooming.idea : '';
  $('#brief-branch').value = grooming ? (grooming.branchName || '') : '';
  $('#brief-target').value = grooming ? (grooming.target || 'backlog') : 'backlog';
  $('#brief-model').value = grooming ? (grooming.model || 'default') : (last.model || 'default');
  // The repo is fixed once the card exists — hide the picker in edit mode.
  $('#brief-repo-field').classList.toggle('hidden', !!grooming);
  if (grooming) $('#brief-repo').value = grooming.repoId;
  else if (currentWorkspaceRepoId()) $('#brief-repo').value = currentWorkspaceRepoId();
  else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#brief-repo').value = last.repoId;
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
  });
}


export { openBriefModal, refreshBriefRepoSelect };
