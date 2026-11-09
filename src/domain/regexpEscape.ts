/**
 * Every regexp metacharacter in `s` escaped, so a name, path or version can sit inside a
 * `new RegExp(...)` as itself. `/` is escaped too (allowed with the `u` flag); `-` is not,
 * since `\-` outside a class is an error under `u`. Escaping only `.` leaves the rest live
 * (CodeQL js/incomplete-sanitization, HB-0619). Node 22 has no RegExp.escape.
 */
export function regexpEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
