/* Sr. Popo — orchestrate. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { openOrchestrationDrawer } from './drawer.js';
import { openReposModal } from './repos-modal.js';
import { pluginInstalled } from './settings.js';
import { loadLastUsed, refreshRepoBranchHint } from './task-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- orchestrate a goal ----------
function refreshOrchRepoSelect() {
  const sel = $('#orchestrate-repo');
  if (!sel) return;
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

// null => new orchestration; a card => edit that draft (or failed card).
let orchEditingId = null;

function syncOrchAutonomousFields() {
  $('#orchestrate-autonomous-fields').classList.toggle('hidden', !$('#orchestrate-autonomous').checked);
}

// Running an existing card goes through this modal too (rather than firing a
// bare POST like grooming's "Groom" action): a run has to decide whether to
// hand execution to Autonomous Mode, and that choice belongs to the user.
function openOrchestrateModal(orchestration = null) {
  // Guard: the header button passes its click event here — treat it as "new".
  if (!orchestration || !orchestration.id) orchestration = null;
  orchEditingId = orchestration ? orchestration.id : null;
  refreshOrchRepoSelect();
  const last = loadLastUsed();
  $('#orchestrate-text').value = orchestration ? orchestration.goal : '';
  $('#orchestrate-model').value = orchestration ? (orchestration.model || 'default') : (last.model || 'default');
  // The Autonomous hand-off needs its own plugin; without it, offer manual mode only.
  const canAuto = pluginInstalled('autonomous');
  $('#orchestrate-autonomous').closest('.check').classList.toggle('hidden', !canAuto);
  $('#orchestrate-autonomous').checked = canAuto && !!orchestration && orchestration.mode === 'autonomous';
  syncOrchAutonomousFields();
  // The repo is fixed once the card exists — hide the picker in edit mode.
  $('#orchestrate-repo-field').classList.toggle('hidden', !!orchestration);
  if (orchestration) $('#orchestrate-repo').value = orchestration.repoId;
  else if (currentWorkspaceRepoId()) $('#orchestrate-repo').value = currentWorkspaceRepoId();
  else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#orchestrate-repo').value = last.repoId;
  refreshRepoBranchHint($('#orchestrate-repo').value, $('#orchestrate-repo-branch'));
  $('#orchestrate-modal-title').innerHTML = `${icon('crown')}${orchestration ? 'Edit Goal' : 'Orchestrate a Goal'}`;
  $('#orchestrate-draft').textContent = orchestration ? 'Save Draft' : 'Save as Draft';
  $('#modal-orchestrate').classList.remove('hidden');
  $('#orchestrate-text').focus();
}

// The Autonomous hand-off config to send along with a run, or undefined for
// plain manual mode (the orchestrator dispatches its own tasks).
function orchAutonomousPayload() {
  if (!$('#orchestrate-autonomous').checked) return undefined;
  const budgetUsd = Number($('#orchestrate-budget').value);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('Enter an autonomous budget greater than 0');
  return { budgetUsd, reviewMode: $('#orchestrate-review-mode').checked };
}

// Create (or update) an orchestration card. `run` starts the orchestrator
// session right away; otherwise the card is parked as a gray draft.
async function submitOrchestrate(run) {
  const goal = $('#orchestrate-text').value.trim();
  const repoId = $('#orchestrate-repo').value;
  if (!goal) { toast('Describe your goal first'); return; }
  if (!orchEditingId && !repoId) { toast('Add a repository first'); return; }
  let autonomousOpts;
  try { autonomousOpts = run ? orchAutonomousPayload() : undefined; }
  catch (e) { toast(e.message); return; }
  const fields = { goal, model: $('#orchestrate-model').value };
  try {
    let orchestration;
    if (orchEditingId) {
      orchestration = await api('PATCH', `/api/orchestrations/${orchEditingId}`, fields);
      if (run) orchestration = await api('POST', `/api/orchestrations/${orchestration.id}/run`, { autonomous: autonomousOpts });
    } else {
      orchestration = await api('POST', '/api/orchestrations', { ...fields, repoId, run: !!run, autonomous: autonomousOpts });
    }
    state.orchestrations.set(orchestration.id, orchestration);
    $('#modal-orchestrate').classList.add('hidden');
    orchEditingId = null;
    renderBoard();
    if (run) {
      toast('Planning your goal into worker tasks…', 'info');
      openOrchestrationDrawer(orchestration.id);
    }
  } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-orchestrate').addEventListener('click', () => openOrchestrateModal());
  $('#orchestrate-cancel').addEventListener('click', () => $('#modal-orchestrate').classList.add('hidden'));
  $('#orchestrate-submit').addEventListener('click', () => submitOrchestrate(true));
  $('#orchestrate-draft').addEventListener('click', () => submitOrchestrate(false));
  $('#orchestrate-autonomous').addEventListener('change', syncOrchAutonomousFields);
  $('#orchestrate-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitOrchestrate(true);
  });
  $('#orchestrate-add-repo').addEventListener('click', () => {
    $('#modal-orchestrate').classList.add('hidden');
    openReposModal();
  });
  $('#orchestrate-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#orchestrate-repo').value, $('#orchestrate-repo-branch'));
  });
}


export { openOrchestrateModal, refreshOrchRepoSelect };
