// Starts a run of the browser suite on clean data, as CI does.
//
//   node e2e/clean-data.mjs
//
// The two copies of the server keep what the tests make in folders of their own, which tests only
// add to: run after run, thousands of cards make tests about something else fail. Only these two
// folders are ever touched, by name.
//
// A copy that is already running is left alone, its data is in use: the suite
// will refuse to start on a port that is taken.
//
// The open copy then starts on a database as the release before AIs left it, with one connection
// on it (scripts/make_legacy_db.py): its server makes it an AI brought over, as an update does,
// and the whole suite runs on a database that was migrated. Only written where the folder was
// just removed: nothing is ever written into data in use.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

// As in playwright.config.ts, which a plain script cannot import.
// A private address is preferred: a tunnel adapter can list a public one first.
const addresses = Object.values(os.networkInterfaces()).flat()
  .filter((i) => i?.family === "IPv4" && !i.internal).map((i) => i.address);
const HOST = addresses.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a))
  ?? addresses[0] ?? "127.0.0.1";
const COPIES = [
  { folder: ".e2e-data", port: Number(process.env.E2E_WEB_PORT ?? 3099), legacy: true },
  { folder: ".e2e-data-gate", port: Number(process.env.E2E_GATED_PORT ?? 3098), legacy: false },
];
// As in playwright.config.ts: the connection points at the mock server the suite starts.
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 5699);
const python = path.resolve(
  root, "backend", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);

function isAnswering(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port, timeout: 1000 });
    const settle = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

for (const { folder, port, legacy } of COPIES) {
  if (await isAnswering(port)) {
    console.log(`Leaving ${folder} as it is: something is answering on port ${port}.`);
    continue;
  }
  rmSync(path.join(root, folder), { recursive: true, force: true });
  if (legacy) {
    const made = spawnSync(python, [
      path.join(root, "scripts", "make_legacy_db.py"), path.join(root, folder), "--mock-port", String(MOCK_PORT),
    ], { stdio: "inherit" });
    if (made.status !== 0) {
      console.error(`Could not write the database ${folder} starts on.`);
      process.exit(1);
    }
  }
}
