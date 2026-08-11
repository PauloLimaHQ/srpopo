/* Sr. Popo — remote. No build step: native ES module. */
import { esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { saveSettings } from './settings-modal.js';


// ---------- remote access (LAN) ----------
const remoteAccessOn = () => !!state.settings.remoteAccess;

// Fetch the raw token + pairing URL(s) from the localhost-only endpoint. A
// browser that reached us over the LAN gets a 403 → returns null (it doesn't
// need the pairing info; it's already paired). Toggling remote access on
// re-binds the server, briefly dropping connections, so a transient failure is
// retried a couple of times before giving up.
async function fetchRemoteInfo() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('/api/remote-access');
      if (res.status === 403) return null; // remote (already-paired) client
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 400)); // ride out the re-bind window
    }
  }
  return null;
}

// Reflect the current toggle state, then — when enabled — render the token +
// pairing URL(s). The secret never rides in state.settings (it's not in
// publicSettings), so we ask for it here on demand.
async function renderRemoteAccess() {
  const on = remoteAccessOn();
  $('#setting-remote-access').checked = on;
  $('#remote-warning').classList.toggle('hidden', !on);
  const pairing = $('#remote-pairing');
  pairing.classList.toggle('hidden', !on);
  if (!on) return;
  let info;
  try {
    info = await fetchRemoteInfo();
  } catch {
    pairing.classList.add('hidden');
    return;
  }
  if (!info) { pairing.classList.add('hidden'); return; } // remote client
  const urlsBox = $('#remote-urls');
  const noLan = $('#remote-no-lan');
  const urls = Array.isArray(info.urls) ? info.urls : (info.url ? [info.url] : []);
  if (!urls.length) {
    urlsBox.innerHTML = '';
    noLan.textContent = 'No local network address was found. Connect this machine to Wi-Fi or a LAN, then reopen this pane.';
    noLan.classList.remove('hidden');
    return;
  }
  noLan.classList.add('hidden');
  urlsBox.innerHTML = urls.map((u) => `
      <div class="remote-url">
        <code>${esc(u)}</code>
        <button class="btn ghost icon remote-copy" data-url="${esc(u)}" title="Copy link" aria-label="Copy link">${icon('copy')}</button>
      </div>`).join('');
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#setting-remote-access').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (enabled && !confirm(
      'Enable remote access?\n\nSr. Popo will be reachable from other devices on your ' +
      'local network. Anyone with the link and token can control your tasks and repos. ' +
      'Only do this on a network you trust.')) {
      e.target.checked = false;
      return;
    }
    await saveSettings({ remoteAccess: enabled });
    await renderRemoteAccess();
  });

  $('#remote-regen').addEventListener('click', async () => {
    if (!confirm('Regenerate the access token? Every currently-paired device will be signed out.')) return;
    await saveSettings({ regenerateRemoteToken: true });
    await renderRemoteAccess();
    toast('Access token regenerated', 'info');
  });

  $('#remote-urls').addEventListener('click', async (e) => {
    const btn = e.target.closest('.remote-copy');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.url);
      toast('Link copied', 'info');
    } catch {
      toast('Could not copy — select and copy the link manually');
    }
  });
}


export { renderRemoteAccess };
