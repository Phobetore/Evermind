import type { Translate as T } from "@/i18n/I18nProvider";
import { translate } from "@/i18n/translate";
import type { Ai, ProbeModel, Settings } from "@/types";
import { timeAgo } from "./utils";

/** About 1 750 characters at the engine's 3.5 per token. */
export const PAGE_TOKENS = 500;

/** The room a reply needs, as the server's ai_call.reply_room counts it until the ways of playing
 *  exist: plan 3 replaces this one function, as it replaces the server's. */
export const REPLY_ROOM = { short: 512, medium: 1024, long: 2048 } as const;

export function roomFor(settings: Pick<Settings, "reply_length">): number {
  return REPLY_ROOM[settings.reply_length];
}

/** Tokens as pages: from 100 pages up to the nearest 10, which is all the figure is worth there;
 *  below, rounded and never less than one, so a small window does not read as nothing. */
export function pages(tokens: number): number {
  const exact = tokens / PAGE_TOKENS;
  return exact >= 100 ? Math.round(exact / 10) * 10 : Math.max(1, Math.round(exact));
}

const SEPARATOR = /[ \-_/:]/;
const WHOLE_NAME = 14;
const LAST_WORD = 12;
const LAST_LETTERS = 7;

/** A name cut in the middle, so that the end that tells two models of one family apart stays in
 *  sight when the head is cut with an ellipsis. */
export function splitName(name: string): [head: string, tail: string] {
  const letters = Array.from(name);
  if (letters.length <= WHOLE_NAME) return [name, ""];
  let at = letters.length - 1;
  while (at >= 0 && !SEPARATOR.test(letters[at])) at--;
  const word = letters.length - at - 1;
  const cut = at >= 0 && word >= 1 && word <= LAST_WORD ? at : letters.length - LAST_LETTERS;
  return [letters.slice(0, cut).join(""), letters.slice(cut).join("")];
}

/** What a search compares: lower case, accents and marks gone, and every character that is not a
 *  letter or a digit, so that "Sylve 2.5", "sylve-2-5" and "sylve25" meet. */
export function normalised(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** The pieces of a text between separators, each normalised, the empty ones dropped. */
function wordsOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}\p{M}]+/u).map(normalised).filter(Boolean);
}

export interface Searchable {
  row: ProbeModel;
  name: string;
  nameWords: string[];
  rest: string;
  restWords: string[];
}

const NEW_DAYS = 30;

/** Made once per row, so that a keystroke only compares. The name part is the name shown; the rest
 *  is the vendor, the id and the words of the tags the row prints, in the page's language and in
 *  English, because a model's tags are searched by either. */
export function searchable(row: ProbeModel, readAt: string, t: T): Searchable {
  const tags: string[] = [];
  const tag = (key: string) => tags.push(t(key), translate("en", key));
  if (freeOnly(row)) tag("ai.free");
  if (isNew(row, readAt)) tag("ai.new");
  if (row.reasons === true) tag("ai.thinks");
  const rest = [row.vendor ?? "", row.id, ...tags].join(" ");
  return { row, name: normalised(row.name), nameWords: wordsOf(row.name), rest: normalised(rest), restWords: wordsOf(rest) };
}

/** Optimal string alignment (an edit is an insertion, a deletion, a substitution or a swap of two
 *  neighbouring letters) of `pattern` against all of `text`, or, with `inside`, against the closest
 *  substring of it. */
function distance(pattern: string[], text: string[], inside: boolean): number {
  const m = pattern.length;
  const n = text.length;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const line = new Array<number>(n + 1).fill(0);
    line[0] = i;
    return line;
  });
  for (let j = 1; j <= n; j++) d[0][j] = inside ? 0 : j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const same = pattern[i - 1] === text[j - 1];
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (same ? 0 : 1));
      if (i > 1 && j > 1 && pattern[i - 1] === text[j - 2] && pattern[i - 2] === text[j - 1]) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
    }
  }
  return inside ? Math.min(...d[m]) : d[m][n];
}

/** One edit at most between `word` and a stretch of ONE of `words`, never across two: "gemini" is
 *  not near ["sylve", "mini"] although "sylvemini" holds "vemini". */
export function near(word: string, words: string[]): boolean {
  const letters = Array.from(word);
  return words.some((w) => distance(letters, Array.from(w), true) <= 1);
}

export interface Hit {
  row: ProbeModel;
  score: number;
}

/** The least a word must have to be read as a typo at all: under it, one edit is most of the word. */
const TYPO_LETTERS = 5;

/** A row is a hit when EVERY word of the query is found, in any order. A word scores 0 found in the
 *  name, 1 elsewhere on the row; a word of 5 letters or more that NO row holds exactly may instead
 *  be near, 2 in the name's words, 3 in the others: "large" finds the rows that say large, not
 *  "Sillage". The hits keep the order of `rows`. */
export function search(rows: Searchable[], query: string): Hit[] {
  const words = query.split(/\s+/).map(normalised).filter(Boolean);
  if (words.length === 0) return rows.map((r) => ({ row: r.row, score: 0 }));
  const mayBeNear = words.map(
    (w) => Array.from(w).length >= TYPO_LETTERS && !rows.some((r) => r.name.includes(w) || r.rest.includes(w)),
  );
  const hits: Hit[] = [];
  for (const r of rows) {
    let score = 0;
    let all = true;
    for (let i = 0; i < words.length && all; i++) {
      const w = words[i];
      if (r.name.includes(w)) continue;
      if (r.rest.includes(w)) score += 1;
      else if (mayBeNear[i] && near(w, r.nameWords)) score += 2;
      else if (mayBeNear[i] && near(w, r.restWords)) score += 3;
      else all = false;
    }
    if (all) hits.push({ row: r.row, score });
  }
  return hits;
}

const SUGGESTED = 3;
const SUGGESTED_WORD = 4;

/** Names to offer when nothing is found. A name is suggested when every word of the query of 4
 *  letters or more is within a third of the shorter of the two words, in edits, of a word of 4
 *  letters or more of the name: short words are not used (the near-miss of "gpt" is anything), and
 *  a query with none suggests nothing. Nearest first, then the shortest name. */
export function suggestions(rows: Searchable[], query: string): string[] {
  const words = query.split(/\s+/).map(normalised).filter((w) => Array.from(w).length >= SUGGESTED_WORD);
  if (words.length === 0) return [];
  const found: { name: string; edits: number; index: number }[] = [];
  rows.forEach((r, index) => {
    const own = r.nameWords.filter((w) => Array.from(w).length >= SUGGESTED_WORD);
    let edits = 0;
    for (const w of words) {
      const letters = Array.from(w);
      let best: number | null = null;
      for (const o of own) {
        const other = Array.from(o);
        const d = distance(letters, other, false);
        if (d <= Math.floor(Math.min(letters.length, other.length) / 3)) best = best === null ? d : Math.min(best, d);
      }
      if (best === null) return;
      edits += best;
    }
    found.push({ name: r.row.name, edits, index });
  });
  found.sort((a, b) => a.edits - b.edits || a.name.length - b.name.length || a.index - b.index);
  return [...new Set(found.map((f) => f.name))].slice(0, SUGGESTED);
}

export type SortKey = "service" | "newest" | "cheapest" | "reads" | "name";

/** What a row reads at once, as far as anything says. */
function reads(row: ProbeModel): number | null {
  return row.context.served ?? row.context.configured ?? row.context.max;
}

/** The weight of a message of the reference story of the design (about 9 000 tokens read for 450
 *  written): until plan 3 replaces this one function with its estimate, which ranks a model that
 *  thinks on its fuller figure, such a row is ranked on this floor. Null when the price is not read
 *  or varies. */
export function cheapestKey(row: ProbeModel): number | null {
  const { input, output, varies } = row.price;
  if (varies || input === null || output === null) return null;
  return input + output * 0.05;
}

/** Ascending, a missing value after every present one. */
function ascending(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/** Hits by score first, then the key, then its second key (a sort alone would list 98 rows that
 *  read alike in the server's order), then the server's order. */
export function sortRows(hits: Hit[], key: SortKey, collator: Intl.Collator): ProbeModel[] {
  const keyed = hits.map((hit, index) => ({ hit, index }));
  const byKey = (a: ProbeModel, b: ProbeModel): number => {
    switch (key) {
      case "newest":
        return ascending(negate(a.created), negate(b.created));
      case "cheapest":
        return ascending(cheapestKey(a), cheapestKey(b)) || ascending(negate(reads(a)), negate(reads(b)));
      case "reads":
        return ascending(negate(reads(a)), negate(reads(b))) || ascending(cheapestKey(a), cheapestKey(b));
      case "name":
        return collator.compare(a.name, b.name);
      default:
        return 0;
    }
  };
  keyed.sort((a, b) => a.hit.score - b.hit.score || byKey(a.hit.row, b.hit.row) || a.index - b.index);
  return keyed.map((k) => k.hit.row);
}

function negate(value: number | null): number | null {
  return value === null ? null : -value;
}

/** A filter of the list: a later one is one more of these. */
export type RowFilter = (row: ProbeModel) => boolean;

/** Both prices read, and nothing. A model that outputs text and music at 0 arrives with no price
 *  (catalog), so it is not "free" here. */
export const freeOnly: RowFilter = (row) => row.price.input === 0 && row.price.output === 0;

/** Who answers the conversations of an AI that goes, by the server's rule (models.successor): the
 *  default; when it is the default itself, the oldest of the others; nobody when it is the last. */
export function successorOf(ai: Ai, ais: Ai[]): Ai | null {
  const others = ais.filter((other) => other.id !== ai.id);
  if (!ai.is_default) return others.find((other) => other.is_default) ?? null;
  let oldest: Ai | null = null;
  for (const other of others) {
    if (oldest === null || Date.parse(other.created_at) < Date.parse(oldest.created_at)) oldest = other;
  }
  return oldest;
}

/** Created within the 30 days before the list was read. */
export function isNew(row: ProbeModel, readAt: string): boolean {
  const read = Date.parse(readAt);
  if (row.created === null || Number.isNaN(read)) return false;
  return read - row.created * 1000 <= NEW_DAYS * 86_400_000;
}

/** "List read 2 min ago". Under a minute the clock is not worth a figure. */
export function ageLine(readAt: string, now: number, t: T): string {
  const read = Date.parse(readAt);
  if (Number.isNaN(read)) return "";
  if (now - read < 60_000) return t("ai.listReadNow");
  return t("ai.listRead", { age: timeAgo(readAt, t, now) });
}

/** Where its service is: "OpenRouter, online". The address says it, whatever the family. */
export function serviceLine(ai: Ai, t: T): string {
  const { name, local, loopback } = ai.service;
  return t(loopback ? "ai.serviceOnThisPc" : local ? "ai.serviceOnYourNetwork" : "ai.serviceOnline", { name });
}

export function readsLine(tokens: number | null, t: T): string {
  return tokens === null ? t("ai.readsUntold") : t("ai.reads", { pages: pages(tokens) });
}

/** What it costs: free, the price read or typed (the one typed wins), or why there is none. */
export function priceLine(price: Ai["price"], free: boolean, t: T): string {
  const input = price.own_in ?? price.read_in;
  const output = price.own_out ?? price.read_out;
  if (free || (input === 0 && output === 0)) return t("ai.free");
  if (price.varies) return t("ai.priceVaries");
  if (input === null || output === null) return t("ai.priceNone");
  return t("ai.priceKnown", { input, output });
}
