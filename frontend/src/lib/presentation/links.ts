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
// The start of a web address, wherever it stands in a word.
const ADDRESS = /https?:\/\//gi;
// The runs of letters, digits, hyphens and dots a name is made of.
const NAME_RUN = /[\p{L}\p{N}.-]+/gu;
const TOP_LABEL = /^\p{L}{2,}$/u;
const PATH = /[/?#\\]/;
const TRAILING = /[\p{P}\p{S}]/u;

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

interface Shown {
  host: string;
  start: number;
}

/** The names of sites a run of letters, digits, hyphens and dots shows: each longest stretch of
 *  labels that ends on a label of two letters or more (a.b.example), where it starts in the word. */
function namesIn(run: string, offset: number, found: Shown[]) {
  const labels = run.split(".");
  let at = 0;
  let first = -1; // the first label of the stretch, and where it starts
  let firstAt = 0;
  let last = -1; // its last label that can end a name, and where that label ends
  let lastEnd = 0;
  const close = () => {
    if (first >= 0 && last > first) {
      const host = hostOf("https://" + run.slice(firstAt, lastEnd));
      if (host !== null) found.push({ host, start: offset + firstAt });
    }
    first = -1;
    last = -1;
  };
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === "") close();
    else {
      if (first < 0) {
        first = i;
        firstAt = at;
      }
      if (i > first && TOP_LABEL.test(label)) {
        last = i;
        lastEnd = at + label.length;
      }
    }
    at += label.length + 1;
  }
  close();
}

/** The hosts a word of a link's text shows, in order: every web address in it, by the URL parser,
 *  and every name of a site, by its form, whatever stands around them (a quote, a port, a query,
 *  a comma). What stands in the path of the first site shown is its page, not another site; the
 *  part before an @ is a mailbox. "fooled" when an address has a user name before an @. Each
 *  character is read a bounded number of times. */
function hostsOfWord(word: string): Shown[] | "fooled" {
  const found: Shown[] = [];
  // Where the first site shown ends: what follows a / ? # or \ after it is its path.
  let firstEnd = Infinity;

  const starts: number[] = [];
  ADDRESS.lastIndex = 0;
  for (let match = ADDRESS.exec(word); match; match = ADDRESS.exec(word)) starts.push(match.index);
  for (let i = 0; i < starts.length; i++) {
    let end = i + 1 < starts.length ? starts[i + 1] : word.length;
    while (end > starts[i] && word[end - 1] !== "/" && TRAILING.test(word[end - 1])) end--;
    // Nothing after the scheme: no address, and nothing for the parser to read.
    if (end <= word.indexOf("//", starts[i]) + 2) continue;
    let url: URL;
    try {
      url = new URL(word.slice(starts[i], end));
    } catch {
      continue;
    }
    if (url.username !== "" || url.password !== "") return "fooled";
    found.push({ host: url.hostname, start: starts[i] });
    const after = word.slice(starts[i]).indexOf("//") + 2;
    const authority = word.slice(starts[i] + after, end).search(PATH);
    firstEnd = Math.min(firstEnd, authority < 0 ? end : starts[i] + after + authority);
  }

  NAME_RUN.lastIndex = 0;
  for (let match = NAME_RUN.exec(word); match; match = NAME_RUN.exec(word)) {
    const runEnd = match.index + match[0].length;
    // The mailbox of an address: the site is the part after the @.
    if (word[runEnd] === "@") continue;
    const before = found.length;
    namesIn(match[0], match.index, found);
    if (found.length > before) firstEnd = Math.min(firstEnd, runEnd);
  }

  const pathAt = firstEnd === Infinity ? -1 : word.slice(firstEnd).search(PATH);
  const path = pathAt < 0 ? Infinity : firstEnd + pathAt;
  return found.filter((shown) => shown.start < path).sort((a, b) => a.start - b.start);
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

  // Every host the text shows, anywhere in it, word by word; the same word is read once.
  const hosts: string[] = [];
  let fooled = false;
  if (!hidden) {
    const seen = new Map<string, Shown[] | "fooled">();
    for (const word of text.split(/\s+/)) {
      if (word === "") continue;
      let shown = seen.get(word);
      if (shown === undefined) {
        shown = hostsOfWord(word);
        seen.set(word, shown);
      }
      if (shown === "fooled") {
        fooled = true;
        break;
      }
      for (const { host } of shown) hosts.push(host);
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
