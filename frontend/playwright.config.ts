import { defineConfig, devices } from "@playwright/test";
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
// E2E_*_PORT let two copies of the repository run their suites side by side.
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 5699);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3099);
const GATED_PORT = Number(process.env.E2E_GATED_PORT ?? 3098);

// One server serves the interface and the API, so the page and the calls it
// makes share an origin, as they do for anyone running Evermind.
export const API = `http://127.0.0.1:${WEB_PORT}`;
export const GATED = `http://127.0.0.1:${GATED_PORT}`;
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

/** What a copy of the real server is told: where its data and its interface
 *  are, and its password (empty for the open copy). The settings file is
 *  switched off on the command line (`--no-env-file`), so nothing of the
 *  developer's own .env, password included, can reach it. */
function serverEnv(dataDir: string, password: string) {
  return {
    EVERMIND_DATA_DIR: path.join(root, dataDir),
    // Its own folder, never frontend/dist: building for the tests must not
    // replace the interface of an Evermind that is being used.
    EVERMIND_UI_DIR: path.join(frontend, "dist-e2e"),
    EVERMIND_GATE_PASSWORD: password,
  };
}

const node = JSON.stringify(process.execPath);
const withCleanEnv = JSON.stringify(path.join(frontend, "e2e", "with-clean-env.mjs"));

/** A server that sees `env` and what a program needs to start, and nothing
 *  else. Playwright adds `env` to the environment of the shell the suite was
 *  started from, so the launcher is what keeps the rest out: any other
 *  EVERMIND_* variable there (a port, a list of allowed hosts, a root path)
 *  would change what the tests are talking to. */
function isolated(command: string, env: Record<string, string>) {
  return {
    command: `${node} ${withCleanEnv} ${Object.keys(env).join(",")} -- ${command}`,
    env,
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
      ...isolated(`${python} ../scripts/mock_llm.py ${MOCK_PORT}`, { EVERMIND_MOCK_DELAY: "0.05" }),
      url: `http://127.0.0.1:${MOCK_PORT}/v1/models`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      ...isolated(
        `${python} -m app --no-env-file --host 127.0.0.1 --port ${WEB_PORT}`,
        serverEnv(".e2e-data", ""),
      ),
      cwd: path.join(root, "backend"),
      url: `${API}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      ...isolated(
        `${python} -m app --no-env-file --host 127.0.0.1 --port ${GATED_PORT}`,
        serverEnv(".e2e-data-gate", GATE_PASSWORD),
      ),
      cwd: path.join(root, "backend"),
      url: `${GATED}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
