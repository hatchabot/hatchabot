/** Offset-only HTML scanning for the console proxy. Never reserialize a
 * document: its inline script bytes may be protected by CSP hashes. */
interface HtmlTag {
  at: number;
  end: number;
  name: string;
  closing: boolean;
  attributesStart: number;
  inert: boolean;
}

const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);

export function* controlUiHtmlTags(html: string): Generator<HtmlTag> {
  let cursor = 0, templates = 0;
  while (cursor < html.length) {
    const at = html.indexOf('<', cursor);
    if (at < 0) break;
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    const opening = /^<\/?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(at, at + 128));
    const declaration = /^<!doctype\b/i.test(html.slice(at, at + 12));
    if (!opening && !declaration) { cursor = at + 1; continue; }
    const attributesStart = at + (opening?.[0].length ?? 2);
    let end = attributesStart, quote = '';
    for (; end < html.length; end++) {
      const char = html[end]!;
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) break;
    cursor = end + 1;
    const name = declaration ? '!doctype' : opening![1]!.toLowerCase();
    const closing = html[at + 1] === '/';
    yield { at, end: cursor, name, closing, attributesStart, inert: templates > 0 };
    if (name === 'template') templates = Math.max(0, templates + (closing ? -1 : 1));
    if (!closing && RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
      close.lastIndex = cursor;
      cursor = close.exec(html)?.index ?? html.length;
    }
  }
}

export function* controlUiHtmlAttributes(html: string, tag: HtmlTag): Generator<{
  name: string; value: string | undefined; start: number; end: number;
}> {
  const source = html.slice(tag.attributesStart, tag.end - 1);
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[2] ?? match[3] ?? match[4];
    const quoted = match[2] !== undefined || match[3] !== undefined;
    const end = tag.attributesStart + match.index! + match[0].length - (quoted ? 1 : 0);
    yield { name: match[1]!.toLowerCase(), value, start: end - (value?.length ?? 0), end };
  }
}

/** Place compatibility scripts before the app, outside comments/templates.
 * A marker counts only when it is an attribute of an active script element. */
export function controlUiScriptInsertionPoint(html: string, marker?: string): { at: number; installed: boolean } {
  let script: number | undefined, head: number | undefined, body: number | undefined, doctype = 0;
  for (const tag of controlUiHtmlTags(html)) {
    if (tag.name === '!doctype') { doctype ||= tag.end; continue; }
    if (tag.inert || tag.name === 'template') continue;
    if (tag.name === 'head' && tag.closing) head ??= tag.at;
    if (tag.name === 'body' && !tag.closing) body ??= tag.at;
    if (tag.name === 'script' && !tag.closing) {
      if (marker && [...controlUiHtmlAttributes(html, tag)].some((attr) => attr.name === marker)) return { at: tag.at, installed: true };
      script ??= tag.at;
    }
  }
  return { at: script ?? head ?? body ?? doctype, installed: false };
}
