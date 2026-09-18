#!/usr/bin/env node
/**
 * The management assistant's tools, as an MCP server for the Claude CLI.
 *
 * On a Claude subscription the assistant's model runs through the `claude`
 * CLI. Instead of asking that model to print tool calls as text (and hoping),
 * the CLI is given this server: real, native tool use, several steps per turn.
 *
 * This process holds no authority of its own. Every call is forwarded to the
 * control plane with a one-turn token (HATCHABOT_TURN_TOKEN), where the SAME
 * broker as always decides: reads run, changes become confirmation cards the
 * owner must press. The token dies when the turn ends.
 *
 * Plain JavaScript on purpose: the CLI spawns it with `node`, no build step.
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
 */
import { createInterface } from 'node:readline';

const URL_BASE = process.env.HATCHABOT_MCP_URL;
const TOKEN = process.env.HATCHABOT_TURN_TOKEN;
if (URL_BASE?.startsWith('https://127.0.0.1') || URL_BASE?.startsWith('https://localhost')) {
  // The control plane's own loopback, over its self-signed certificate.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

async function forward(body) {
  const res = await fetch(`${URL_BASE}/v1/mgmt/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hatchabot-turn': TOKEN ?? '' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `control plane answered ${res.status}`);
  return json;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (e.g. notifications/initialized) need no answer
  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hatchabot', version: '1' },
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') {
      const { tools } = await forward({ op: 'list' });
      return reply(id, { tools });
    }
    if (method === 'tools/call') {
      const out = await forward({ op: 'call', name: params?.name, input: params?.arguments ?? {} });
      return reply(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError });
    }
    return fail(id, -32601, `Unknown method ${method}`);
  } catch (err) {
    if (method === 'tools/call') {
      return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    }
    return fail(id, -32603, String(err?.message ?? err));
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  void handle(msg);
});
