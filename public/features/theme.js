/* Sr. Popo — theme. No build step: native ES module. */
import { toast } from '../core/api.js';
import { $ } from '../core/state.js';
import { renderSidebar } from './sidebar.js';


// ---------- theme ----------
// System / Light / Dark, chosen in Settings → General → Appearance (there's no
// top-bar toggle — the header is for board actions). It stays a device-local
// preference in localStorage rather than a db.json setting, so the desktop app
// and a phone paired over the LAN can differ; the same value is read by an
// inline <head> script so the first paint already matches. cycleTheme() backs
// the command palette entry and the Electron menu item.
const THEME_KEY = 'srpopo.theme';
const THEME_CYCLE = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

function currentTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch { return 'system'; }
}
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try {
    if (mode === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, mode);
  } catch { /* storage unavailable — non-fatal */ }
  const select = $('#setting-theme');
  if (select) select.value = mode;
}
function cycleTheme() {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme()) + 1) % THEME_CYCLE.length];
  applyTheme(next);
  toast(`Theme: ${THEME_LABEL[next]}`, 'info');
}
function initTheme() {
  applyTheme(currentTheme());
  $('#setting-theme').addEventListener('change', (e) => applyTheme(e.target.value));
}

// ---------- layout (appearance) ----------
// Two shells for the same board, chosen in Settings → General → Appearance:
// 'classic' is the Super View grid plus one repo's board, unchanged; 'sidebar'
// (experimental) adds the persistent project rail rendered above. Device-local
// in localStorage like the theme, so the desktop app and a phone on the LAN can
// each pick their own — it never reaches db.json.
const LAYOUT_KEY = 'srpopo.layout';
const LAYOUTS = ['classic', 'sidebar'];
const LAYOUT_LABEL = { classic: 'Classic board', sidebar: 'Project sidebar' };

function currentLayout() {
  try {
    return LAYOUTS.includes(localStorage.getItem(LAYOUT_KEY)) ? localStorage.getItem(LAYOUT_KEY) : 'classic';
  } catch { return 'classic'; }
}
function applyLayout(mode) {
  const layout = LAYOUTS.includes(mode) ? mode : 'classic';
  document.body.dataset.layout = layout;
  try {
    if (layout === 'classic') localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, layout);
  } catch { /* storage unavailable — non-fatal */ }
  const sidebar = $('#sidebar');
  sidebar.classList.toggle('hidden', layout !== 'sidebar');
  // Nothing of the rail survives the classic layout — drop the markup so a
  // stale list can't flash on the way back in.
  if (layout === 'sidebar') renderSidebar();
  else sidebar.innerHTML = '';
  const select = $('#setting-layout');
  if (select) select.value = layout;
}
function toggleLayout() {
  const next = currentLayout() === 'sidebar' ? 'classic' : 'sidebar';
  applyLayout(next);
  toast(`Layout: ${LAYOUT_LABEL[next]}`, 'info');
}
function initLayout() {
  applyLayout(currentLayout());
  $('#setting-layout').addEventListener('change', (e) => applyLayout(e.target.value));
}

export { LAYOUT_LABEL, THEME_LABEL, currentLayout, currentTheme, cycleTheme, initLayout, initTheme, toggleLayout };
