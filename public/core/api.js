/* Sr. Popo — api. No build step: native ES module. */
import { $, icon } from './state.js';


// ---------- api ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the status so a caller can branch on it (e.g. "no editor picked
    // yet" → open the picker instead of toasting); most just read .message.
    const e = new Error(data.error || `${method} ${url} failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data;
}

function toast(msg, type = 'error') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Persistent "update ready" banner (Electron only) — unlike toast() above it
// does not auto-dismiss; it stays until the user relaunches.
function showUpdateBanner(version) {
  $('#update-downloading')?.remove(); // the download it announced is done
  if ($('#update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'toast info update-banner';
  el.innerHTML =
    `${icon('rotate-cw')}` +
    `<span>Sr. Popo${version ? ` v${esc(version)}` : ''} is downloaded and ready — relaunch to update.</span>` +
    `<button class="btn primary" id="update-banner-btn">Relaunch to update</button>`;
  $('#toasts').appendChild(el);
  $('#update-banner-btn').addEventListener('click', () => window.srpopo.restartToUpdate());
}

// Downloading an update takes a while and used to be silent. Say so once per
// version — the flag is remembered so a board reload (or a re-check four hours
// later) doesn't nag about the same download again.
function showUpdateDownloading(version) {
  const key = `srpopo:update-downloading-seen:${version || 'unknown'}`;
  if ($('#update-banner') || $('#update-downloading')) return;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
  } catch (_) { /* private mode: just show it */ }
  const el = document.createElement('div');
  el.id = 'update-downloading';
  el.className = 'toast info update-banner';
  el.innerHTML =
    `${icon('download')}` +
    `<span>Downloading Sr. Popo${version ? ` v${esc(version)}` : ''} in the background — once it finishes you'll be able to relaunch to update.</span>` +
    `<button class="btn ghost" id="update-downloading-dismiss">Got it</button>`;
  $('#toasts').appendChild(el);
  $('#update-downloading-dismiss').addEventListener('click', () => el.remove());
}

// A downloaded update couldn't be applied automatically (e.g. an ad-hoc-
// signed macOS build failing Squirrel.Mac's signature check) — offer a
// manual download instead of a Relaunch button that would do nothing.
function showUpdateInstallFailed(releasesUrl) {
  $('#update-banner')?.remove();
  $('#update-downloading')?.remove();
  if ($('#update-install-failed')) return;
  const el = document.createElement('div');
  el.id = 'update-install-failed';
  el.className = 'toast info update-banner';
  el.innerHTML =
    `${icon('download')}` +
    `<span>Sr. Popo downloaded an update but couldn't install it automatically on this build — grab it manually.</span>` +
    `<a class="btn primary" href="${esc(releasesUrl)}" target="_blank" rel="noopener">Download update</a>` +
    `<button class="btn ghost" id="update-install-failed-dismiss">Dismiss</button>`;
  $('#toasts').appendChild(el);
  $('#update-install-failed-dismiss').addEventListener('click', () => el.remove());
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Extra class for the model chip so each model gets its own color, tiered by
// cost (fable reads red — the most expensive). Matches both the short alias
// the user picked ("opus") and a resolved model id ("claude-opus-4-8").
const modelClass = (name) => {
  const n = String(name || '').toLowerCase();
  for (const m of ['fable', 'opus', 'sonnet', 'haiku']) if (n.includes(m)) return ` model-${m}`;
  return '';
};

// Read `key` out of a plain object map without falling through to
// Object.prototype, so an unexpected key ('constructor', 'toString', …) misses
// instead of resolving to an inherited member.
const lookup = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null);

// Which backend a task runs on. Tasks created before the field existed have no
// `agent`, and those are Claude — so read it through here, never raw.
const agentOf = (t) => (t && t.agent) || 'claude';

// How the board labels each non-default backend (Claude cards stay unbadged, as
// they were before there was more than one backend).
const AGENT_BADGE = {
  codex: { label: 'Codex', icon: 'cpu', title: 'Runs on the OpenAI Codex CLI' },
  grok: { label: 'Grok', icon: 'cpu', title: 'Runs on the xAI Grok CLI' },
};
const agentBadge = (t) => lookup(AGENT_BADGE, agentOf(t));

// Only Claude can ask the board to approve a tool mid-run: the interactive
// permission bridge is a `claude` CLI feature (--permission-prompt-tool, see
// server/permissions.ts). Codex is governed by its sandbox and Grok by its
// permission mode plus allow rules, and neither has an approval hook to route
// here — so the Allow/Deny prompts, the "asks" chip and AUTO MODE are all
// Claude-only. One predicate so those three can never drift apart.
const hasPermissionBridge = (t) => agentOf(t) === 'claude';

// Input + output tokens accumulated across a task's runs (task.modelUsage is
// keyed by model; every backend populates it — see server/usage.ts).
const totalTokens = (t) =>
  Object.values(t.modelUsage || {}).reduce((n, m) => n + (m.inputTokens || 0) + (m.outputTokens || 0), 0);

// Does this task's spend have to be shown as tokens instead of dollars? Codex
// subscription runs never report a dollar cost, and Grok's OAuth path usually
// doesn't either (it stamps cost for API-key traffic, and drops every cost
// float when a turn's cost was only partial). An absent cost means "unreported",
// never "free" — so show "—" plus the token total, never a misleading $0.
const tokensOnly = (t) => agentOf(t) === 'codex' || (agentOf(t) === 'grok' && !(t.costUsd > 0));
// Compact token count, e.g. 12345 -> "12.3k".
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Placeholder standing in for a chunk we lift out of the markdown source before
// escaping the rest (a fenced block, a code span). Delimited by a private-use
// code point so it can never collide with real text — and, unlike the
// space-delimited marker this used to use, never eats the space next to it:
// "the `foo` file" was rendering as "the<code>foo</code> file".
const MD_HOLE = (kind, i) => `\uE000${kind}${i}\uE000`;

// Lift every `code span` out of the source, rendering it into `out` and leaving
// a placeholder behind. Done up front, before the text is split into lines, so a
// span that wraps across a line break still comes out as one <code>.
const mdLiftCode = (src, out) => String(src ?? '').replace(/`([^`]+)`/g, (_, c) => {
  out.push(`<code>${esc(c.replace(/\s*\n\s*/g, ' '))}</code>`);
  return MD_HOLE('S', out.length - 1);
});

// Escape one line of already-lifted markdown, then render its links and
// emphasis. Escaping here is what keeps the tags we generate the only markup in
// the output — the markdown source never injects its own.
const mdEmphasis = (line) => esc(line)
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');

// Put the lifted code spans back, once the markup around them has settled.
const mdDropCode = (html, spans) => html.replace(/\uE000S(\d+)\uE000/g, (m, i) => spans[Number(i)] ?? m);

// Inline-only markdown: code spans, links, bold, italics. Use for a one-line
// string that shouldn't grow block markup (a clarifying question, a blocker).
function mdInline(src) {
  const spans = [];
  return mdDropCode(mdEmphasis(mdLiftCode(src, spans)), spans);
}

// Small, dependency-free markdown → HTML for agent-authored text and framed
// prompts (headings, nested lists, code fences/spans, quotes, bold/italic,
// links). Same escaping contract as mdInline.
function mdToHtml(src) {
  // Drop the shared leading indentation of a fenced block (a fence nested under
  // a bullet is indented in the source, not in the code it shows).
  const dedent = (code) => {
    const lines = code.replace(/\s+$/, '').split('\n');
    const body = lines.filter((l) => l.trim());
    if (!body.length) return '';
    const pad = Math.min(...body.map((l) => l.match(/^ */)[0].length));
    return lines.map((l) => l.slice(pad)).join('\n');
  };
  // Fenced blocks first (their content is code, not markdown), then the code
  // spans in what's left — both out of the way before anything is split or
  // escaped.
  const codeBlocks = [];
  const spans = [];
  const text = mdLiftCode(
    // CRLF normalized first: the block patterns below are line-anchored, and a
    // trailing \r makes every one of them miss.
    String(src ?? '').replace(/\r\n?/g, '\n').replace(/```[ \t]*(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push(`<pre class="md-code"><code>${esc(dedent(code))}</code></pre>`);
      return MD_HOLE('B', codeBlocks.length - 1);
    }),
    spans,
  );

  const html = [];
  let para = [];
  // Open lists, outermost first. `indent` is the column the item's marker sat
  // at, so a deeper-indented item nests instead of ending the list. A blank
  // line never closes a list (only prose does), so bullets separated by blank
  // lines stay one loose list instead of becoming one list each.
  const lists = [];

  const indentOf = (ws) => ws.replace(/\t/g, '  ').length;
  const top = () => lists[lists.length - 1];
  const flushPara = () => { if (para.length) { html.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const closeItem = () => { if (top()?.liOpen) { html.push('</li>'); top().liOpen = false; } };
  // Close every open list indented at or past `from` (all of them by default).
  const closeLists = (from = 0) => {
    while (lists.length && top().indent >= from) { closeItem(); html.push(`</${lists.pop().tag}>`); }
  };
  const openList = (tag, indent) => { html.push(`<${tag}>`); lists.push({ tag, indent, liOpen: false }); };
  const pushItem = (tag, indent, content) => {
    flushPara();
    closeLists(indent + 1); // anything deeper than this item ends here
    if (!top()) openList(tag, indent);
    else if (indent >= top().indent + 2) openList(tag, indent); // nests inside the open <li>
    else if (top().tag !== tag) { closeLists(top().indent); openList(tag, indent); }
    else closeItem();
    html.push(`<li>${content}`);
    top().liOpen = true;
  };

  for (const line of text.split('\n')) {
    const codeRef = line.trim().match(/^\uE000B(\d+)\uE000$/);
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    const ul = line.match(/^(\s*)[-*+]\s+(.+)$/);
    const ol = line.match(/^(\s*)\d+\.\s+(.+)$/);
    const hr = /^([-*_])\1{2,}$/.test(line.trim());
    const indented = /^\s{2,}\S/.test(line);

    if (line.trim() === '') {
      flushPara();
    } else if (codeRef) {
      flushPara();
      // A fence indented under a bullet belongs to that item; one at the
      // margin ends the list.
      if (!(indented && top()?.liOpen)) closeLists();
      html.push(codeBlocks[Number(codeRef[1])]);
    } else if (heading) {
      flushPara(); closeLists();
      const level = Math.min(heading[1].length + 2, 6); // keep headings small inside a chat bubble
      html.push(`<h${level}>${mdEmphasis(heading[2])}</h${level}>`);
    } else if (hr) {
      flushPara(); closeLists(); html.push('<hr>');
    } else if (quote) {
      flushPara(); closeLists();
      html.push(`<blockquote>${mdEmphasis(quote[1])}</blockquote>`);
    } else if (ul) {
      pushItem('ul', indentOf(ul[1]), mdEmphasis(ul[2]));
    } else if (ol) {
      pushItem('ol', indentOf(ol[1]), mdEmphasis(ol[2]));
    } else if (indented && top()?.liOpen) {
      // A wrapped/continued line under the current bullet.
      html.push(`<br>${mdEmphasis(line.trim())}`);
    } else {
      // Prose ends any open list, indented continuations aside (above).
      closeLists(); para.push(mdEmphasis(line));
    }
  }
  flushPara(); closeLists();
  // Restore the lifted chunks. A fence that was not alone on its line (e.g.
  // ```x``` mid-sentence) is restored here too, rather than leaking its
  // placeholder as text.
  return mdDropCode(html.join(''), spans)
    .replace(/\uE000B(\d+)\uE000/g, (m, i) => codeBlocks[Number(i)] ?? m);
}

function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function elapsedSince(iso) {
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

export { agentBadge, api, elapsedSince, esc, fmtDuration, fmtTokens, hasPermissionBridge, lookup, mdInline, mdToHtml, modelClass, showUpdateBanner, showUpdateDownloading, showUpdateInstallFailed, toast, tokensOnly, totalTokens };
