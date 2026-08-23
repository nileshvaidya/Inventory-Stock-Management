import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
      // Without an explicit proxy, a sandboxed dev environment can silently
      // drop (rather than reject) outbound connections to a placeholder
      // Supabase host, hanging Chromium on connect instead of failing
      // fast. Every test here mocks the Supabase HTTP layer via
      // page.route() precisely so no real request should ever escape, but
      // routing through the sandbox's own egress proxy turns any that
      // slip through into an immediate rejection instead of a hang. No-op
      // in CI/real environments where this proxy doesn't exist.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PROXY
        ? { args: [`--proxy-server=${process.env.PLAYWRIGHT_CHROMIUM_PROXY}`] }
        : {}),
    },
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'placeholder-anon-key',
      VITE_DEMO_MODE: 'true',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
