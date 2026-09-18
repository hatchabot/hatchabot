import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The management chat renders the assistant's answers as a small Markdown
 * subset. The answers can quote agent logs, names and memory, so the renderer
 * must escape everything and only then add tags.
 */
const html = readFileSync('web/index.html', 'utf8');
const esc = new Function(`return ${html.match(/function esc\(s\) \{[\s\S]*?\n\}/)![0]}`)();
const md = new Function('esc', `${html.match(/function mdToHtml\(src\) \{[\s\S]*?\n\}\n/)![0]}; return mdToHtml;`)(esc) as (s: string) => string;

describe('mdToHtml', () => {
  it('formats the basics', () => {
    expect(md('**bold** and *it* and `code`')).toBe('<div><b>bold</b> and <i>it</i> and <code>code</code></div>');
    expect(md('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('| x | y |\n|---|---|\n| 1 | 2 |')).toContain('<th>x</th><th>y</th></tr></thead><tbody><tr><td>1</td><td>2</td>');
  });
  it('escapes markup, including inside code blocks and table cells', () => {
    expect(md('<img src=x onerror=alert(1)>')).not.toMatch(/<img/);
    expect(md('```\n<script>1</script>\n```')).toContain('&lt;script&gt;');
    expect(md('| <b>x</b> |\n|---|')).not.toMatch(/<b>x<\/b>/);
  });
  it('links only http(s)', () => {
    expect(md('[x](javascript:alert(1))')).not.toMatch(/href/);
    expect(md('[docs](https://example.com/a)')).toContain('<a href="https://example.com/a" target="_blank" rel="noopener">docs</a>');
    expect(md('see https://example.com')).toContain('href="https://example.com"');
    expect(md('[x](https://e.com/"onmouseover="alert(1))')).not.toMatch(/"onmouseover=/);
  });
});
