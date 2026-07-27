/**
 * §5.1 / §7.6: the control plane owns secrets; agents never do. Everything the
 * rest of the codebase touches is a `secretRef` string — the plaintext is only
 * resolved at the moment of injection into a runtime.
 *
 * The local implementation encrypts at rest with AES-256-GCM. The production
 * implementation will be GCP Secret Manager behind this same interface.
 */
export interface SecretStore {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export class SecretNotFoundError extends Error {
  constructor(ref: string) {
    super(`No secret stored under ref "${ref}"`);
    this.name = 'SecretNotFoundError';
  }
}
