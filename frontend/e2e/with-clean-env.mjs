// Runs a program with an environment built from scratch.
//
//   node e2e/with-clean-env.mjs NAME,NAME,... -- program [arguments...]
//
// The program gets the variables a program needs in order to start at all, and
// the ones named on the command line, taken from this process's environment.
// Nothing else comes through. Playwright cannot do this itself: whatever it is
// given under `webServer.env` is added to the environment of the shell it was
// started from, never put in its place.
//
// The names are listed here because the alternative, deleting what is known to
// get in the way, only works until somebody adds a setting. The shell of a
// developer who uses Evermind has EVERMIND_* variables in it; a proxy variable
// would send the server's calls to the model through the proxy.

import { spawn } from "node:child_process";

/** What Python and Node need to start, and to find a temporary folder, a home
 *  and the system's own libraries, on Windows and on Linux. Windows variable
 *  names are not case-sensitive, and neither is the lookup below. */
const SYSTEM = [
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE",
  // A Python that was not installed under /usr finds its shared library here.
  "LD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ",
];

const [names, separator, program, ...args] = process.argv.slice(2);
if (names === undefined || separator !== "--" || !program) {
  console.error("usage: with-clean-env.mjs NAME,NAME,... -- program [arguments...]");
  process.exit(2);
}

const env = {};
for (const name of [...SYSTEM, ...names.split(",").filter(Boolean)]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}

const child = spawn(program, args, { env, stdio: "inherit", windowsHide: true });
// Playwright ends a run by killing the whole process tree outright, so nothing
// below is needed for that. It is for the suite being stopped by hand, so that
// the server is not left holding its port.
//
// Ctrl+C reaches the server by itself: the terminal sends it to every process
// of the group, this one included. Sending it on would be a second Ctrl+C to a
// server that is still shutting down, which is how uvicorn is told to stop
// waiting for its connections; so the launcher only stays out of the way until
// the server is gone. A plain `kill` is different, it reaches the launcher
// alone, and SIGTERM is passed on.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", (error) => {
  console.error(`could not start ${program}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
