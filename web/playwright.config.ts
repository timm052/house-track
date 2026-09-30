// Browser tests of the main screens, at desktop and phone sizes, against a running House Track (the dev stack by
// default: `docker compose -p housetrack-dev ... up`). Run with `npm run e2e`; E2E_URL points them elsewhere.
// Each run adds its own test house and deletes it afterwards.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,  // one household's data, so one test at a time
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: process.env.E2E_URL ?? "http://localhost:8080", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
});
