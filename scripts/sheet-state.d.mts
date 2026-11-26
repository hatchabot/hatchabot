/** What breaks the rule that the agent sheet's forms take answers only through their handles (HB-0644), one line each. */
export function sheetStateProblems(scripts: { name: string; code: string }[], opts?: { formIds?: string[] }): string[];
/** The ids of the edit dialog's elements in web/index.html: the forms the sheet borrows. */
export function sheetFormIds(html: string): string[];
/** What the click-through's race tables must cover: the saves, the reads, and each async function that touches the forms. */
export function sheetStarters(scripts: { name: string; code: string }[], opts?: { formIds?: string[] }): { saves: string[]; reads: string[]; touchers: string[] };
