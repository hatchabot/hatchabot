import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { AppError, fieldsToAsk, type AppManifest } from './apps.js';

/**
 * An app waiting for its new agent (a new agent "from a repo") keeps the values
 * it was given until it goes in. A field the manifest marks `secret` (an app
 * password, an API key) is kept in the secret store, and the row holds only
 * where: the row is plain JSON in the database, and a failed install kept it,
 * and the secret with it, for as long as the agent existed.
 */
const REF = '$secretRef';

/** Where one waiting secret value is kept. */
export const pendingSecretRef = (agentId: string, key: string): string => `app-pending/${agentId}/${key}`;

/**
 * Secret values of `values` moved to the secret store; what the row keeps.
 * JSON-encoded, so a number or a list comes back as it went in.
 */
export async function stashPendingSecrets(
  secrets: SecretStore, agentId: string, m: AppManifest, values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secret = new Set(fieldsToAsk(m).filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!secret.has(k) || v === undefined || v === '') { out[k] = v; continue; }
    const ref = pendingSecretRef(agentId, k);
    await secrets.put(ref, JSON.stringify(v));
    out[k] = { [REF]: ref };
  }
  return out;
}

/** The secret refs a row names: only this agent's own, one per key, whatever else the row says. */
export function pendingSecretRefs(agentId: string, values: Record<string, unknown>): string[] {
  return Object.entries(values).flatMap(([k, v]) => {
    const ref = v && typeof v === 'object' ? (v as Record<string, unknown>)[REF] : undefined;
    return ref === pendingSecretRef(agentId, k) ? [ref] : [];
  });
}

/**
 * The row's values with its secrets read back. A marker is honoured only at
 * this agent's own ref for that key: a value typed in to look like one could
 * otherwise read any secret into the app's config.
 */
export async function resolvePendingValues(
  secrets: SecretStore, agentId: string, values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const isMarker = !!v && typeof v === 'object' && REF in (v as Record<string, unknown>);
    if (!isMarker) { out[k] = v; continue; }
    const ref = pendingSecretRefs(agentId, { [k]: v })[0];
    if (!ref) continue;
    let raw: string;
    try { raw = await secrets.get(ref); } catch { throw new AppError(`The value for ${k} is no longer stored; install it again and give it.`); }
    try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
  }
  return out;
}

/** Forget a waiting install: its secrets first, then its row. */
export async function dropAppPending(store: Store, secrets: SecretStore, agentId: string): Promise<void> {
  const p = store.getAppPending(agentId);
  if (!p) return;
  for (const ref of pendingSecretRefs(agentId, p.values)) await secrets.delete(ref).catch(() => {});
  store.deleteAppPending(agentId);
}
