import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * What can the runtime image actually do? Probed from the image itself (a
 * one-shot container printing versions), never hand-maintained — a static
 * list would drift the first time the image changes. Cached per image tag:
 * the answer only changes when the image does.
 */
export interface RuntimeCapabilities {
  image: string;
  /** Tool → version line, e.g. openclaw: "OpenClaw 2026.7.1-2". Absent = not in the image. */
  tools: Record<string, string>;
  /** Named binaries probed but NOT present (the honest "not included" list). */
  missing: string[];
  probedAt: string;
}

const PROBES: Array<{ key: string; cmd: string }> = [
  { key: 'openclaw', cmd: 'openclaw --version 2>/dev/null | head -1' },
  { key: 'claude-code', cmd: 'claude --version 2>/dev/null | head -1' },
  { key: 'node', cmd: 'node --version 2>/dev/null' },
  { key: 'python', cmd: 'python3 --version 2>/dev/null' },
  { key: 'git', cmd: 'git --version 2>/dev/null' },
  { key: 'gog', cmd: 'gog --version 2>/dev/null | head -1' },
  // PDF/OCR stack (base image since 2026-09-04 — the silent scanned-page fix).
  // These two print their version to STDERR, so the probe needs 2>&1 — but
  // bare 2>&1 also captured bash's "command not found" as a "version" on
  // images without the stack (10th audit); command -v gates it first.
  { key: 'tesseract', cmd: 'command -v tesseract >/dev/null 2>&1 && tesseract --version 2>&1 | head -1' },
  { key: 'ocrmypdf', cmd: 'ocrmypdf --version 2>/dev/null | head -1' },
  { key: 'pdftotext', cmd: 'command -v pdftotext >/dev/null 2>&1 && pdftotext -v 2>&1 | head -1' },
  { key: 'qpdf', cmd: 'qpdf --version 2>/dev/null | head -1' },
];
/** Deliberately-absent extras — surfaced so "can it?" has a truthful no. */
const ABSENT_PROBES = ['ffmpeg', 'whisper', 'chromium'];

const cache = new Map<string, RuntimeCapabilities>();

export async function probeImageCapabilities(
  image: string,
  opts: { docker?: string; timeoutMs?: number } = {},
): Promise<RuntimeCapabilities> {
  const hit = cache.get(image);
  if (hit) return hit;

  const script =
    PROBES.map((p) => `printf '%s=' ${JSON.stringify(p.key)}; (${p.cmd}) </dev/null | head -1; echo`).join('\n') +
    '\n' +
    ABSENT_PROBES.map((b) => `command -v ${b} >/dev/null 2>&1 && echo "have=${b}"`).join('\n') +
    '\ntrue';
  const { stdout } = await execFileP(
    opts.docker ?? 'docker',
    ['run', '--rm', '--entrypoint', 'bash', image, '-c', script],
    { timeout: opts.timeoutMs ?? 60_000, killSignal: 'SIGKILL' },
  );

  const tools: Record<string, string> = {};
  const have = new Set<string>();
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === 'have') have.add(val);
    else if (val) tools[key] = val.slice(0, 120);
  }
  const caps: RuntimeCapabilities = {
    image,
    tools,
    missing: ABSENT_PROBES.filter((b) => !have.has(b)),
    probedAt: new Date().toISOString(),
  };
  cache.set(image, caps);
  return caps;
}
