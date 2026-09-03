import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MgmtChatRequest, MgmtChatResponse } from './mgmtLlm.js';

/**
 * The mgmt assistant's NO-NEW-CREDENTIAL completion backend: drive the Claude
 * CLI on the host — the exact surface a Max subscription sanctions (measured
 * 2026-09-03: direct API calls with a setup-token are refused with a generic
 * 429; the CLI path works). The broker's tool loop stays ours; the CLI is
 * only the model call. Tool use rides a strict text protocol: the model
 * either answers in prose or emits a single JSON object naming a tool — the
 * broker validates everything downstream, so a malformed emission costs one
 * retry turn, never a wrong action.
 *
 * Credential flavors:
 *  - machine-login: spawn with the host's real HOME (~/.claude).
 *  - setup-token: spawn with CLAUDE_CODE_OAUTH_TOKEN and a scratch HOME, so
 *    the host's own login state is never touched.
 */

export interface CliCompletionOptions {
  model: string;
  /** Decrypted setup-token; absent = use the host's machine login. */
  oauthToken?: string;
  /** Injectable for tests. */
  runner?: CliRunner;
}

export type CliRunner = (argv: string[], stdin: string, env: NodeJS.ProcessEnv) => Promise<string>;

const CLI_TIMEOUT_MS = 180_000;

function claudeBin(): string {
  if (process.env.AGENTCLAW_CLAUDE_BIN) return process.env.AGENTCLAW_CLAUDE_BIN;
  // systemd services often lack ~/.local/bin on PATH — prefer the concrete
  // install location, fall back to PATH resolution.
  const local = join(homedir(), '.local', 'bin', 'claude');
  return existsSync(local) ? local : 'claude';
}

const defaultRunner: CliRunner = (argv, stdin, env) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      claudeBin(),
      argv,
      { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`claude CLI failed: ${String(stderr || err.message).slice(0, 400)}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(stdin);
  });

/** Render our block-structured conversation as plain text the CLI prompt can
 *  carry. Tool calls/results become bracketed markers — the model sees its own
 *  prior actions and their data, which is all the loop needs. */
function renderConversation(messages: MgmtChatRequest['messages']): string {
  const lines: string[] = [];
  for (const m of messages as Array<{ role: string; content: unknown }>) {
    if (typeof m.content === 'string') {
      lines.push(`${m.role === 'user' ? 'Owner' : 'You'}: ${m.content}`);
      continue;
    }
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === 'text') lines.push(`You: ${b.text}`);
      else if (b.type === 'tool_use') lines.push(`You called tool ${b.name} with ${JSON.stringify(b.input)}`);
      else if (b.type === 'tool_result') lines.push(`Tool returned: ${String(b.content).slice(0, 6000)}`);
    }
  }
  return lines.join('\n\n');
}

/** Pull a single {"tool": ..., "input": ...} object out of the model's reply,
 *  tolerating markdown fences. Returns undefined for prose. */
export function parseToolEmission(text: string): { tool: string; input: unknown } | undefined {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!stripped.startsWith('{')) return undefined;
  try {
    const obj = JSON.parse(stripped);
    if (obj && typeof obj === 'object' && typeof obj.tool === 'string') {
      return { tool: obj.tool, input: obj.input ?? {} };
    }
  } catch {
    /* prose that happens to start with { */
  }
  return undefined;
}

export async function completeViaCli(
  opts: CliCompletionOptions,
  req: MgmtChatRequest,
): Promise<MgmtChatResponse> {
  const run = opts.runner ?? defaultRunner;

  const toolCatalog = (req.tools as Array<{ name: string; description: string; input_schema: unknown }>)
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`)
    .join('\n');
  const prompt = [
    req.system,
    '',
    'TOOLS AVAILABLE TO YOU:',
    toolCatalog,
    '',
    'PROTOCOL — follow exactly:',
    '- To call a tool, reply with ONLY one JSON object, nothing else:',
    '  {"tool": "<name>", "input": { ... }}',
    '- Otherwise reply in plain prose for the owner.',
    '- Never mix prose and a tool call in one reply. One tool call at a time.',
    '',
    'CONVERSATION SO FAR:',
    renderConversation(req.messages),
    '',
    'Your reply:',
  ].join('\n');

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never let an ambient key hijack the subscription path.
  delete env.ANTHROPIC_API_KEY;
  if (opts.oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = opts.oauthToken;
    // Scratch HOME: the CLI keeps its state there, the host login stays whole.
    const scratch = join(process.env.AGENTCLAW_DATA_DIR ?? 'data', 'mgmt-cli-home');
    mkdirSync(scratch, { recursive: true });
    env.HOME = scratch;
  }

  const stdout = await run(['-p', '--output-format', 'json', '--model', opts.model], prompt, env);
  let text: string;
  try {
    const parsed = JSON.parse(stdout);
    text = typeof parsed.result === 'string' ? parsed.result : stdout;
    if (parsed.is_error) throw new Error(String(parsed.result ?? 'unknown CLI error').slice(0, 400));
  } catch (e) {
    if (e instanceof SyntaxError) text = stdout.trim(); // older CLI / plain output
    else throw e;
  }

  const tool = parseToolEmission(text);
  if (tool) {
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `cli_${Date.now().toString(36)}`, name: tool.tool, input: tool.input }],
    };
  }
  return { stopReason: 'end_turn', content: [{ type: 'text', text }] };
}
