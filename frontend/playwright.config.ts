import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * The whole stack, on ports of its own so a run never collides with an
 * Evermind someone is actually using on this machine.
 *
 * The backend gets a data directory of its own too. Tests create characters
 * and send messages; pointed at a real one they would write into somebody's
 * conversations.
 */
const MOCK_PORT = 5699;
const API_PORT = 8099;
const WEB_PORT = 3099;

export const API = `http://127.0.0.1:${API_PORT}`;

// Absolute, and quoted at the point of use: a relative path with forward
// slashes is not something cmd.exe will run.
const python = JSON.stringify(path.resolve(
  __dirname, "..", "backend", ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
));

export default defineConfig({
  testDir: "./e2e",
  // Everything here drives one shared backend, so tests take turns rather than
  // racing each other through it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // The phone is not a nicety here: every layout bug this suite exists for
    // was invisible at desktop width.
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],

  webServer: [
    {
      command: `${python} ../scripts/mock_llm.py ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MOCK_PORT}/v1/models`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // Slower than the default on purpose. Several tests are about what
      // happens while a reply is being written, and at full speed the reply is
      // finished before a second browser has opened the page — which passes on
      // a fast laptop and fails on a CI runner.
      env: { EVERMIND_MOCK_DELAY: "0.15" },
    },
    {
      command: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: "../backend",
      url: `${API}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { EVERMIND_DATA_DIR: "../.e2e-data" },
    },
    {
      // dev rather than a build: `next build` bakes the API address in and
      // would overwrite the .next of whatever is running on this machine.
      command: `npm run dev -- -p ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { EVERMIND_BACKEND_URL: API },
    },
  ],
});
