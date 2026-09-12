/**
 * Which per-agent env var NAMES are settable — shared by the web route and the
 * import path, because both are the same security boundary: an agent can run
 * on a profile SHARED by another account (§multi-user), so a per-agent var
 * must never redirect where that owner's model credential is sent, or alter
 * code/cert loading. Names are refused by SHAPE, not an exact deny-list —
 * blocking only credential *names* left ANTHROPIC_BASE_URL / HTTPS_PROXY open,
 * enough to point a shared key at an attacker.
 */

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_ENV_EXACT = new Set([
  'PATH', 'HOME', 'PYTHONPATH', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'BASH_ENV',
  'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
]);

export function reservedEnvProblem(name: string): string | undefined {
  const u = name.toUpperCase();
  if (RESERVED_ENV_EXACT.has(u)) return `"${name}" is managed by Hatchabot and can't be set here.`;
  // Proxy vars (read in either case by curl/requests) redirect all traffic.
  if (/(^|_)(HTTP|HTTPS|ALL|NO)_PROXY$/.test(u)) {
    return `"${name}" could redirect the agent's traffic and can't be set here.`;
  }
  // Model-provider / cloud credential + endpoint families — the exfil vector.
  if (/^(ANTHROPIC|CLAUDE|GEMINI|GOOGLE|GCP|VERTEX|OPENAI|AZURE|AWS|COHERE|MISTRAL)_/.test(u)) {
    return `"${name}" is reserved — model-provider and credential variables can't be set here.`;
  }
  // Loader / TLS knobs that alter how the agent loads code or trusts certs.
  if (/^(LD_|NODE_|OPENSSL_|SSL_)/.test(u)) {
    return `"${name}" is reserved — it could change how the agent loads code or trusts certificates.`;
  }
  return undefined;
}
