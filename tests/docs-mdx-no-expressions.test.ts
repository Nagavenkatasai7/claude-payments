import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import remarkNoMdxExpressions, { ALLOWED_MDX_COMPONENTS } from '../src/lib/mdx/remark-no-mdx-expressions.mjs';

// PR #385 review round 1 (MEDIUM): MDX expressions run at BUILD time, so `{process.env.X}` in a
// guide would be evaluated and published into the static HTML, and `<GuideLink slug={…}>` is
// evaluated too. The guides are data, not code: this remark plugin walks the MDX syntax tree and
// refuses ESM, flow/text expressions, expression attributes and any component outside the
// allowlist. It runs in the real loader (next.config.ts, webpack + Turbopack) and here, with the
// same compiler @mdx-js/loader uses. `{` in prose code/code blocks is data and stays allowed.

const build = (src: string) => compile(src, { remarkPlugins: [remarkGfm, remarkNoMdxExpressions] });

describe('remark-no-mdx-expressions rejects executable MDX', () => {
  const rejected: Array<[string, string, RegExp]> = [
    ['a text expression (the env-var probe)', 'Key: {process.env.FIELD_ENCRYPTION_KEY}\n', /mdxTextExpression/],
    ['a flow expression', '## A\n\n{process.env.X}\n', /mdxFlowExpression/],
    ['an empty expression / comment', 'Text {/* hi */} more\n', /mdxTextExpression/],
    ['an import', "import x from 'node:fs'\n\n## A\n", /mdxjsEsm/],
    ['an export', 'export const a = process.env.X\n\n## A\n', /mdxjsEsm/],
    ['an expression attribute value', '<GuideLink slug={process.env.X}>x</GuideLink>\n', /mdxJsxAttributeValueExpression/],
    ['a spread attribute', '<Fact {...process.env} />\n', /mdxJsxExpressionAttribute/],
    ['an expression inside a nested element', '<GuideLink slug="webhooks">{process.env.X}</GuideLink>\n', /mdx(Flow|Text)Expression/],
    ['an unknown component', '<Evil name="x" />\n', /component "Evil"/],
    ['a lowercase JSX element (raw HTML escape hatch)', '<script>alert(1)</script>\n', /component "script"/],
    ['a member-expression component', '<Foo.Bar />\n', /component "Foo\.Bar"/],
    ['a fragment', '<>x</>\n', /component "<fragment>"/],
  ];
  for (const [label, src, why] of rejected) {
    it(`rejects ${label}`, async () => {
      await expect(build(src)).rejects.toThrow(why);
    });
  }

  it('reports the line of the offending node', async () => {
    await expect(build('## A\n\nfine\n\nKey: {process.env.X}\n')).rejects.toThrow(/5:6/);
  });
});

describe('remark-no-mdx-expressions allows the guides’ data-only syntax', () => {
  it('string-attribute components, braces in code, gfm tables and task lists compile', async () => {
    const src = [
      '## Title',
      '',
      'See <GuideLink slug="webhooks">Webhooks</GuideLink>; limit <Fact name="partnerRateLimitPerMin" />.',
      '',
      '`{ "error": "x" }` inline and a block:',
      '',
      '```json',
      '{ "error": "{{1}}" }',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '- [ ] task',
      '',
      '<TemplateCatalog />',
      '',
      '<ErrorStatusTable />',
      '',
    ].join('\n');
    await expect(build(src)).resolves.toBeDefined();
  });
  it('the allowlist is exactly the four global blocks', () => {
    expect([...ALLOWED_MDX_COMPONENTS].sort()).toEqual(['ErrorStatusTable', 'Fact', 'GuideLink', 'TemplateCatalog']);
  });
  it('every real guide passes', async () => {
    const files = readdirSync('src/content/docs').filter((f) => f.endsWith('.mdx'));
    expect(files).toHaveLength(11);
    for (const f of files) await build(readFileSync(join('src/content/docs', f), 'utf8'));
  });
});
