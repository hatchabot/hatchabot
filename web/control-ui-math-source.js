(function () {
  'use strict';
  // Matching only: Markdown may consume escapes/emphasis before the DOM adapter
  // sees them. Never use this lossy signature as the expression sent to KaTeX.
  function visibleMathText(text) {
    return typeof text === 'string' ? text.replace(/[\\_*\s]/g, '') : '';
  }

  function mathExpressions(source) {
    if (typeof source !== 'string' || source.length > 65536) return [];
    const excluded = new Uint8Array(source.length);
    const escaped = new Uint8Array(source.length);
    let slashCount = 0;
    for (let at = 0; at < source.length; at++) {
      escaped[at] = slashCount % 2;
      slashCount = source[at] === '\\' ? slashCount + 1 : 0;
    }
    const references = new Set();
    const mark = (start, end) => excluded.fill(1, start, end);
    const reference = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
    let fence = null;
    for (let start = 0; start < source.length;) {
      const newline = source.indexOf('\n', start);
      const end = newline < 0 ? source.length : newline + 1;
      const line = source.slice(start, end).replace(/\r?\n$/, '');
      // Quoted code is code too. Conservative indentation handling also leaves
      // nested-list code alone rather than guessing at its container depth.
      const body = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
      const opening = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(body);
      if (fence) {
        mark(start, end);
        if (opening && opening[1][0] === fence.char && opening[1].length >= fence.length && !opening[2].trim()) fence = null;
      } else if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        fence = { char: opening[1][0], length: opening[1].length };
        mark(start, end);
      } else if (/^(?: {4}| {0,3}\t)/.test(body)) {
        mark(start, end);
      } else {
        const definition = /^ {0,3}\[([^\]]+)\]:/.exec(body);
        if (definition) {
          references.add(reference(definition[1]));
          mark(start, end);
        }
      }
      start = end;
    }

    // Bound repeated unmatched brackets/delimiters as well as source size.
    let scanBudget = Math.max(1024, source.length * 16);
    // Return the closing bracket's index. Escaped brackets do not nest.
    function closing(start, open, close) {
      let depth = 1;
      for (let at = start + 1; at < source.length && at - start <= 8192; at++) {
        if (--scanBudget < 0) return -1;
        if (excluded[at] || source[at] === '\n') return -1;
        if (source[at] === '\\') { at++; continue; }
        if (source[at] === open) depth++;
        else if (source[at] === close && --depth === 0) return at;
      }
      return -1;
    }

    function expressionAt(start) {
      let open, close, display;
      if (source.startsWith('$$', start) && source[start - 1] !== '$' && source[start + 2] !== '$') { open = close = '$$'; display = true; }
      else if (source[start] === '$' && source[start - 1] !== '$' && source[start + 1] !== '$') { open = close = '$'; display = false; }
      else if (source.startsWith('\\[', start)) { open = '\\['; close = '\\]'; display = true; }
      else if (source.startsWith('\\(', start)) { open = '\\('; close = '\\)'; display = false; }
      else return null;
      const contentStart = start + open.length;
      if (open === '$' && (!source[contentStart] || /\s/.test(source[contentStart]))) return null;
      let end = contentStart;
      for (; end < source.length && end - contentStart <= 8192; end++) {
        if (--scanBudget < 0) return null;
        if (excluded[end]) break;
        if (source.startsWith(close, end) && !escaped[end]) {
          if (close === '$' && (source[end - 1] === '$' || source[end + 1] === '$')) continue;
          if (close === '$$' && (source[end - 1] === '$' || source[end + 2] === '$')) continue;
          break;
        }
        if (!display && source[end] === '\n') break;
      }
      if (end >= source.length || excluded[end] || end - contentStart > 8192 || !source.startsWith(close, end)) return null;
      const tex = source.slice(contentStart, end);
      if (!tex.trim() || tex.includes('`')) return null;
      // Inline dollars follow common math delimiter rules. Pure monetary values
      // and price ranges remain prose even when another dollar appears nearby.
      if (open === '$' && (/\s/.test(tex.at(-1)) || /\d/.test(source[end + 1] || '') || /^[+-]?\d[\d,.]*(?:\s*[-−–—]\s*(?:\d[\d,.]*)?)?$/.test(tex))) return null;
      const raw = source.slice(start, end + close.length);
      return { tex, raw, display, open, close, start, end: end + close.length, signature: visibleMathText(raw) };
    }

    // Skip Markdown containers only outside formulas: brackets or angle signs
    // inside TeX belong to TeX, whereas a dollar inside a link/code does not.
    const expressions = [];
    for (let at = 0; at < source.length && expressions.length < 64; at++) {
      if (scanBudget < 0) return [];
      if (excluded[at] || escaped[at]) continue;
      const ch = source[at];
      if (ch === '$' || ch === '\\') {
        const expression = expressionAt(at);
        if (expression) { expressions.push(expression); at = expression.end - 1; continue; }
      }
      if (ch === '\\') { at++; continue; }
      if (ch === '`') {
        let length = 1;
        while (source[at + length] === '`') length++;
        let end = at + length;
        for (; end < source.length;) {
          if (--scanBudget < 0) return [];
          if (source[end] !== '`' || excluded[end]) { end++; continue; }
          let run = 1;
          while (source[end + run] === '`') run++;
          if (run === length) break;
          end += run;
        }
        if (end < source.length) at = end + length - 1;
        else at += length - 1;
      } else if (ch === '[') {
        const labelEnd = closing(at, '[', ']');
        if (labelEnd < 0) continue;
        const gap = /^[ \t]*(?:\n[ \t]*)?/.exec(source.slice(labelEnd + 1))[0].length;
        const targetStart = labelEnd + 1 + gap;
        let end = -1;
        if (source[targetStart] === '(') {
          const destinationEnd = closing(targetStart, '(', ')');
          if (destinationEnd >= 0) end = destinationEnd;
        } else if (source[targetStart] === '[') {
          const referenceEnd = closing(targetStart, '[', ']');
          if (referenceEnd >= 0) end = referenceEnd;
        } else if (references.has(reference(source.slice(at + 1, labelEnd)))) end = labelEnd;
        if (end >= 0) at = end;
      } else if (ch === '<') {
        const end = source.indexOf('>', at + 1);
        if (end >= 0 && !source.slice(at, end).includes('\n')) at = end;
      } else if ((ch === 'h' || ch === 'w') && /^(?:https?:\/\/|www\.)/i.test(source.slice(at, at + 8))) {
        let end = at;
        while (end < source.length && !/[\s<>]/.test(source[end])) end++;
        at = end - 1;
      }
    }
    return expressions;
  }

  window.HatchabotMathSource = { mathExpressions, visibleMathText };
}());
