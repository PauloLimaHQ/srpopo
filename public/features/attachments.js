/* Sr. Popo — attachments. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { addFiles, editingTaskId, renderAttachments, setSavedAttachments, stagedFiles, stagedPreviews } from './task-modal.js';


// Files can be dropped anywhere on the modal — the composer lights up to show
// where they land. Only file drags count, so dragging text around the prompt
// doesn't flash the overlay. The depth counter survives dragenter/dragleave
// firing once per nested child element.
function dragHasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}
const taskComposer = $('#task-composer');
let taskDragDepth = 0;
function stopDropping() {
  taskDragDepth = 0;
  taskComposer.classList.remove('dropping');
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // ---------- attachments (picker + drop-on-the-prompt + paste) ----------
  $('#task-add-files').addEventListener('click', () => $('#task-file-input').click());
  $('#task-file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // let the same file be re-picked later
  });
  $('#modal-task').addEventListener('dragenter', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    taskDragDepth++;
    taskComposer.classList.add('dropping');
  });
  // Without a preventDefault on dragover the browser refuses the drop (and a
  // miss would navigate the whole window to the dropped file).
  $('#modal-task').addEventListener('dragover', (e) => { if (dragHasFiles(e)) e.preventDefault(); });
  $('#modal-task').addEventListener('dragleave', () => { if (--taskDragDepth <= 0) stopDropping(); });
  $('#modal-task').addEventListener('drop', (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    stopDropping();
    addFiles(e.dataTransfer.files);
  });
  // Paste a screenshot straight into the prompt: attach it instead of letting
  // the textarea swallow the paste.
  $('#task-prompt').addEventListener('paste', (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files);
  });

  // Remove an attachment: staged files drop from the list; saved ones hit the delete route.
  $('#task-attachment-list').addEventListener('click', async (e) => {
    const staged = e.target.closest('[data-remove-staged]');
    if (staged) {
      const [file] = stagedFiles.splice(Number(staged.dataset.removeStaged), 1);
      const url = stagedPreviews.get(file);
      if (url) { URL.revokeObjectURL(url); stagedPreviews.delete(file); }
      renderAttachments();
      return;
    }
    const saved = e.target.closest('[data-remove-saved]');
    if (saved && editingTaskId) {
      const name = saved.dataset.removeSaved;
      try {
        const task = await api('DELETE', `/api/tasks/${editingTaskId}/attachments/${encodeURIComponent(name)}`);
        state.tasks.set(task.id, task);
        renderBoard();
        setSavedAttachments(task.attachments || []);
        renderAttachments();
      } catch (err) { toast(err.message); }
    }
  });
}

