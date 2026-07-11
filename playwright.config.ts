import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: "line",
  use: {
    baseURL,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone-webkit",
      use: {
        ...devices["iPhone 15"],
        browserName: "webkit",
      },
    },
  ],
  webServer: {
    command: "pnpm build && node scripts/run-standalone.mjs",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
