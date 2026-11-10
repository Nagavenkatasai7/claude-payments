import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Next.js shared config (flat).
const config = [
  // .claude/** holds agent worktrees (full repo copies incl. their .next builds).
  // workflows/** = ultracode dynamic-workflow scripts (Workflow-runtime globals
  // like agent()/phase(), not standalone Node modules) — invoked by the scheduled
  // overnight loops, never imported by the app.
  { ignores: ['.next/**', 'node_modules/**', 'node_modules.nosync/**', 'coverage/**', '.vercel/**', '.superpowers/**', '.claude/**', 'workflows/**'] },
  ...nextCoreWebVitals,
  {
    // `react-hooks/purity` flags Date.now() and other impure calls during
    // render. The rule is sound for client components / hooks but produces
    // false positives in Next.js Server Components on `force-dynamic` pages,
    // where each render is a fresh server invocation and impurity is fine.
    // Our dashboard pages legitimately need `Date.now()` to compute
    // time-window analytics per request.
    rules: {
      'react-hooks/purity': 'off',
    },
  },
  {
    // 2026-11-10 (customer data in database error text): console.* prints an
    // error object whole (util.inspect), so a failed query printed its bound
    // values (phones, names, password hashes) and the Postgres detail. App code
    // logs errors through logWarn/logError (src/lib/log.ts), which reduce a
    // query error to one fixed line. Selector syntax: esquery 1.7.0
    // (node_modules/esquery/README.md:10-23, field `Node.field`, regex attrs).
    // This is the only no-restricted-syntax entry for these files: a later
    // config object that sets the rule again would REPLACE this whole list.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='console'] > Identifier.arguments[name=/^(e|err|error|cause|reason|ex|exception)$/]",
          message: 'Do not pass an error object to console.*: use logWarn/logError(scope, err, fields) from src/lib/log.ts.',
        },
        {
          selector:
            "CallExpression[callee.object.name='console'] > :matches(ConditionalExpression, LogicalExpression).arguments > Identifier[name=/^(e|err|error|cause|reason|ex|exception)$/]",
          message: 'Do not pass an error object to console.*: use logWarn/logError(scope, err, fields) from src/lib/log.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='console'] MemberExpression[property.name=/^(message|stack)$/]",
          message: 'Do not print err.message or err.stack with console.*: use logWarn/logError(scope, err, fields) from src/lib/log.ts.',
        },
        {
          selector: "CallExpression[callee.object.name='console'] > CallExpression.arguments[callee.name='String']",
          message: 'Do not print String(value) with console.*: use logWarn/logError(scope, value, fields) from src/lib/log.ts.',
        },
      ],
    },
  },
];

export default config;
