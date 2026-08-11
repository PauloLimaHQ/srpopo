/* Sr. Popo — repos-modal. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { makeSortable, reorderRepos } from './workspaces.js';


// ---------- repos modal ----------
function renderRepoList() {
  const ul = $('#repo-list');
  ul.innerHTML = state.repos.length ? '' : '<li class="muted">No repositories yet.</li>';
  for (const r of state.repos) {
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.repo = r.id;
    li.innerHTML = `
        <span class="drag-handle" title="Drag to reorder" aria-hidden="true">${icon('grip-vertical')}</span>
        <span class="repo-name">${esc(r.name)}</span>
        <span class="repo-path">${esc(r.path)}</span>
        <button class="btn icon danger" title="Remove" aria-label="Remove repository">${icon('x')}</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      try { await api('DELETE', `/api/repos/${r.id}`); } catch (e) { toast(e.message); }
    });
    ul.appendChild(li);
  }
}

function openReposModal() {
  renderRepoList();
  $('#modal-repos').classList.remove('hidden');
  $('#repo-path').focus();
}

async function addRepo(path) {
  const p = String(path || '').trim();
  if (!p) return;
  try {
    await api('POST', '/api/repos', { path: p });
    $('#repo-path').value = '';
  } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-repos').addEventListener('click', openReposModal);
  $('#repos-close').addEventListener('click', () => $('#modal-repos').classList.add('hidden'));
  $('#repo-add').addEventListener('click', () => addRepo($('#repo-path').value));
  $('#repo-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#repo-add').click(); });
  makeSortable($('#repo-list'), 'li[data-repo]', 'repo', reorderRepos);
  makeSortable($('#super-view'), '.workspace-card', 'repo', reorderRepos);

  // In Electron, offer a native folder picker instead of typing the path by hand.
  if (window.srpopo && window.srpopo.isElectron) {
    const browse = $('#repo-browse');
    browse.classList.remove('hidden');
    browse.addEventListener('click', async () => {
      const picked = await window.srpopo.pickFolder();
      if (picked) await addRepo(picked);
    });
  }
}


export { openReposModal, renderRepoList };
