/**
 * UI redesign M4 (PR #385 review round 1, MEDIUM): the partner guides are DATA, not code.
 * MDX evaluates `{…}` expressions, ESM and expression attributes at BUILD time, so
 * `{process.env.X}` in a guide would be published into the static HTML. This remark plugin
 * walks the MDX syntax tree (remark-mdx node types) and fails the file on:
 *   - mdxjsEsm (import / export),
 *   - mdxFlowExpression / mdxTextExpression (including empty `{}` and comments),
 *   - an mdxJsxAttributeValueExpression value or an mdxJsxExpressionAttribute (spread),
 *   - any JSX element outside ALLOWED_MDX_COMPONENTS (incl. lowercase HTML, members, fragments).
 * Code spans and fenced blocks are `inlineCode` / `code` nodes, so braces in them are allowed.
 *
 * Plain .mjs with no imports: the @next/mdx loader imports it by absolute path in both the
 * webpack and Turbopack builds (next.config.ts; node_modules/@next/mdx/mdx-js-loader.js
 * importPluginForPath), and tests/docs-mdx-no-expressions.test.ts runs it with @mdx-js/mdx.
 */

export const ALLOWED_MDX_COMPONENTS = Object.freeze(['Fact', 'TemplateCatalog', 'ErrorStatusTable', 'GuideLink']);

const EXPRESSION_NODES = new Set(['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression']);
const JSX_NODES = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement']);

/** @param {{ position?: { start?: { line?: number, column?: number } } }} node */
function where(node) {
  const s = node.position?.start;
  return s ? `${s.line}:${s.column}` : '?';
}

/**
 * Every executable or unknown MDX construct in a tree, in document order.
 * @param {any} tree an mdast tree produced with remark-mdx
 * @returns {string[]}
 */
export function mdxSafetyViolations(tree) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node */
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (EXPRESSION_NODES.has(node.type)) out.push(`${where(node)} ${node.type} is not allowed in a guide`);
    if (JSX_NODES.has(node.type)) {
      const name = node.name ?? '<fragment>';
      if (!ALLOWED_MDX_COMPONENTS.includes(name)) out.push(`${where(node)} component "${name}" is not allowed in a guide`);
      for (const attr of node.attributes ?? []) {
        if (attr.type === 'mdxJsxExpressionAttribute') out.push(`${where(node)} mdxJsxExpressionAttribute on "${name}" is not allowed`);
        else if (attr.value && typeof attr.value === 'object')
          out.push(`${where(node)} ${attr.value.type} for "${name}.${attr.name}" is not allowed (use a string)`);
      }
    }
    if (Array.isArray(node.children)) for (const c of node.children) visit(c);
  };
  visit(tree);
  return out;
}

/** The remark plugin: fails the file (and so the build) on the first violations found. */
export default function remarkNoMdxExpressions() {
  /** @param {any} tree @param {any} file */
  return (tree, file) => {
    const v = mdxSafetyViolations(tree);
    if (v.length > 0) file.fail(`MDX guide safety: ${v.join('; ')}`);
  };
}
