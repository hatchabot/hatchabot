/**
 * Why a base-image build failed, in the build's own words. The scripts mark
 * the reasons they know with "✗" and may continue on indented lines; docker
 * prefixes each line with its step and clock ("#10 4.219 "). Without this the
 * app and the management agent saw only "build exited 1".
 */
export function buildFailureReason(log: string, code: number | null): string {
  const lines = log.split('\n').map((l) => l.replace(/^#\d+\s+[\d.]+\s/, '').replace(/\s+$/, ''));
  const at = lines.findIndex((l) => l.trimStart().startsWith('✗'));
  if (at >= 0) {
    const out = [lines[at]!.trim().replace(/^✗\s*/, '')];
    for (let i = at + 1; i < lines.length && out.length < 4 && /^\s{2,}\S/.test(lines[i]!); i++) out.push(lines[i]!.trim());
    return out.join(' ').slice(0, 600);
  }
  const err = [...lines].reverse().find((l) => /(\bERROR\b|\bE: |npm error)/.test(l) && !l.includes('process "/bin/sh'));
  return err ? err.trim().slice(0, 300) : `The build stopped with code ${code ?? '?'}; see its log.`;
}

/**
 * From OpenClaw 2026.8 the embedding plugin runs a separate llama-server it
 * downloads later, instead of carrying its engine. Hatchabot bakes the engine
 * into the image and is not ported to the new arrangement, so images for those
 * versions cannot be built yet (the Dockerfile refuses, with this reason).
 * Raise this when the port lands.
 */
export const FIRST_UNPORTED_OPENCLAW = [2026, 8, 0] as const;
export function openclawBuildable(version: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return true; // unknown: let the build itself be the judge
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    const have = v[i] ?? 0, first = FIRST_UNPORTED_OPENCLAW[i] ?? 0;
    if (have !== first) return have < first;
  }
  return false;
}
