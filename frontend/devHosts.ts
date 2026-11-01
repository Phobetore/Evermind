// The host names, besides addresses and localhost (which Vite lets through by
// itself), that the API answers to without a password: this computer's name and
// its first label, each also with .local, and the names listed in
// EVERMIND_ALLOWED_HOSTS (see _known_host in backend/app/gate.py). Vite checks
// Host before a request reaches the API, so with `dev --lan` it would answer
// 403 to http://nas:3000 itself. It is a list, never `true`, so a website
// whose name was pointed at this computer still meets Vite's refusal.
//
// It lives apart from vite.config.ts so that a test can import it, and it takes
// the computer's name as an argument so that the test does not depend on the
// computer it runs on.
export function allowedHosts(machineName: string, listed: string): string[] {
  const machine = machineName.toLowerCase();
  const own = [machine, machine.split(".")[0]].filter(Boolean);
  const names = [...own, ...own.map((name) => name + ".local")];
  for (const entry of listed.split(",")) {
    // The API reads an entry as a name without port or final dot, and Vite
    // would take one that starts with a dot for every name under it.
    const name = entry.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    if (/^[\w-][\w.-]*$/.test(name)) names.push(name);
  }
  return [...new Set(names)];
}
