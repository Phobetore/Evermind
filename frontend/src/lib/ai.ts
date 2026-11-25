import type { Translate as T } from "@/i18n/I18nProvider";
import { translate } from "@/i18n/translate";
import type { Ai, Conversation, ProbeModel } from "@/types";
import { pages } from "./estimate";
import { timeAgo } from "./utils";

// Pages are worked out beside the estimate, which the browser suite reads without the language
// files; offered here still, where every line of an AI finds them.
export { PAGE_TOKENS, pages } from "./estimate";

/** The room a reply needs by its length, as the server's ways count it. */
export const REPLY_ROOM = { short: 512, medium: 1024, long: 2048 } as const;

/** The room a conversation's reply needs, until the page reads its way: right under Balanced and
 *  under a length the conversation adjusted, which is all a sheet's warning weighs for now. */
export function roomFor(conversation: Pick<Conversation, "play_overrides">): number {
  return REPLY_ROOM[conversation.play_overrides?.reply_length ?? "medium"];
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

/** Ascending, a missing value after every present one. */
function ascending(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a - b;
}

/** Hits by score first, then the key, then its second key (a sort alone would list 98 rows that
 *  read alike in the server's order), then the server's order. `cheapest` is what a row costs, the
 *  estimate's cheapestKey under the way offered (lib/estimate.ts); null sorts last. */
export function sortRows(
  hits: Hit[],
  key: SortKey,
  collator: Intl.Collator,
  cheapest: (row: ProbeModel) => number | null,
): ProbeModel[] {
  const keyed = hits.map((hit, index) => ({ hit, index }));
  const byKey = (a: ProbeModel, b: ProbeModel): number => {
    switch (key) {
      case "newest":
        return ascending(negate(a.created), negate(b.created));
      case "cheapest":
        return ascending(cheapest(a), cheapest(b)) || ascending(negate(reads(a)), negate(reads(b)));
      case "reads":
        return ascending(negate(reads(a)), negate(reads(b))) || ascending(cheapest(a), cheapest(b));
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

/** The AI a conversation shows as answering it: the one it names, else the first listed, the
 *  default, which is the one the server answers it with (models.resolve). Null with none at all. */
export function answering(modelId: string | null, ais: Ai[]): Ai | null {
  return ais.find((ai) => ai.id === modelId) ?? ais[0] ?? null;
}

/** The ceiling of its own an AI keeps below the room a reply needs, which cuts long replies short;
 *  null when it keeps none, or one with room enough. */
export function cappedUnder(ai: Ai, room: number): number | null {
  const { mode, tokens } = ai.reply_cap;
  return mode === "fixed" && tokens !== null && tokens < room ? tokens : null;
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
  return tokens === null ? t("ai.readsUntold") : t("ai.reads", { count: pages(tokens) });
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

/** What the person typed that the server says is too much, by the rule of the server's
 *  models.warnings, which only a save answers with: read here from the AI as it is, the sentence
 *  stays beside the figure for as long as the figure stays. */
export type Warning = "above_read_window" | "above_read_output" | "cap_above_window";

/** The least the engine's budget leaves the story (engine.py). */
const ENGINE_FLOOR = 512;

export function warningsOf(ai: Ai): Warning[] {
  const said: Warning[] = [];
  const { own, read, used } = ai.context;
  if (own !== null && read !== null && own > read) said.push("above_read_window");
  const { mode, tokens } = ai.reply_cap;
  if (mode === "fixed" && tokens !== null) {
    if (ai.output_read !== null && tokens > ai.output_read) said.push("above_read_output");
    if (tokens + ENGINE_FLOOR > used) said.push("cap_above_window");
  }
  return said;
}
