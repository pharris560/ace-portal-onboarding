// Playwright config for the ACE portal smoke test.
// Serves the static index.html on loopback (a secure context, so crypto.subtle works)
// and runs the specs in tests/. All network is stubbed inside the spec — no live Airtable/n8n.
const { defineConfig, devices } = require('@playwright/test');

const PORT = 8848;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
