/* Math enhancement for the pinned OpenClaw Control UI. The original message
 * attribute owns TeX; Markdown's visible text may have consumed its escapes.
 * Never change the message, its action handlers, or a live streaming subtree. */
(() => {
  'use strict';
  const source = window.HatchabotMathSource;
  const katex = window.katex;
  if (!source || !katex || typeof MutationObserver !== 'function') return;
  const BUBBLE = '.chat-bubble[data-message-text]';
  const SKIP = 'pre,code,a,button,input,textarea,select,script,style,svg,math,.katex,.hb-math,[contenteditable],.chat-tool-card';
  const BLOCK = /^(P|DIV|LI|UL|OL|BLOCKQUOTE|H[1-6]|TABLE|THEAD|TBODY|TR|TD|TH|DETAILS|SUMMARY)$/;
  const originals = new WeakMap();
  const settled = new WeakMap();
  const pending = new Set();
  let timer;
  let stopped = false;

  // A run never crosses a block, an interactive/code element, or a Lit marker.
  // Its offsets point to existing text nodes, so unrelated Markdown stays put.
  function textRuns(root) {
    const runs = [];
    let run = { text: '', points: [] };
    let size = 0;
    const flush = () => { if (run.text) runs.push(run); run = { text: '', points: [] }; };
    const visit = node => {
      if (size > 65536) return;
      if (node.nodeType === Node.COMMENT_NODE) { flush(); return; }
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.data;
        size += text.length;
        if (size > 65536) return;
        for (let i = 0; i < text.length; i++) {
          const char = source.visibleMathText(text[i]);
          if (char) { run.text += char; run.points.push({ node, offset: i }); }
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches(SKIP)) { flush(); return; }
      const block = BLOCK.test(node.tagName);
      if (block) flush();
      for (const child of node.childNodes) visit(child);
      if (block) flush();
    };
    for (const child of root.childNodes) visit(child);
    flush();
    return size > 65536 ? [] : runs;
  }

  function restore(bubble) {
    for (const element of bubble.querySelectorAll('.hb-math')) {
      const original = originals.get(element);
      if (original) element.replaceWith(original);
    }
  }

  function enhance(bubble) {
    if (!bubble.isConnected) return;
    // A retained settled bubble can become live again. Do not even restore its
    // previous equations while the upstream renderer owns a streaming subtree.
    if (bubble.closest('.streaming')) { settled.delete(bubble); return; }
    const raw = bubble.getAttribute('data-message-text') || '';
    const assistant = !!bubble.closest('.chat-group.assistant');
    const roots = [...bubble.querySelectorAll('.chat-text')].filter(el => el.closest(BUBBLE) === bubble);
    const previous = settled.get(bubble);
    if (previous && !previous.dirty && previous.raw === raw && previous.assistant === assistant
      && roots.length === previous.roots.length && roots.every((root, i) => root === previous.roots[i])) return;
    // Restoring uses only fragments this script removed, never authored HTML.
    restore(bubble);
    settled.set(bubble, { raw, roots, assistant, dirty: false });
    if (!assistant) return;
    const expressions = source.mathExpressions(raw);
    if (!expressions.length) return;
    const runs = roots.flatMap(textRuns);
    const groups = new Map();
    for (const expression of expressions) {
      const signature = expression.signature;
      const group = groups.get(signature) || [];
      group.push(expression);
      groups.set(signature, group);
    }
    const candidates = [];
    for (const [signature, expressions] of groups) {
      if (!signature) continue;
      const matches = [];
      for (const run of runs) {
        for (let from = 0; from < run.text.length;) {
          const start = run.text.indexOf(signature, from);
          if (start < 0) break;
          matches.push({ run, start, end: start + signature.length });
          from = start + signature.length;
          if (matches.length > expressions.length) break;
        }
        if (matches.length > expressions.length) break;
      }
      // Plain parentheses can look like slash-delimited math after Markdown.
      // Ambiguous or truncated correspondence stays exactly as OpenClaw drew it.
      if (matches.length !== expressions.length) continue;
      for (let i = 0; i < matches.length; i++) candidates.push({ ...matches[i], expression: expressions[i] });
    }
    const safe = candidates.filter(a => !candidates.some(b => a !== b && a.run === b.run && a.start < b.end && b.start < a.end));
    // Work backwards: splitting a text node cannot invalidate earlier offsets.
    safe.sort((a, b) => runs.indexOf(b.run) - runs.indexOf(a.run) || b.start - a.start);
    for (const candidate of safe) {
      if (!bubble.isConnected || bubble.getAttribute('data-message-text') !== raw) return;
      const first = candidate.run.points[candidate.start];
      const last = candidate.run.points[candidate.end - 1];
      if (!first || !last || !first.node.isConnected || !last.node.isConnected) continue;
      const element = document.createElement('span');
      element.className = candidate.expression.display ? 'hb-math hb-math-display' : 'hb-math';
      try {
        katex.render(candidate.expression.tex, element, {
          displayMode: candidate.expression.display,
          output: 'htmlAndMathml',
          throwOnError: true,
          trust: false,
          strict: 'error',
          maxSize: 10,
          maxExpand: 1000,
          macros: {},
        });
      } catch { continue; } // Incomplete/unsupported TeX remains readable source.
      const range = document.createRange();
      let start = first.offset;
      // Some older renderers retain the leading escape in \(...\)/\[...\].
      if (candidate.expression.open.startsWith('\\') && start > 0 && first.node.data[start - 1] === '\\') start--;
      range.setStart(first.node, start);
      range.setEnd(last.node, last.offset + 1);
      originals.set(element, range.extractContents());
      range.insertNode(element);
    }
  }

  function queue(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return;
    const bubble = el.closest(BUBBLE);
    if (bubble) pending.add(bubble);
    for (const child of el.querySelectorAll(BUBBLE)) pending.add(child);
    if (!timer && pending.size && !stopped) timer = setTimeout(flush, 24);
  }

  function invalidateAdded(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // A detached pane can change outside the document observer. Its first
    // reattachment gets a fresh pass; unchanged sibling bubbles keep their math.
    const invalidate = element => {
      const bubble = element.closest(BUBBLE);
      if (bubble) settled.delete(bubble);
    };
    const selector = `${BUBBLE}, .chat-text`;
    if (node.matches(selector)) invalidate(node);
    for (const child of node.querySelectorAll(selector)) invalidate(child);
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList' || record.type === 'characterData') {
        const el = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        const root = el && el.closest('.chat-text');
        const bubble = root && root.closest(BUBBLE);
        const state = bubble && settled.get(bubble);
        if (state) state.dirty = true;
      }
      queue(record.target);
      for (const node of record.addedNodes) { invalidateAdded(node); queue(node); }
    }
  });
  const observe = () => observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['data-message-text', 'class'],
  });
  function flush() {
    timer = undefined;
    if (stopped) return;
    const bubbles = [...pending];
    pending.clear();
    // KaTeX and restoration are synchronous; ignore only our own mutations.
    observer.disconnect();
    try { for (const bubble of bubbles) enhance(bubble); }
    finally { if (!stopped) observe(); }
  }
  const start = () => { stopped = false; observe(); queue(document.documentElement); };
  window.addEventListener('pagehide', () => {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
  });
  window.addEventListener('pageshow', event => { if (event.persisted) start(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
