import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * What can the runtime image actually do? Probed from the image itself (a
 * one-shot container printing versions), never hand-maintained — a static
 * list would drift the first time the image changes. Cached per image, by
 * its id: a tag is a name that moves (a rebuild or a promote points it at
 * another image), and caching by the name kept the old answer (#124).
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
  // PDF creation (base image since 2026-09-04): pandoc + weasyprint engine.
  { key: 'pandoc', cmd: 'pandoc --version 2>/dev/null | head -1' },
  { key: 'weasyprint', cmd: 'weasyprint --version 2>/dev/null | head -1' },
];
/** Deliberately-absent extras — surfaced so "can it?" has a truthful no. */
const ABSENT_PROBES = ['ffmpeg', 'whisper', 'chromium'];

/**
 * The probe runs whatever a derived image's owner-written Dockerfile put on
 * the PATH: no network, bounded memory and processes, no capabilities and no
 * way to gain them, like the provider's other one-shot containers (HB-0079).
 * Printing a version needs none of them.
 */
export const PROBE_SANDBOX = ['--network', 'none', '--memory', '256m', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

/** Keyed `<tag>@<image id>`. */
const cache = new Map<string, RuntimeCapabilities>();

export async function probeImageCapabilities(
  image: string,
  opts: { docker?: string; timeoutMs?: number } = {},
): Promise<RuntimeCapabilities> {
  // The image id the tag names now: an inspect, far cheaper than the probe.
  // Unreadable, nothing is cached (and the probe says why it failed).
  const id = await execFileP(opts.docker ?? 'docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 15_000, killSignal: 'SIGKILL' })
    .then((r) => r.stdout.trim(), () => '');
  const key = /^sha256:[0-9a-f]{12,}$/.test(id) ? `${image}@${id}` : undefined;
  const hit = key ? cache.get(key) : undefined;
  if (hit) return hit;

  const script =
    PROBES.map((p) => `printf '%s=' ${JSON.stringify(p.key)}; (${p.cmd}) </dev/null | head -1; echo`).join('\n') +
    '\n' +
    ABSENT_PROBES.map((b) => `command -v ${b} >/dev/null 2>&1 && echo "have=${b}"`).join('\n') +
    '\ntrue';
  // Named, so a probe that times out can be removed: killing the docker
  // client leaves the container running on the daemon, and `--rm` only acts
  // once it exits — a hung version command would never (review, 2026-10-22).
  const name = `hatchabot-caps-${randomBytes(6).toString('hex')}`;
  let stdout: string;
  try {
    ({ stdout } = await execFileP(
      opts.docker ?? 'docker',
      ['run', '--rm', '--name', name, ...PROBE_SANDBOX, '--entrypoint', 'bash', image, '-c', script],
      { timeout: opts.timeoutMs ?? 60_000, killSignal: 'SIGKILL' },
    ));
  } catch (err) {
    await execFileP(opts.docker ?? 'docker', ['rm', '-f', name], { timeout: 15_000, killSignal: 'SIGKILL' }).catch(() => {});
    throw err;
  }

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
  if (key) cache.set(key, caps);
  return caps;
}
