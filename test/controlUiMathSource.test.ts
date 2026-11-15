import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Expression = { tex: string; raw: string; display: boolean; open: string; close: string; start: number; end: number; signature: string };
type MathSource = { mathExpressions: (source: unknown) => Expression[]; visibleMathText: (source: string) => string };
const window: { HatchabotMathSource?: MathSource } = {};
runInNewContext(readFileSync('web/control-ui-math-source.js', 'utf8'), { window });
const { mathExpressions, visibleMathText } = window.HatchabotMathSource!;
const tex = (source: string) => mathExpressions(source).map((entry) => entry.tex);

describe('raw Control UI math source', () => {
  it('extracts all four delimiter styles with exact source ranges', () => {
    const source = String.raw`Inline $x_i$ and \(y^2\), then $$\frac{a}{b}$$ and \[z = 3\].`;
    const found = mathExpressions(source);
    expect(found.map(({ tex, display }) => ({ tex, display }))).toEqual([
      { tex: 'x_i', display: false }, { tex: 'y^2', display: false },
      { tex: String.raw`\frac{a}{b}`, display: true }, { tex: 'z = 3', display: true },
    ]);
    for (const item of found) {
      expect(source.slice(item.start, item.end)).toBe(item.raw);
      expect(item.raw).toBe(item.open + item.tex + item.close);
      expect(item.signature).toBe(visibleMathText(item.raw));
    }
  });

  it('preserves matrix row separators, escapes, underscores and newlines in original TeX', () => {
    const body = String.raw`\begin{bmatrix}
a_1 & b_2 \\
c_3 & d_4
\end{bmatrix}`;
    expect(tex(`$$\n${body}\n$$`)).toEqual([`\n${body}\n`]);
    expect(visibleMathText(String.raw`$$a_1 \\ b_2$$`)).toBe(visibleMathText(String.raw`$$a1 \ b2$$`));
    expect(visibleMathText(String.raw`\[x_{i}\]`)).toBe(visibleMathText('[x{i}]'));
  });

  it.each([
    '`$code$` $real$', '``$code$ ` ignored`` $real$',
    '```latex\n$$code$$\n```\n$real$', '~~~~\n\\[code\\]\n~~~~\n$real$',
    '> ```\n> $code$\n> ```\n$real$', '    $$code$$\n$real$', '\t$code$\n$real$',
    '- ```\n  $code$\n  ```\n$real$',
    '[label $code$](https://example.invalid/$path$) $real$',
    '[label $code$]\n(https://example.invalid/$path$) $real$',
    '![alt $code$](image.png) $real$', '[label $code$][ref] $real$',
    '[label $code$]\n\n[label $code$]: https://example.invalid\n$real$',
    '<https://example.invalid/$code$> $real$', 'https://example.invalid/$code$ $real$',
    '<span title="$code$">$real$</span>',
  ])('ignores code and links: %s', (source) => {
    expect(tex(source)).toEqual(['real']);
  });

  it('retains formulas in ordinary bracketed prose, quotes and lists', () => {
    expect(tex('[value $x$] and > $y$\n- $z$')).toEqual(['x', 'y', 'z']);
  });

  it('treats angle signs and brackets inside a formula as original TeX', () => {
    expect(tex(String.raw`$$x<y>z$$ and $\text{[x](y)}$`)).toEqual(['x<y>z', String.raw`\text{[x](y)}`]);
    expect(tex('$2+2$ and $2-1=1$')).toEqual(['2+2', '2-1=1']);
  });

  it.each([
    String.raw`The cost is \$5 and \$10.`, 'The cost is $5 and $10.',
    'From $20–$30 each.', 'A price $12.50$ and $ 20 $ stay literal.',
    String.raw`Escaped \\(literal\\) and \\[literal\\].`,
    '$unfinished', '$$unfinished', String.raw`\(unfinished`, String.raw`\[unfinished`,
    '$$', '$$$$', '$$$x$$$', '$ \n $', '$x\ny$',
    '- ```\n  $code$\n',
  ])('leaves nonmath/incomplete input untouched: %s', (source) => {
    expect(mathExpressions(source)).toEqual([]);
  });

  it('allows escaped dollars inside complete formulas and math after literal escaped openers', () => {
    expect(tex(String.raw`\$literal then $x + \$5$ and $$\text{cost: \$5}$$`)).toEqual([String.raw`x + \$5`, String.raw`\text{cost: \$5}`]);
  });

  it('does not join delimiters across code or unrelated lines', () => {
    expect(tex('$x `literal` y$')).toEqual([]);
    expect(tex('$$x\n```\ncode\n```\ny$$')).toEqual([]);
    expect(tex('$$x\n\ny$$')).toEqual(['x\n\ny']);
  });

  it('keeps repeated expressions separate and preserves normalized ambiguities for the adapter', () => {
    const found = mathExpressions('$a_b$ $ab$ $a_b$');
    expect(found.map((entry) => entry.tex)).toEqual(['a_b', 'ab', 'a_b']);
    expect(new Set(found.map((entry) => entry.signature)).size).toBe(1);
  });

  it('uses only per-character deletions in signatures, preserving case, symbols and offsets', () => {
    const source = String.raw`\[ A_{β} * \\ Ω + 2 \]`;
    expect(visibleMathText(source)).toBe('[A{β}Ω+2]');
    expect(Array.from(source, (ch) => visibleMathText(ch)).join('')).toBe(visibleMathText(source));
  });

  it('bounds malformed, oversized and repeated source without executing authored content', () => {
    expect(mathExpressions(null)).toEqual([]);
    expect(mathExpressions('$x$'.repeat(22000))).toEqual([]);
    expect(mathExpressions('$$' + 'x'.repeat(8193) + '$$')).toEqual([]);
    expect(mathExpressions('$x$ '.repeat(100))).toHaveLength(64);
    expect(mathExpressions('\\'.repeat(65536))).toEqual([]);
    expect(mathExpressions('['.repeat(65536))).toEqual([]);
    expect(tex('$$\\href{javascript:alert(1)}{x}$$')).toEqual(['\\href{javascript:alert(1)}{x}']);
    expect(Object.keys(window)).toEqual(['HatchabotMathSource']);
  });
});
