/* Sr. Popo — filter-bar. No build step: native ES module. */
import { $, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { onFiltersChanged, saveFilters } from './filters.js';


// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // ---------- filter bar wiring ----------
  $('#filter-search').addEventListener('input', (e) => {
    state.filters.search = e.target.value.trim().toLowerCase();
    saveFilters();
    renderBoard();
  });
  $('#filter-clear').addEventListener('click', () => {
    state.filters.search = '';
    $('#filter-search').value = '';
    onFiltersChanged();
  });
  // Press "/" to jump to the filter box (unless already typing somewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    e.preventDefault();
    $('#filter-search').focus();
  });
}

