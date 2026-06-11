import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

// Next.js shared config (flat).
const config = [
  // .claude/** holds agent worktrees (full repo copies incl. their .next builds).
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', '.vercel/**', '.superpowers/**', '.claude/**'] },
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
];

export default config;
