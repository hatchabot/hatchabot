import type { SecretStore } from '../../secrets/secretStore.js';
import { MEDIA_KEY_REF, SEARCH_KEY_REF } from '../lifecycle/provision.js';

/**
 * The machine's two fleet keys (HB-0808 step 15): one Gemini key powering
 * voice-note transcription (`media`: OpenClaw's audio understanding sends
 * audio to an audio-capable model) and one Brave key upgrading every agent's
 * web search from the keyless DuckDuckGo baseline (`search`). Both are
 * write-only, like every credential: kept in the secret store, injected into
 * agents at provision (provision.ts), a per-agent BRAVE_API_KEY overriding
 * the search one. A read says only whether one is set; the key itself is
 * shown again only to the machine's owner (`reveal`), and each reveal is
 * logged.
 */
export type FleetKey = 'media' | 'search';

/** Where each key is kept in the secret store. */
export const FLEET_KEY_REF: Record<FleetKey, string> = { media: MEDIA_KEY_REF, search: SEARCH_KEY_REF };

/** Who is asking, read only when the step that needs it comes (as the route read the request). */
export interface MachineCaller {
  /** The caller set this machine up. */
  ownsMachine(): boolean;
  ownerId(): string;
}

export type KeyReveal =
  | { ok: true; key: string }
  /** `machine-owner`: not the machine's owner. `none`: no key is set. */
  | { ok: false; why: 'machine-owner' | 'none' };

export interface FleetKeys {
  /** Whether the key is set: never the key. A key that cannot be read is "not set". */
  isSet(which: FleetKey): Promise<boolean>;
  /** Keep a key, already trimmed and checked by the caller. A new search key has the fleet's search checked again. */
  save(which: FleetKey, key: string): Promise<void>;
  /** The key, to the machine's owner only, logged. */
  reveal(which: FleetKey, caller: MachineCaller): Promise<KeyReveal>;
  /**
   * Forget the key. A store that refused the delete is said (`error`): the
   * key is still set, and could still be shown or given to a new agent; it
   * used to be answered as removed (HB-0918). A search key gone has the
   * fleet's search checked again.
   */
  remove(which: FleetKey): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface FleetKeysDeps {
  secrets: Pick<SecretStore, 'get' | 'put' | 'delete'>;
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** The search key was saved or removed, so what the fleet should use may have changed. */
  searchKeyChanged: () => void;
}

export function createFleetKeys(deps: FleetKeysDeps): FleetKeys {
  const { secrets } = deps;
  return {
    async isSet(which) {
      const set = await secrets.get(FLEET_KEY_REF[which]).then(() => true, () => false);
      return set;
    },
    async save(which, key) {
      await secrets.put(FLEET_KEY_REF[which], key);
      if (which === 'search') deps.searchKeyChanged();
    },
    async reveal(which, caller) {
      if (!caller.ownsMachine()) return { ok: false, why: 'machine-owner' };
      const key = await secrets.get(FLEET_KEY_REF[which]).catch(() => undefined);
      if (!key) return { ok: false, why: 'none' };
      deps.warn({ ownerId: caller.ownerId() }, which === 'media' ? 'media.key_revealed' : 'search.key_revealed');
      return { ok: true, key };
    },
    async remove(which) {
      // Deleting a key that is not there is not an error (the secret store's delete does nothing then).
      try { await secrets.delete(FLEET_KEY_REF[which]); } catch (err) {
        const error = String((err as Error)?.message ?? err).slice(0, 200);
        deps.warn({ which, error }, which === 'media' ? 'media.key_not_removed' : 'search.key_not_removed');
        return { ok: false, error };
      }
      if (which === 'search') deps.searchKeyChanged();
      return { ok: true };
    },
  };
}
