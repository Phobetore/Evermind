// Which lorebook entries fire, on the rules of community cards, step for step
// backend/app/prompting/lorebook.py: SillyTavern's rules, as its cards are written for
// (keys on whole words, always-on entries, secondary keys, entries that call one another).
// The matching is written out by hand rather than with regular expressions, so that it
// depends on neither language's dialect.

import { substitute } from "./macros";
import { pyLower, pyStrip } from "./text";
import { estimateTokens } from "./tokens";

/** What makes a key several words, and so a plain substring. */
export const SPACES =
  " \t\n\r\f\v                 　";

/** The settings of an entry that the engine reads, all left out by an entry from before them. */
export interface LoreEntrySettings {
  origin?: number | null;
  comment?: string;
  constant?: boolean;
  selective?: boolean;
  secondary_keys?: string[];
  selective_logic?: number;
  insertion_order?: number;
  position?: number;
  depth?: number;
  role?: string;
  whole_words?: boolean;
  exclude_recursion?: boolean;
  prevent_recursion?: boolean;
}

interface LoreEntryLike extends LoreEntrySettings {
  keys?: string[] | null;
  content?: string | null;
  enabled?: boolean | null;
}

/** The defaults of the server's LoreEntryIn, for an entry that says nothing of a setting. */
export const ENTRY_DEFAULTS = {
  enabled: true,
  constant: false,
  selective: false,
  secondary_keys: [] as string[],
  selective_logic: 0,
  insertion_order: 100,
  position: 1,
  depth: 4,
  role: "system",
  whole_words: true,
  exclude_recursion: false,
  prevent_recursion: false,
};

type Defaulted = keyof typeof ENTRY_DEFAULTS;

const BEFORE_THE_CARD = 0; // "before the character's definition", SillyTavern's first place
const AT_A_DEPTH = 4; // "@ depth": among the turns of the story, so many from the end
const OUTLET = 7; // shown only where a {{outlet}} macro asks for it, which Evermind does not have
const REGEX_KEY = /^\/([\s\S]+?)\/([gimsuy]*)$/;
const WORD = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_");

/** Python's `entry.get(name, default)`: a setting left out takes its default. */
function setting<K extends Defaulted>(entry: LoreEntryLike, name: K): (typeof ENTRY_DEFAULTS)[K] {
  const value = entry[name];
  return (value === undefined ? ENTRY_DEFAULTS[name] : value) as (typeof ENTRY_DEFAULTS)[K];
}

// SillyTavern reads such a key as a JavaScript regular expression; Evermind runs none.
const isRegex = (key: string) => REGEX_KEY.test(key);

const isSubstring = (key: string, wholeWords: boolean) =>
  !wholeWords || [...key].some((c) => SPACES.includes(c));

/** Whether a key, trimmed and in lower case, is in the text from `start` on. Before `start`
 *  is text already looked at: no occurrence is counted there, and the character just before
 *  `start` is only ever read as the edge of a word. Counting in UTF-16 units changes
 *  nothing: a half of a pair is no ASCII letter, as the whole character is none. */
function found(key: string, text: string, substring: boolean, start = 0): boolean {
  let index = text.indexOf(key, start);
  if (substring) return index !== -1;
  // Only ASCII letters, digits and _ make a word, as in SillyTavern: "ros" is a word in
  // "rosé", and a key in Japanese, with no spaces, is found anywhere in the text.
  while (index !== -1) {
    const end = index + key.length;
    const before = index > 0 ? text[index - 1] : "";
    const after = end < text.length ? text[end] : "";
    if (!WORD.has(before) && !WORD.has(after)) return true;
    index = text.indexOf(key, index + 1);
  }
  return false;
}

/** Whether a key is in a text already in lower case. Its {{char}} and {{user}} are put in
 *  by the caller, which knows the names. */
export function keyMatches(key: string, text: string, wholeWords: boolean): boolean {
  const cleaned = pyLower(pyStrip(key));
  return !!cleaned && !isRegex(cleaned) && found(cleaned, text, isSubstring(cleaned, wholeWords));
}

/** The content without the lines at its start that begin with @@ (CCv3 decorators, such as
 *  @@activate), nor the line breaks after them: they are for the engine, not the model.
 *  A card written on Windows breaks its lines with \r\n, so both characters go. */
export function stripDecorators(content: string): string {
  let rest = content;
  while (rest.startsWith("@@")) {
    const end = rest.indexOf("\n");
    rest = end === -1 ? "" : rest.slice(end).replace(/^[\r\n]+/, "");
  }
  return rest;
}

function logicHolds(logic: number, seen: number, count: number): boolean {
  if (logic === 1) return seen < count; // not all of them
  if (logic === 2) return seen === 0; // none of them
  if (logic === 3) return seen === count; // all of them
  return seen > 0; // at least one
}

interface Key {
  key: string;
  substring: boolean;
}

/** An entry that has not fired yet, and how many of its keys the text has shown so far. */
class Candidate<E extends LoreEntryLike> {
  readonly constant: boolean;
  readonly excludeRecursion: boolean;
  private readonly logic: number;
  private readonly secondaryCount: number;
  private primary: Key[];
  private secondary: Key[];
  private seenPrimary = 0;
  private seenSecondary = 0;

  constructor(
    readonly index: number,
    readonly entry: E,
    primary: string[],
    secondary: string[],
  ) {
    this.constant = !!setting(entry, "constant");
    this.excludeRecursion = !!setting(entry, "exclude_recursion");
    this.logic = setting(entry, "selective_logic");
    this.secondaryCount = secondary.length;
    const wholeWords = !!setting(entry, "whole_words");
    // The keys still to be seen. One of the form /.../ never is, so it is never looked for.
    const keys = (list: string[]) =>
      list.filter((key) => !isRegex(key)).map((key) => ({ key, substring: isSubstring(key, wholeWords) }));
    this.primary = keys(primary);
    this.secondary = keys(secondary);
  }

  /** The keys still not seen once `added` follows `text`. */
  private static look(keys: readonly Key[], text: string, added: string): Key[] {
    return keys.filter(({ key, substring }) => {
      const tail = text.slice(-(key.length + 1));
      // A tail shorter than the text starts on a character already looked at.
      return !found(key, tail + added, substring, text.length > tail.length ? 1 : 0);
    });
  }

  fires(text: string, added: string): boolean {
    if (this.primary.length) {
      const unseen = Candidate.look(this.primary, text, added);
      this.seenPrimary += this.primary.length - unseen.length;
      this.primary = unseen;
    }
    if (this.secondary.length) {
      const unseen = Candidate.look(this.secondary, text, added);
      this.seenSecondary += this.secondary.length - unseen.length;
      this.secondary = unseen;
    }
    return (
      this.constant ||
      (this.seenPrimary > 0 &&
        (this.secondaryCount === 0 || logicHolds(this.logic, this.seenSecondary, this.secondaryCount)))
    );
  }
}

/** The entries that fire on the text read, then on the contents of those that fired, until
 *  a pass adds nothing; in the lorebook's order.
 *
 *  The answer is that of a full scan of the whole text at each pass. But the text only
 *  grows, so a key once there stays there: each entry keeps which of its keys were seen,
 *  and each pass only looks for the others in what the last pass added, with as much of the
 *  text before as the key is long, plus one, for a key across the join and the character
 *  before it. A chained lorebook of a thousand entries is not a thousand scans of the whole
 *  text: this runs in the tab, a phone's among others. */
export function activated<E extends LoreEntryLike>(
  entries: readonly E[],
  scan: string,
  charName: string,
  userName: string,
): E[] {
  const prepared = (keys: readonly string[] | null | undefined) =>
    (keys || []).map((key) => pyLower(pyStrip(substitute(key, charName, userName)))).filter((key) => key);

  let candidates: Candidate<E>[] = [];
  entries.forEach((entry, index) => {
    if (!setting(entry, "enabled") || setting(entry, "position") === OUTLET) return;
    // Secondary keys count only on a selective entry, and only those left once trimmed.
    const secondary = setting(entry, "selective") ? prepared(setting(entry, "secondary_keys")) : [];
    candidates.push(new Candidate(index, entry, prepared(entry.keys), secondary));
  });

  const fired: Candidate<E>[] = [];
  // `text` is what earlier passes looked at, `added` what this one looks at for the first time.
  let text = "";
  let added = pyLower(scan);
  for (;;) {
    const tried = candidates.map((c) => ({ c, fires: c.fires(text, added) }));
    const newly = tried.filter((t) => t.fires).map((t) => t.c);
    if (!newly.length) break;
    fired.push(...newly);
    // An entry kept out of recursion is only ever tried on the text read.
    candidates = tried.filter((t) => !t.fires && !t.c.excludeRecursion).map((t) => t.c);
    const pieces = newly
      .filter((c) => !setting(c.entry, "prevent_recursion"))
      .map((c) => pyLower(stripDecorators(c.entry.content || "")));
    if (!pieces.length) break;
    text += added;
    added = "\n" + pieces.join("\n");
  }
  return fired.sort((a, b) => a.index - b.index).map((c) => c.entry);
}

/** Python's `sorted(entries, key=insertion order, reverse=reverse)`: stable both ways, so a
 *  tie keeps the order it came in, even reversed. */
function byOrder<E extends LoreEntryLike>(entries: readonly E[], reverse: boolean): E[] {
  const sign = reverse ? -1 : 1;
  return [...entries].sort((a, b) => {
    const x = setting(a, "insertion_order");
    const y = setting(b, "insertion_order");
    return x < y ? -sign : x > y ? sign : 0;
  });
}

/** Of the entries that fired, in the lorebook's order, those the budget holds, as they are
 *  to be placed. The highest insertion order goes first, the lorebook's order deciding a tie;
 *  one that does not fit is passed over for the next, so that a large entry does not silence
 *  small ones. They are placed lowest order first, as SillyTavern does, the highest nearest
 *  the end where the model reads last; the sorts are stable, so a tie keeps the lorebook's
 *  order both times. */
export function withinBudget<E extends LoreEntryLike>(entries: readonly E[], budget: number): E[] {
  const kept: E[] = [];
  let room = budget;
  for (const entry of byOrder(entries, true)) {
    const cost = estimateTokens(entry.content || "");
    if (cost > room) continue;
    room -= cost;
    kept.push(entry);
  }
  return byOrder(kept, false);
}

/** Whether an entry goes before the character's definition rather than after it. */
export const beforeTheCard = (entry: LoreEntryLike) => setting(entry, "position") === BEFORE_THE_CARD;

/** Whether an entry is said among the turns of the story, at its depth. */
export const atADepth = (entry: LoreEntryLike) => setting(entry, "position") === AT_A_DEPTH;

/** How many turns from the end an entry at a depth is said. */
export const depthOf = (entry: LoreEntryLike) => setting(entry, "depth");
