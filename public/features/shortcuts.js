/* Sr. Popo — shortcuts. No build step: native ES module. */
import { esc } from '../core/api.js';
import { $, MOD } from '../core/state.js';
import { openPalette } from './palette.js';
import { openSettingsModal } from './settings-modal.js';
import { openTaskModal } from './task-modal.js';


// ---------- keyboard shortcuts help ----------
const SHORTCUTS = [
  { label: 'Search & commands', keys: [MOD, 'K'] },
  { label: 'New task', keys: [MOD, 'N'] },
  { label: 'Settings', keys: [MOD, ','] },
  { label: 'Filter tasks', keys: ['/'] },
  { label: 'Jump to / back from the terminal', keys: ['Ctrl', '`'] },
  { label: 'New terminal session', keys: ['Ctrl', 'Shift', '`'] },
  { label: 'Previous / next tab', keys: ['Ctrl', 'Alt', '←/→'] },
  { label: 'Close the tab in front', keys: [MOD, 'W'] },
  { label: 'Duplicate the tab in front', keys: [MOD, 'D'] },
  { label: 'Submit the open form', keys: [MOD, '↵'] },
  { label: 'Close dialog / drawer', keys: ['esc'] },
  { label: 'This help', keys: ['?'] },
];

function openShortcutsModal() { $('#modal-shortcuts').classList.remove('hidden'); }

// A blocking modal already covers the screen — don't stack a second one on top.
const modalOpen = () => !!document.querySelector('.modal:not(.hidden)');

// Load-time wiring. Called from app.js in the original source order.
export function init() {
  $('#shortcuts-list').innerHTML = SHORTCUTS.map((s) => `
    <li><span class="shortcut-label">${esc(s.label)}</span>
      <span class="kbd-group">${s.keys.map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span>
    </li>`).join('');
  $('#shortcuts-close').addEventListener('click', () => $('#modal-shortcuts').classList.add('hidden'));

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!modalOpen()) openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!modalOpen()) openTaskModal();
      return;
    }
    if (e.key === '?' && !mod && !e.altKey) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      e.preventDefault();
      if (!modalOpen()) openShortcutsModal();
      return;
    }
    // Cmd/Ctrl+, opens Settings — the platform-standard shortcut (⌘, on macOS).
    if (e.key === ',' && mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if ($('#modal-settings').classList.contains('hidden')) openSettingsModal();
    }
  });
}


export { modalOpen, openShortcutsModal };
