import { defineConfig } from '@playwright/test';
const port = Number(process.env.BEADIFY_TEST_PORT || 5174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BEADIFY_TEST_PORT');
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.BEADIFY_CHROMIUM ? { executablePath: process.env.BEADIFY_CHROMIUM } : {},
    trace: 'retain-on-failure',
  },
  webServer: { command: `node scripts/dev-server.cjs ${port}`, url: baseURL, reuseExistingServer: false },
});
