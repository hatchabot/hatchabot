import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalDockerProvider } from './localDockerProvider.js';
import type { RuntimeProvider } from './provider.js';
import type { Host } from '../domain/types.js';

const execFileP = promisify(execFile);

/**
 * Best-effort reachability check for a runner's Docker endpoint. Used when a
 * runner host is registered, so a bad endpoint fails at add-time (a warning),
 * not at first provision. Never throws — a missing docker binary or an
 * unreachable daemon just returns ok:false with a short reason.
 */
export async function pingRunner(
  dockerHost: string,
  opts: { docker?: string; timeoutMs?: number; image?: string } = {},
): Promise<{ ok: boolean; version?: string; hasImage?: boolean; error?: string }> {
  try {
    const { stdout } = await execFileP(
      opts.docker ?? 'docker',
      ['-H', dockerHost, 'version', '--format', '{{.Server.Version}}'],
      { timeout: opts.timeoutMs ?? 8000, killSignal: 'SIGKILL' },
    );
    const version = stdout.trim();
    if (!version) return { ok: false, error: 'no server version reported' };
    // Reachable is half the story: provision needs the runtime image on THAT
    // daemon, and a missing image otherwise only fails at first create. Probe
    // it here so the UI can offer "Install image" up front. Best-effort — an
    // inspect error just reports the image missing.
    let hasImage = false;
    try {
      await execFileP(
        opts.docker ?? 'docker',
        ['-H', dockerHost, 'image', 'inspect', opts.image ?? 'hatchabot-runtime:latest',
          '--format', 'ok'],
        { timeout: opts.timeoutMs ?? 8000, killSignal: 'SIGKILL' },
      );
      hasImage = true;
    } catch {
      /* image absent (or uninspectable) — reported as missing */
    }
    return { ok: true, version, hasImage };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

/**
 * Pick the runtime provider for a host. Two paths:
 *
 * - A **runner host** (Cluster mode) carries a Docker endpoint in
 *   `settings.dockerHost` (e.g. `ssh://runner@vm`). It gets its OWN
 *   remote-pointed provider, built once and cached per host — one endpoint, one
 *   provider — and rebuilt if the endpoint ever changes.
 * - Everything else resolves the shared, name-keyed provider (`mock`,
 *   `local-docker`) registered at startup.
 *
 * The `cache` is owned by the caller (the routes closure) so remote providers
 * live for the process, not per request.
 */
export function resolveProvider(
  host: Host,
  shared: Map<string, RuntimeProvider>,
  cache: Map<string, RuntimeProvider>,
  opts: { image?: string; prefix?: string } = {},
): RuntimeProvider {
  const dockerHost = typeof host.settings?.dockerHost === 'string' ? host.settings.dockerHost.trim() : '';
  if (dockerHost) {
    const key = `${host.id}:${dockerHost}`;
    let provider = cache.get(key);
    if (!provider) {
      provider = new LocalDockerProvider({ host: dockerHost, image: opts.image, prefix: opts.prefix });
      cache.set(key, provider);
    }
    return provider;
  }
  const provider = shared.get(host.provider);
  if (!provider) throw new Error(`No provider registered for "${host.provider}"`);
  return provider;
}
