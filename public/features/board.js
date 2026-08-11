/* Sr. Popo — board. No build step: native ES module. */
import { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, ORCH_COLUMN, isGroomingLive, isLive, isOrchestrationLive, state } from '../core/state.js';
import { renderCard, renderGroomingCard, renderOrchestrationCard } from './cards.js';
import { onDrop } from './dnd.js';
import { filtersActive, groomingMatchesFilters, groomingsForRepo, orchestrationMatchesFilters, orchestrationsForRepo, taskMatchesFilters, tasksForRepo, updateFilterMeta } from './filters.js';
import { pluginInstalled } from './settings.js';
import { renderSidebar } from './sidebar.js';
import { renderSuperView } from './workspaces.js';


// ---------- board ----------
// The single choke point every "something changed" handler calls. Outside a
// workspace there's no board to draw — refresh the Super View instead so its
// per-repo stats (graph, live badge, task count) stay live.
function renderBoard() {
  // The experimental project sidebar lists the same cards, so it refreshes off
  // the same choke point (a no-op in the classic layout).
  renderSidebar();
  if (state.view.mode !== 'workspace') { renderSuperView(); return; }
  updateFilterMeta();
  const board = $('#board');
  board.innerHTML = '';
  const repoTasks = tasksForRepo(state.view.repoId);
  const repoGroomings = groomingsForRepo(state.view.repoId);
  const repoOrchestrations = orchestrationsForRepo(state.view.repoId);

  // Grooming leads the board. It's part of the process but has its own
  // lifecycle, so the column is locked: no drag in, no drag out. Shown when
  // the Idea Grooming plugin is installed, or when cards already exist (e.g.
  // a Linear import, or cards from before the plugin was uninstalled).
  if (pluginInstalled('grooming') || repoGroomings.length) {
    const groomings = repoGroomings
      .filter(groomingMatchesFilters)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const colEl = document.createElement('div');
    colEl.className = 'column grooming-column';
    colEl.dataset.col = GROOMING_COLUMN.key;
    colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${GROOMING_COLUMN.dot}"></span>
          ${GROOMING_COLUMN.label}
          <span class="count">${groomings.length}</span>
        </div>
        <div class="column-body"></div>`;
    const body = colEl.querySelector('.column-body');
    if (!groomings.length) {
      body.innerHTML = `<div class="column-empty">${filtersActive() ? 'no matches' : 'brief an idea to fill this'}</div>`;
    }
    for (const g of groomings) body.appendChild(renderGroomingCard(g));
    board.appendChild(colEl);
  }

  // Orchestration sits next to Grooming: also part of the process, also its
  // own lifecycle, also locked (no drag in, no drag out). Shown when the Goal
  // Orchestration plugin is installed, or when cards already exist.
  if (pluginInstalled('orchestration') || repoOrchestrations.length) {
    const orchestrations = repoOrchestrations
      .filter(orchestrationMatchesFilters)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const colEl = document.createElement('div');
    colEl.className = 'column orch-column';
    colEl.dataset.col = ORCH_COLUMN.key;
    colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${ORCH_COLUMN.dot}"></span>
          ${ORCH_COLUMN.label}
          <span class="count">${orchestrations.length}</span>
        </div>
        <div class="column-body"></div>`;
    const body = colEl.querySelector('.column-body');
    if (!orchestrations.length) {
      body.innerHTML = `<div class="column-empty">${filtersActive() ? 'no matches' : 'orchestrate a goal to fill this'}</div>`;
    }
    for (const o of orchestrations) body.appendChild(renderOrchestrationCard(o));
    board.appendChild(colEl);
  }

  for (const col of COLUMNS) {
    const tasks = repoTasks
      .filter((t) => COLUMN_OF_STATUS[t.status] === col.key)
      .filter(taskMatchesFilters)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    // The running column's count doubles as a live view of the parallel-session
    // cap (dispatched runs + grooming share the same claude-process budget —
    // see runner.runningCount), so a user can tell at a glance why a dispatch
    // was rejected without opening Settings.
    const max = state.settings.maxParallelSessions;
    const liveCount = [...state.tasks.values()].filter(isLive).length +
      [...state.groomings.values()].filter(isGroomingLive).length +
      [...state.orchestrations.values()].filter(isOrchestrationLive).length;
    const countLabel = col.key === 'running' && max ? `${liveCount}/${max}` : tasks.length;

    const colEl = document.createElement('div');
    colEl.className = 'column';
    colEl.dataset.col = col.key;
    colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${col.dot}"></span>
          ${col.label}
          <span class="count" ${col.key === 'running' && max ? `title="${liveCount} of ${max} parallel sessions in use (running + grooming + orchestration)"` : ''}>${countLabel}</span>
        </div>
        <div class="column-body"></div>`;
    const body = colEl.querySelector('.column-body');

    if (!tasks.length) {
      const hint = filtersActive() ? 'no matches'
        : col.key === 'running' ? 'drag a card here to dispatch'
        : col.key === 'code_review' ? 'drop a card with an open PR here'
        : 'empty';
      body.innerHTML = `<div class="column-empty">${hint}</div>`;
    }
    for (const t of tasks) body.appendChild(renderCard(t));

    colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      onDrop(e.dataTransfer.getData('text/task-id'), col.key);
    });
    board.appendChild(colEl);
  }
}

export { renderBoard };
