/**
 * A derived-image name is both a docker tag component and a filename, so keep it
 * strict: lowercase kebab, must start with a letter, 2–40 chars. Returns a
 * human message on rejection, or null when valid.
 */
export function derivedNameProblem(name: string): string | null {
  if (!name || typeof name !== 'string') return 'A name is required.';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) {
    return 'Use 2–40 chars: lowercase letters, digits, and hyphens, starting with a letter.';
  }
  if (name.includes('--') || name.endsWith('-')) return 'No trailing or doubled hyphens.';
  return null;
}
