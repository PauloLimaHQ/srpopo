/* Sr. Popo — ask. No build step: native ES module. */
import { api, esc, mdToHtml, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { openReposModal } from './repos-modal.js';
import { loadLastUsed } from './task-modal.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- ask sr. popo (free-form Q&A about a repo) ----------
function refreshAskRepoSelect() {
  const sel = $('#ask-repo');
  sel.innerHTML = state.repos.length
    ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
    : '<option value="">No repos yet — add one first</option>';
}

function setAskRunning(running) {
  $('#ask-submit').classList.toggle('hidden', running);
  $('#ask-stop').classList.toggle('hidden', !running);
  $('#ask-repo').disabled = running;
  $('#ask-text').disabled = running;
}

function openAskModal() {
  refreshAskRepoSelect();
  const last = loadLastUsed();
  if (currentWorkspaceRepoId()) $('#ask-repo').value = currentWorkspaceRepoId();
  else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#ask-repo').value = last.repoId;
  $('#ask-text').value = '';
  $('#ask-answer').classList.add('hidden');
  $('#ask-answer').innerHTML = '';
  setAskRunning(false);
  $('#modal-ask').classList.remove('hidden');
  $('#ask-text').focus();
}

// Kick off a read-only ask session (server/ask.ts, runner.ask). The session is
// ephemeral — the response is just an id — so the answer streams back over the
// normal SSE bus: `log` events (assistant text) keyed by that id while it runs,
// then a single `ask` event with the final answer (see connectSSE below).
async function submitAsk() {
  const question = $('#ask-text').value.trim();
  const repoId = $('#ask-repo').value;
  if (!question) { toast('Ask a question first'); return; }
  if (!repoId) { toast('Add a repository first'); return; }
  state.askText = '';
  $('#ask-answer').classList.remove('hidden', 'error');
  $('#ask-answer').innerHTML = `<div class="ask-status">${icon('loader', { spin: true })}Thinking…</div>`;
  setAskRunning(true);
  try {
    const { askId } = await api('POST', `/api/repos/${repoId}/ask`, { question });
    state.askId = askId;
  } catch (e) {
    state.askId = null;
    setAskRunning(false);
    $('#ask-answer').classList.add('error');
    $('#ask-answer').textContent = e.message;
  }
}

// Streams the session's assistant text into the answer area as it arrives.
function appendAskEvent(ev) {
  if (ev.type !== 'assistant') return;
  const blocks = (ev.message && ev.message.content) || [];
  for (const b of blocks) {
    if (b.type !== 'text' || !b.text || !b.text.trim()) continue;
    state.askText = state.askText ? `${state.askText}\n\n${b.text}` : b.text;
    $('#ask-answer').innerHTML = mdToHtml(state.askText);
  }
}

// The session's terminal broadcast (see runner.ask's resolveExit) — renders the
// full answer (or the error) and cost, and clears the in-flight session id.
function finishAsk(msg) {
  if (msg.askId !== state.askId) return;
  state.askId = null;
  setAskRunning(false);
  const box = $('#ask-answer');
  box.classList.toggle('error', !msg.ok);
  const answer = msg.answer || (msg.ok ? '(no answer)' : 'Ask failed');
  box.innerHTML = `<div>${mdToHtml(answer)}</div>` +
    (msg.ok ? `<div class="ask-cost">$${(msg.costUsd || 0).toFixed(2)}</div>` : '');
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-ask').addEventListener('click', () => openAskModal());
  $('#ask-cancel').addEventListener('click', () => $('#modal-ask').classList.add('hidden'));
  $('#ask-add-repo').addEventListener('click', () => {
    $('#modal-ask').classList.add('hidden');
    openReposModal();
  });
  $('#ask-submit').addEventListener('click', submitAsk);
  $('#ask-stop').addEventListener('click', async () => {
    if (!state.askId) return;
    try { await api('POST', `/api/asks/${state.askId}/stop`); } catch (e) { toast(e.message); }
  });
  $('#ask-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAsk();
  });
}


export { appendAskEvent, finishAsk };
