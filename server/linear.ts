/*
 * Linear integration — turn a Linear issue into a Sr. Popo grooming task.
 *
 * A small, self-contained integration module in the mold of github.ts (not a
 * general plugin framework): it mirrors the single-source-of-truth pattern of
 * addons.ts / personas.ts. All Linear access goes through the GraphQL API over
 * the global `fetch` (Node 18+, so no new runtime dependency), authenticated
 * with the user's personal API key read from settings — the token stays local
 * and nothing else leaves the machine. Every function is typed and non-throwing:
 * a missing token, auth failure, network error, or unknown issue resolves to a
 * `{ ok: false, reason }` result so an endpoint never crashes.
 *
 * Auth note: Linear personal API keys are sent as the RAW key value in the
 * `Authorization` header (no `Bearer` prefix); OAuth access tokens use `Bearer`.
 * We send the raw key and, if that is rejected as unauthorized, retry once with
 * a `Bearer` prefix so a pasted OAuth token also works.
 */
import { db } from './store';
import type { LinearIssue, LinearIssueComment, LinearIssueSummary } from './types';

const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LINEAR_TIMEOUT_MS = 30000;
const MAX_ISSUES = 50;
const MAX_COMMENTS = 50;

// The typed reasons an operation can fail with. `no-token` and `unauthorized`
// point the user at Settings; `not-found` is an unknown issue; `error` is a
// network/transport/unknown-GraphQL failure.
export type LinearReason = 'no-token' | 'unauthorized' | 'not-found' | 'error';

type IssuesResult = { ok: true; issues: LinearIssueSummary[] } | { ok: false; reason: LinearReason };
type IssueResult = { ok: true; issue: LinearIssue } | { ok: false; reason: LinearReason };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

// The active issues assigned to the current viewer. Ordering/capping happens in
// parseIssueList so it stays deterministic and unit-testable.
const MY_ISSUES_QUERY = `
  query SrPopoMyIssues($first: Int!) {
    viewer {
      assignedIssues(first: $first) {
        nodes { id identifier title url updatedAt state { name } }
      }
    }
  }`;

// Shared field set for a single issue, with body + comment bodies so grooming
// has full context.
const ISSUE_FIELDS = `
  identifier
  title
  description
  url
  state { name }
  comments(first: ${MAX_COMMENTS}) {
    nodes { body createdAt user { name } }
  }`;

const ISSUE_BY_ID_QUERY = `
  query SrPopoIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }`;

// Lookup by human identifier (e.g. ABC-123) via team key + issue number.
const ISSUE_BY_IDENTIFIER_QUERY = `
  query SrPopoIssueByIdentifier($key: String!, $number: Float!) {
    issues(first: 1, filter: { team: { key: { eq: $key } }, number: { eq: $number } }) {
      nodes { ${ISSUE_FIELDS} }
    }
  }`;

interface GraphQLOutcome {
  status: number;
  json: unknown;
  networkError: boolean;
}

// The configured personal API key, trimmed (empty string when unset).
function token(): string {
  return String((db.settings && db.settings.linearApiToken) || '').trim();
}

// POST a GraphQL query to Linear. Resolves — never rejects — with the raw
// outcome so callers can classify it. Sends the personal key as the raw
// Authorization value; retries once with a `Bearer` prefix if that is rejected.
async function graphql(query: string, variables: Record<string, unknown>): Promise<GraphQLOutcome> {
  const key = token();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINEAR_TIMEOUT_MS);
  const post = (auth: string) =>
    fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
  try {
    let res = await post(key);
    if ((res.status === 401 || res.status === 403) && !/^Bearer\s/i.test(key)) {
      res = await post(`Bearer ${key}`);
    }
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json, networkError: false };
  } catch {
    return { status: 0, json: null, networkError: true };
  } finally {
    clearTimeout(timer);
  }
}

// Does a GraphQL response carry an authentication error? Linear reports a bad
// key both as an HTTP 401/403 and, sometimes, as a 200 with an errors[] entry.
function isAuthError(json: unknown): boolean {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => {
    const ext = (e && (e as { extensions?: Record<string, unknown> }).extensions) || {};
    const type = String((ext.type || ext.code || '')).toLowerCase();
    const msg = String((e && (e as { message?: unknown }).message) || '').toLowerCase();
    return /authentication|unauthorized/.test(type) ||
      /authentication|not authenticated|unauthorized|invalid api key|invalid token/.test(msg);
  });
}

// Classify an outcome to a typed reason, or null when it succeeded (no errors).
function reasonFor(out: GraphQLOutcome): LinearReason | null {
  if (out.networkError) return 'error';
  if (out.status === 401 || out.status === 403 || isAuthError(out.json)) return 'unauthorized';
  if (!out.json || (out.json as { errors?: unknown }).errors) return 'error';
  return null;
}

// Pure helper: normalize a `viewer.assignedIssues` payload into our compact
// summary shape, sorted most-recently-updated first and capped. Drops active vs.
// closed filtering to the caller/UI; never throws — malformed input yields [].
function parseIssueList(payload: unknown): LinearIssueSummary[] {
  const nodes = (payload as { data?: { viewer?: { assignedIssues?: { nodes?: unknown } } } })
    ?.data?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(nodes)) return [];
  const list: LinearIssueSummary[] = [];
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string') continue;
    list.push({
      id: n.id,
      identifier: typeof n.identifier === 'string' ? n.identifier : '',
      title: typeof n.title === 'string' ? n.title : '',
      url: typeof n.url === 'string' ? n.url : '',
      state: n.state && typeof n.state.name === 'string' ? n.state.name : '',
      updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : null,
    });
  }
  list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return list.slice(0, MAX_ISSUES);
}

// Pure helper: normalize a single-issue payload (from either `issue` or the
// `issues.nodes[0]` identifier lookup) into our full issue shape. Returns null
// when no usable issue is present; never throws.
function parseIssue(payload: unknown): LinearIssue | null {
  const data = (payload as { data?: { issue?: unknown; issues?: { nodes?: unknown } } })?.data;
  const raw = (data?.issue as Record<string, unknown> | undefined) ||
    (Array.isArray(data?.issues?.nodes) ? (data!.issues!.nodes as unknown[])[0] as Record<string, unknown> : undefined);
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.identifier !== 'string' || !raw.identifier) return null;

  const commentNodes = (raw.comments as { nodes?: unknown } | undefined)?.nodes;
  const comments: LinearIssueComment[] = [];
  if (Array.isArray(commentNodes)) {
    for (const c of commentNodes) {
      if (!c || typeof c.body !== 'string' || !c.body.trim()) continue;
      comments.push({
        body: c.body,
        author: c.user && typeof c.user.name === 'string' ? c.user.name : '',
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
      });
    }
  }
  return {
    identifier: raw.identifier,
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    state: raw.state && typeof (raw.state as { name?: unknown }).name === 'string'
      ? (raw.state as { name: string }).name : '',
    comments,
  };
}

// Pure helper: compose a self-contained brief from an issue for the grooming
// session. The identifier + URL lead so the origin is preserved, then the title,
// description, and comments give full context.
function briefFromIssue(issue: LinearIssue): string {
  const lines: string[] = [];
  lines.push(`Linear issue ${issue.identifier}${issue.url ? ` — ${issue.url}` : ''}`);
  if (issue.state) lines.push(`State: ${issue.state}`);
  lines.push('');
  lines.push(`# ${issue.title || issue.identifier}`);
  if (issue.description && issue.description.trim()) {
    lines.push('');
    lines.push(issue.description.trim());
  }
  if (issue.comments.length) {
    lines.push('');
    lines.push('## Comments');
    for (const c of issue.comments) {
      lines.push('');
      lines.push(`**${c.author || 'Someone'}**:`);
      lines.push(c.body.trim());
    }
  }
  return lines.join('\n');
}

// The current viewer's assigned issues, for the browse list.
async function listMyIssues(): Promise<IssuesResult> {
  if (!token()) return { ok: false, reason: 'no-token' };
  const out = await graphql(MY_ISSUES_QUERY, { first: MAX_ISSUES });
  const reason = reasonFor(out);
  if (reason) return { ok: false, reason };
  return { ok: true, issues: parseIssueList(out.json) };
}

// One issue by Linear UUID or human identifier (e.g. ABC-123).
async function getIssue(idOrIdentifier: string): Promise<IssueResult> {
  const raw = String(idOrIdentifier || '').trim();
  if (!raw) return { ok: false, reason: 'not-found' };
  if (!token()) return { ok: false, reason: 'no-token' };

  const ident = !UUID_RE.test(raw) ? raw.match(IDENTIFIER_RE) : null;
  const out = ident
    ? await graphql(ISSUE_BY_IDENTIFIER_QUERY, { key: ident[1].toUpperCase(), number: Number(ident[2]) })
    : await graphql(ISSUE_BY_ID_QUERY, { id: raw });

  const reason = reasonFor(out);
  if (reason) return { ok: false, reason };
  const issue = parseIssue(out.json);
  if (!issue) return { ok: false, reason: 'not-found' };
  return { ok: true, issue };
}

export { listMyIssues, getIssue, parseIssue, parseIssueList, briefFromIssue };
