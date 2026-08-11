/* Sr. Popo — deeplinks. No build step: native ES module. */
import { state } from '../core/state.js';
import { openDrawer } from './drawer.js';


// ---------- deep links (#task/<id>) ----------
// Lets the native tray menu open a specific task in the drawer.
function handleHashDeeplink() {
  const m = location.hash.match(/^#task\/([a-z0-9]+)$/i);
  if (m && state.tasks.has(m[1])) openDrawer(m[1]);
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {
  window.addEventListener('hashchange', handleHashDeeplink);
}


export { handleHashDeeplink };
