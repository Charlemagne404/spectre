import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'Chromium', use: { browserName: 'chromium' } }, { name: 'WebKit', use: { browserName: 'webkit' } }],
  webServer: { command: 'npm run dev', port: 1420, reuseExistingServer: !process.env.CI },
});
