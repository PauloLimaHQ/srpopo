/* Sr. Popo — followup. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';


// ---------- follow-up ----------
async function sendFollowup(taskId, message) {
  if (!message.trim()) return;
  await api('POST', `/api/tasks/${taskId}/dispatch`, { message });
}

let followupTarget = null;
function openFollowupModal(t) {
  followupTarget = t;
  $('#followup-modal-sub').textContent = `“${t.title}” already has a session — describe what to do next and it will resume where it left off.`;
  $('#followup-modal-input').value = '';
  $('#modal-followup').classList.remove('hidden');
  $('#followup-modal-input').focus();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#followup-send').addEventListener('click', async () => {
    const input = $('#followup-input');
    try {
      await sendFollowup(state.openTaskId, input.value);
      input.value = '';
    } catch (e) { toast(e.message); }
  });
  $('#followup-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#followup-send').click();
  });
  $('#followup-modal-cancel').addEventListener('click', () => $('#modal-followup').classList.add('hidden'));
  $('#followup-modal-send').addEventListener('click', async () => {
    try {
      await sendFollowup(followupTarget.id, $('#followup-modal-input').value);
      $('#modal-followup').classList.add('hidden');
    } catch (e) { toast(e.message); }
  });
  $('#followup-modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#followup-modal-send').click();
  });
}


export { openFollowupModal };
