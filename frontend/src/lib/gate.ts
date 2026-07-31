/** LAN access gate — off unless EVERMIND_GATE_PASSWORD is set.
 *
 * There is deliberately no default password. Evermind binds to localhost out of
 * the box, where a gate protects nothing, and a default shipped in a public
 * repository would be known to everyone it was meant to keep out. Opening the
 * app to the network is the moment to choose a password, so that is where the
 * decision lives.
 *
 * Server-side only: never import from a client component. This is a speed bump
 * for a trusted local network, not authentication (one shared secret, clear over
 * HTTP, no accounts). The cookie stores an opaque token DERIVED from the
 * password (not the password itself), so it cannot be bypassed by hand-setting a
 * truthy cookie, and changing the password invalidates old cookies.
 */

export const GATE_COOKIE = "evermind_gate";
export const GATE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function gatePassword(): string {
  return process.env.EVERMIND_GATE_PASSWORD ?? "";
}

export function gateEnabled(): boolean {
  return gatePassword().length > 0;
}

/** cyrb53: fast deterministic non-crypto hash. Synchronous, dependency-free,
 * works in both the edge and node runtimes. Enough to keep the cookie opaque. */
function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function gateToken(): string {
  return cyrb53("evermind:" + gatePassword());
}
