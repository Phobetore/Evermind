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
  { folder: ".e2e-data", port: Number(process.env.E2E_WEB_PORT ?? 3099) },
  { folder: ".e2e-data-gate", port: Number(process.env.E2E_GATED_PORT ?? 3098) },
];

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

for (const { folder, port } of COPIES) {
  if (await isAnswering(port)) {
    console.log(`Leaving ${folder} as it is: something is answering on port ${port}.`);
    continue;
  }
  rmSync(path.join(root, folder), { recursive: true, force: true });
}
