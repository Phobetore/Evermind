import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

/**
 * The whole stack, on ports of its own so a run never collides with an
 * Evermind someone is actually using on this machine.
 *
 * Two copies of the real server run: one open, for nearly every test, and one
 * behind an access password, for the tests about the password. Each has a
 * data directory of its own too. Tests create characters and send messages;
 * pointed at a real one they would write into somebody's conversations.
 */
// A developer's own settings must not reach the servers this suite starts: they
// inherit this environment. Proxy variables would route the calls to the model.
for (const name of Object.keys(process.env)) {
  if (/^(evermind_|bind$|port$|semantic$|(http|https|all)_proxy$|no_proxy$)/i.test(name)) {
    delete process.env[name];
  }
}

// E2E_*_PORT let two copies of the repository run their suites side by side.
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 5699);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3099);
const GATED_PORT = Number(process.env.E2E_GATED_PORT ?? 3098);

// The servers listen on this computer's address on the network, as they do for
// the phone that uses Evermind: over plain HTTP there, the browser withholds the
// APIs of a secure context. Without a network, the loopback.
const HOST = Object.values(os.networkInterfaces()).flat()
  .find((i) => i?.family === "IPv4" && !i.internal)?.address ?? "127.0.0.1";

// One server serves the interface and the API, so the page and the calls it
// makes share an origin, as they do for anyone running Evermind.
export const API = `http://${HOST}:${WEB_PORT}`;
export const GATED = `http://${HOST}:${GATED_PORT}`;
export const GATE_PASSWORD = "e2e-secret";

// import.meta rather than __dirname: the package is an ES module.
const frontend = import.meta.dirname;
const root = path.resolve(frontend, "..");

// Absolute, and quoted at the point of use: a relative path with forward
// slashes is not something cmd.exe will run.
const python = JSON.stringify(path.resolve(
  root, "backend", ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
));

/** What a copy of the real server is told: where it listens, where its data and
 *  its interface are, and its password (empty for the open copy). The settings
 *  file is switched off (`--no-env-file`), so nothing of the developer's own
 *  .env, password included, can reach it. */
function serverEnv(port: number, dataDir: string, password: string) {
  return {
    BIND: HOST,
    PORT: String(port),
    EVERMIND_DATA_DIR: path.join(root, dataDir),
    // Its own folder, never frontend/dist: building for the tests must not
    // replace the interface of an Evermind that is being used.
    EVERMIND_UI_DIR: path.join(frontend, "dist-e2e"),
    EVERMIND_GATE_PASSWORD: password,
  };
}

// The phone runs every spec. Desktop runs only what could differ with a mouse and a wide
// screen: the one path through a chat, the widths, and hover.
const ON_DESKTOP = ["chat", "responsive", "touch"].map((name) => `**/${name}.spec.ts`);

export default defineConfig({
  testDir: "./e2e",
  // The tests share the servers below, so they take turns rather than racing
  // each other through them.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: API,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "desktop", testMatch: ON_DESKTOP, use: { ...devices["Desktop Chrome"] } },
    // The phone is not a nicety here: every layout bug this suite exists for
    // was invisible at desktop width.
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],

  webServer: [
    {
      // Quick, because nearly every test waits for a reply in its setup and only
      // needs it to exist. A test about what happens while a reply is being
      // written asks for a slow one in the conversation (`slowly` in
      // e2e/fixtures.ts), and this does not change how slow that is.
      command: `${python} ../scripts/mock_llm.py ${MOCK_PORT}`,
      env: { EVERMIND_MOCK_DELAY: "0.05" },
      url: `http://127.0.0.1:${MOCK_PORT}/v1/models`,
      timeout: 30_000,
    },
    {
      command: `${python} -m app --no-env-file`,
      env: serverEnv(WEB_PORT, ".e2e-data", ""),
      cwd: path.join(root, "backend"),
      url: `${API}/api/health`,
      timeout: 60_000,
    },
    {
      command: `${python} -m app --no-env-file`,
      env: serverEnv(GATED_PORT, ".e2e-data-gate", GATE_PASSWORD),
      cwd: path.join(root, "backend"),
      url: `${GATED}/api/health`,
      timeout: 60_000,
    },
  ],
});
