#!/usr/bin/env node
'use strict';
/*
 * Sr. Popo permission-prompt bridge — a tiny MCP stdio server.
 *
 * `claude` is pointed at this process via `--permission-prompt-tool mcp__srpopo__approve`
 * (registered through `--mcp-config`, see runner.js). Whenever the CLI needs to ask
 * before running a tool, it calls our `approve` tool with `{ tool_name, input }`.
 * We forward that to the Sr. Popo server (`SRPOPO_APPROVAL_URL`), which surfaces it
 * as a prompt on the board and blocks until the user decides, then we hand the
 * decision back to the CLI as the tool result:
 *   { behavior: 'allow', updatedInput?: object } | { behavior: 'deny', message: string }
 *
 * MCP stdio transport is newline-delimited JSON-RPC 2.0. No dependencies — this is
 * intentionally hand-rolled to keep Sr. Popo dependency-light. Kept pure enough to
 * unit-test: `respond(msg, ask)` builds a reply (or null for a notification) and
 * takes an injectable `ask` so tests never touch the network.
 */
const http = require('http');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'approve';
const TOOL_DEF = {
  name: TOOL_NAME,
  description:
    'Ask the Sr. Popo user to approve or deny a tool call. Returns their decision; ' +
    'the user answers in the board UI. Do not call this yourself — the CLI invokes it.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool the assistant wants to run.' },
      input: { type: 'object', additionalProperties: true, description: 'The proposed tool input.' },
    },
    required: ['tool_name', 'input'],
    additionalProperties: true,
  },
};

// A safe fallback decision so a broken bridge never hangs or silently allows.
function denied(message) {
  return { behavior: 'deny', message };
}

// POST the request to the Sr. Popo server and resolve with its decision. Any
// failure denies rather than throwing, so the CLI always gets a valid answer.
function askServer(args) {
  return new Promise((resolve) => {
    const endpoint = process.env.SRPOPO_APPROVAL_URL;
    if (!endpoint) return resolve(denied('No approval endpoint configured'));
    let url;
    try { url = new URL(endpoint); } catch { return resolve(denied('Bad approval endpoint')); }

    const body = JSON.stringify({ tool_name: args.tool_name, input: args.input ?? {} });
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && (parsed.behavior === 'allow' || parsed.behavior === 'deny')) resolve(parsed);
            else resolve(denied('Malformed approval response'));
          } catch { resolve(denied('Unreadable approval response')); }
        });
      },
    );
    req.on('error', () => resolve(denied('Approval request failed')));
    req.write(body);
    req.end();
  });
}

// Build the JSON-RPC reply for one incoming message. Returns null for messages
// that take no reply (notifications). `ask(args) -> Promise<decision>` is injected.
async function respond(msg, ask) {
  const { id, method, params } = msg || {};
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'srpopo', version: '1.0.0' },
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [TOOL_DEF] } };
    case 'tools/call': {
      const name = params && params.name;
      if (name !== TOOL_NAME) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(denied(`Unknown tool: ${name}`)) }], isError: true },
        };
      }
      const decision = await ask((params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } };
    }
    default:
      // Notifications (no id) and unknown methods: ack nothing / report not-found.
      if (method && method.startsWith('notifications/')) return null;
      if (id === undefined || id === null) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    respond(msg, askServer)
      .then((reply) => { if (reply) process.stdout.write(JSON.stringify(reply) + '\n'); })
      .catch(() => {});
  });
}

if (require.main === module) main();

module.exports = { respond, TOOL_NAME, TOOL_DEF };
