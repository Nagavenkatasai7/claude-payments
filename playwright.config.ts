import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'https://smartremit.ai',
    trace: 'on-first-retry',
    // Vercel "Protection Bypass for Automation": lets the preview smoke reach
    // password/SSO-protected preview deployments. The bypass header is sent on
    // the initial request; x-vercel-set-bypass-cookie makes Vercel set a cookie
    // so subsequent in-browser navigations stay bypassed. Only active when the
    // secret is in the env — the prod smoke (no secret) is unaffected.
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? {
          extraHTTPHeaders: {
            'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
            'x-vercel-set-bypass-cookie': 'true',
          },
        }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
