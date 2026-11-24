/**
 * What the consult and memory services answer (HB-0808 step 13): the body
 * the route sends, or why not, with the status the route answers and its
 * words. Nothing here knows HTTP.
 */
export type Refusal = { ok: false; status: number; error: string };
export type Answer<T> = { ok: true; body: T } | Refusal;

export const said = <T>(body: T): { ok: true; body: T } => ({ ok: true, body });
export const refused = (status: number, error: string): Refusal => ({ ok: false, status, error });
