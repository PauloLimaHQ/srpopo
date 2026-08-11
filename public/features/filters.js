/* Sr. Popo — filters. No build step: native ES module. */
import { $, state } from '../core/state.js';
import { renderBoard } from './board.js';


// ---------- filters ----------
// Inside a workspace there is only one repo in scope (state.view.repoId), so
// the only filter left to apply is the free-text search over title/repo/prompt.
function taskMatchesFilters(t) {
  const f = state.filters;
  if (f.search) {
    const hay = `${t.title} ${t.repoName} ${t.prompt || ''}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

const filtersActive = () => !!state.filters.search;

const FILTER_KEY = 'srpopo.filters';
function saveFilters() {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ search: state.filters.search }));
  } catch { /* storage unavailable — non-fatal */ }
}
function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
    state.filters.search = (f.search || '').toLowerCase();
  } catch { /* ignore malformed storage */ }
}

function onFiltersChanged() {
  saveFilters();
  renderBoard();
}

// Tasks scoped to the workspace currently open (empty outside a workspace).
function tasksForRepo(repoId) {
  return [...state.tasks.values()].filter((t) => t.repoId === repoId);
}

// Grooming cards scoped to a workspace, same idea as tasksForRepo.
function groomingsForRepo(repoId) {
  return [...state.groomings.values()].filter((g) => g.repoId === repoId);
}

function groomingMatchesFilters(g) {
  const f = state.filters;
  if (f.search) {
    const hay = `${g.title} ${g.repoName} ${g.idea || ''}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

// Orchestration cards scoped to a workspace, same idea as groomingsForRepo.
function orchestrationsForRepo(repoId) {
  return [...state.orchestrations.values()].filter((o) => o.repoId === repoId);
}

function orchestrationMatchesFilters(o) {
  const f = state.filters;
  if (f.search) {
    const hay = `${o.title} ${o.repoName} ${o.goal || ''}`.toLowerCase();
    if (!hay.includes(f.search)) return false;
  }
  return true;
}

function updateFilterMeta() {
  const all = tasksForRepo(state.view.repoId);
  const shown = all.filter(taskMatchesFilters).length;
  $('#filter-count').textContent = filtersActive() ? `${shown} of ${all.length}` : `${all.length} tasks`;
  $('#filter-clear').classList.toggle('hidden', !filtersActive());
}

export { filtersActive, groomingMatchesFilters, groomingsForRepo, loadFilters, onFiltersChanged, orchestrationMatchesFilters, orchestrationsForRepo, saveFilters, taskMatchesFilters, tasksForRepo, updateFilterMeta };
