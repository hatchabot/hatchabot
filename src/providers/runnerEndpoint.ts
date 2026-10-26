import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How the docker client is pointed at a runner's endpoint. A tcp:// daemon is
 * spoken to over verified TLS only, with this machine's client certificate
 * (DOCKER_CERT_PATH, else ~/.docker): over plain tcp:// every call, the seed
 * with the agent's bot token among them, crossed the network in clear, to a
 * daemon that asks nobody who they are (HB-0029). ssh:// is unchanged.
 */
export function dockerConnArgs(endpoint: string): string[] {
  return isTcpEndpoint(endpoint) ? ['-H', endpoint, '--tlsverify'] : ['-H', endpoint];
}

export function isTcpEndpoint(endpoint: string): boolean {
  return /^tcp:\/\//i.test(endpoint.trim());
}

/** Why a tcp:// runner cannot be registered from here: no client certificate to speak TLS with. */
export function tcpTlsProblem(endpoint: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  if (!isTcpEndpoint(endpoint)) return undefined;
  const dir = env.DOCKER_CERT_PATH?.trim() || join(home, '.docker');
  const missing = ['ca.pem', 'cert.pem', 'key.pem'].filter((f) => !existsSync(join(dir, f)));
  if (!missing.length) return undefined;
  return `A tcp:// runner is reached over TLS only, and this machine has no client certificate for it (${missing.join(', ')} not in ${dir}). ` +
    'Use ssh://user@host instead, or set up TLS on that Docker daemon and put its client certificates there.';
}
