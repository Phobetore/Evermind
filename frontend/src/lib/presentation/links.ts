/** Where a link of a card may lead: an absolute http, https or mailto address, as the URL parser
 *  writes it; null for anything else (a relative path, which would be a page of the app, an
 *  address at `appOrigin` itself, javascript:, data:, an address with a user name or password).
 *  appOrigin: location.origin in the page; left out in tests that do not need it. */
export function linkTarget(href: unknown, appOrigin?: string): string | null {
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    // Without a base, a relative address throws: it would be a page of the app.
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return null;
  // In https://bank.example@evil.example the part before @ is only there to fool the eye.
  if (url.username !== "" || url.password !== "") return null;
  if (appOrigin !== undefined && url.origin === appOrigin) return null;
  return url.href;
}

/** The real site, and the one the link's text shows when it shows one, when the text shows the
 *  address of another site or could be read as another one; null otherwise. */
export interface Misleading {
  real: string;
  shown: string | null;
}

// Characters that change the direction or the order of what is shown, and characters without
// width: what the eye reads is no longer what is written.
const HIDDEN = /[​-‏‪-‮⁦-⁩﻿]/;
// The dots that look like a dot, read as one by the URL parser in a host name.
const DOTS = /[。．｡]/g;
const EDGES = new Set([..."()[]<>\"'.,;:!?«»"]);

/** A word without the punctuation around it, trimmed by hand: an expression anchored at the
 *  end would be tried from every character of a long run of dots. */
function trimEdges(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && EDGES.has(word[start])) start++;
  while (end > start && EDGES.has(word[end - 1])) end--;
  return word.slice(start, end);
}
const DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}$/u;
const DOMAIN_AND_PATH = /^([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})(?:\/.*)?$/u;

function hostOf(address: string): string | null {
  try {
    return new URL(address).hostname;
  } catch {
    return null;
  }
}

function comparable(host: string): string {
  let value = host.toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.startsWith("www.")) value = value.slice(4);
  return value;
}

/** The host a word of a link's text shows, "fooled" when it shows an address with a user name
 *  before an @, or null when it shows none. */
function shownHost(word: string): string | null | "fooled" {
  if (/^https?:\/\//i.test(word)) {
    let url: URL;
    try {
      url = new URL(word);
    } catch {
      return null;
    }
    if (url.username !== "" || url.password !== "") return "fooled";
    return url.hostname;
  }
  const at = word.indexOf("@");
  if (at >= 0) {
    if (word.indexOf("@", at + 1) >= 0) return null;
    const domain = word.slice(at + 1);
    return DOMAIN.test(domain) ? hostOf("https://" + domain) : null;
  }
  return DOMAIN_AND_PATH.test(word) ? hostOf("https://" + word) : null;
}

export function misleadingHost(shown: string, target: string): Misleading | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  // The host as the parser writes it: an international name in its xn-- form, which does not
  // disguise itself.
  const real =
    url.protocol === "mailto:"
      ? hostOf("https://" + url.pathname.slice(url.pathname.lastIndexOf("@") + 1)) ?? ""
      : url.hostname;

  const text = shown.trim().replace(DOTS, ".");
  const hidden = HIDDEN.test(text);

  // Every host the text shows, anywhere in it, in one pass over its words; the same word is
  // read once.
  const hosts: string[] = [];
  let fooled = false;
  if (!hidden) {
    const seen = new Map<string, string | null | "fooled">();
    for (const raw of text.split(/\s+/)) {
      const word = trimEdges(raw);
      if (word === "") continue;
      let host = seen.get(word);
      if (host === undefined) {
        host = shownHost(word);
        seen.set(word, host);
      }
      if (host === "fooled") {
        fooled = true;
        break;
      }
      if (host !== null) hosts.push(host);
    }
  }

  // A letter of another script that imitates a Latin one cannot be seen, even when the text and
  // the target say the same name.
  if (real.split(".").some((label) => label.startsWith("xn--")))
    return { real, shown: hidden || fooled ? null : hosts[0] ?? null };
  if (hidden || fooled) return { real, shown: null };
  if (hosts.length === 0) return null;
  const expected = comparable(real);
  for (const host of hosts) if (comparable(host) !== expected) return { real, shown: host };
  return null;
}
