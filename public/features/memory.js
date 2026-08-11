/* Sr. Popo — memory. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { closeWorkspaceMenu } from './workspace-menu.js';


// ---------- project memory ----------
// A private, per-repo markdown document (see server/memory.ts) distilled in
// the background after each finished task. Pull-based — fetched fresh each
// time the modal opens rather than kept live via SSE, so an in-progress edit
// is never clobbered by a background distill landing mid-edit.
async function openMemoryModal(repoId) {
  $('#modal-memory').classList.remove('hidden');
  $('#memory-content').value = '';
  $('#memory-content').dataset.repoId = repoId;
  $('#memory-updated-at').textContent = 'Loading…';
  try {
    const { content, updatedAt } = await api('GET', `/api/repos/${repoId}/memory`);
    $('#memory-content').value = content;
    $('#memory-updated-at').textContent = updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : 'No memory recorded yet';
  } catch (e) {
    $('#memory-updated-at').textContent = '';
    toast(e.message || 'Failed to load project memory', 'error');
  }
}

async function saveMemoryModal() {
  const repoId = $('#memory-content').dataset.repoId;
  if (!repoId) return;
  try {
    const { updatedAt } = await api('PUT', `/api/repos/${repoId}/memory`, { content: $('#memory-content').value });
    $('#memory-updated-at').textContent = updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : '';
    toast('Project memory saved', 'info');
  } catch (e) {
    toast(e.message || 'Failed to save project memory', 'error');
  }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#workspace-memory').addEventListener('click', () => {
    closeWorkspaceMenu();
    const repoId = state.view.repoId;
    if (repoId) openMemoryModal(repoId);
  });
  $('#memory-close').addEventListener('click', () => $('#modal-memory').classList.add('hidden'));
  $('#memory-save').addEventListener('click', saveMemoryModal);
}


export { openMemoryModal };
