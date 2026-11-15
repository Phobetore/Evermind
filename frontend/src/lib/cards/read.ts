import type { CardCharacter, CardText, LoreEntryInput } from "@/data";
import { NAME_TAG_RE } from "@/engine/macros";
import { pyStrip } from "@/engine/text";
import type { NoteRole } from "@/types";
import { reportOf, type ImportReport } from "./report";

// Reading a card as SillyTavern does, where the specification and it differ: the cards are written
// for SillyTavern. What is not read stays in the card, kept whole for its export.

/** The card fields Evermind reads, by their name in the card → in Evermind. */
export const FIELDS = {
  name: "name",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  first_mes: "greeting",
  mes_example: "example_dialogues",
  creator_notes: "creator_notes",
  system_prompt: "system_prompt",
  post_history_instructions: "post_history_instructions",
  creator: "creator",
  character_version: "character_version",
} as const;

/** The flat shape of Pygmalion and text-generation-webui, by its name → the card's. */
const PYGMALION = {
  char_name: "name",
  char_persona: "description",
  char_greeting: "first_mes",
  world_scenario: "scenario",
  example_dialogue: "mes_example",
} as const;

const WHOLE = Number.MAX_SAFE_INTEGER; // what JSON and JavaScript both hold exactly, as the server bounds it
const DEPTH = 4; // SillyTavern's, for a note or an entry whose depth cannot be read
const ROLES: readonly NoteRole[] = ["system", "user", "assistant"];
/** The longest name, or nickname, the server takes, counted as it counts, in code points. */
export const NAME_LENGTH = 200;

export interface ReadCard {
  character: CardCharacter;
  original: CardText;
  report: ImportReport;
  /** The first sentence of the presentation, without its layout: offered as the tagline. */
  suggestedTagline: string;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a card says it is a V3 of a version after 3.0, which Evermind reads, and writes back, all the same. */
export const isNewerV3 = (card: Record<string, unknown>) =>
  card.spec === "chara_card_v3" && Number.parseFloat(String(card.spec_version)) > 3;

export const isText = (value: unknown) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** A field as text: anything but a string or a number counts as absent. Half of an emoji, which
 *  Evermind cannot store, becomes the replacement character. */
export const text = (value: unknown) =>
  typeof value === "string" ? value.toWellFormed()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

/** A list of texts, blank ones left out: one text alone is a list of one. */
export const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).map(text).filter((item) => item.trim());

/** Keywords as the server keeps them: stripped as Python strips, blank ones left out. Not through
 *  texts(), whose trim would also drop a key the server keeps, such as a byte order mark alone. */
const keywords = (value: unknown) => (Array.isArray(value) ? value : [value]).map(text).map(pyStrip).filter(Boolean);

/** A whole number between the bounds, written as a number or as a string of digits; else null. */
function whole(value: unknown, low: number, high: number): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= low && number <= high ? number : null;
}

/** The rule for every depth, a note's or an entry's: one the server would refuse would cost the
 *  whole import, so it falls back, and the value as written stays in the card. */
const depthOf = (value: unknown) => (typeof value === "string" && value.startsWith("-") ? null : whole(value, 0, WHOLE)) ?? DEPTH;

/** A role by its name, or by SillyTavern's number for it. */
const roleOf = (value: unknown): NoteRole =>
  typeof value === "number" && ROLES[value] !== undefined && Number.isInteger(value) ? ROLES[value]
    : ROLES.find((role) => role === value) ?? "system";

/** The object whose fields make the character: `data` for V2 and V3, the card itself for V1, the
 *  Pygmalion shape under the names of a card; null for what is no card. */
export function cardFields(card: unknown): Record<string, unknown> | null {
  if (!isObject(card)) return null;
  const isCard = (fields: Record<string, unknown>) => Object.keys(FIELDS).some((key) => typeof fields[key] === "string");
  // With `spec`, `data` wins over the V1 fields SillyTavern copies at the root. Without it, as
  // SillyTavern chooses by `spec`, a flat V1 card may carry a `data` of its own that is no card.
  const fields = isObject(card.data) && (card.spec !== undefined || isCard(card.data)) ? card.data : card;
  if (isCard(fields)) return fields;
  if (fields === card && typeof card.char_name === "string") {
    return Object.fromEntries(Object.entries(PYGMALION).map(([flat, field]) => [field, card[flat]]));
  }
  return null;
}

/** The entries of the card's book as they stand there, anything included. */
export const bookEntries = (fields: Record<string, unknown>): unknown[] =>
  isObject(fields.character_book) && Array.isArray(fields.character_book.entries) ? fields.character_book.entries : [];

/** What an entry of `character_book.entries` says, at its index there. */
export function readEntry(entry: Record<string, unknown>, index: number): LoreEntryInput {
  // Only these keys of `extensions`, in the spelling SillyTavern writes them; the camel-cased copies
  // and the settings some sites put at the root of the entry are left in the card, as it leaves them.
  const extensions = isObject(entry.extensions) ? entry.extensions : {};
  return {
    keys: keywords(entry.keys),
    content: pyStrip(text(entry.content)),
    enabled: Boolean(entry.enabled ?? true),
    origin: index,
    comment: text(entry.comment) || text(entry.name),
    constant: entry.constant === true,
    selective: entry.selective === true,
    secondary_keys: keywords(entry.secondary_keys),
    selective_logic: (whole(typeof extensions.selectiveLogic === "number" ? extensions.selectiveLogic : null, 0, 3) ?? 0) as 0 | 1 | 2 | 3,
    insertion_order: whole(entry.insertion_order, -WHOLE, WHOLE) ?? 100,
    position: (typeof extensions.position === "number" || (typeof extensions.position === "string" && extensions.position.length === 1)
      ? whole(extensions.position, 0, 7) : null) ?? (entry.position === "before_char" ? 0 : 1),
    depth: depthOf(extensions.depth),
    role: roleOf(extensions.role),
    // SillyTavern's default is whole words: only a card that says false turns them off.
    whole_words: extensions.match_whole_words !== false,
    exclude_recursion: extensions.exclude_recursion === true,
    prevent_recursion: extensions.prevent_recursion === true,
  };
}

/** storable() of the server, with its strip: only for the report's counts; what Evermind received
 *  is said by the server, in the reading it keeps. */
export function isStorable(entry: Pick<LoreEntryInput, "keys" | "content" | "constant">): boolean {
  return pyStrip(entry.content) !== "" && (entry.keys.some((key) => pyStrip(key) !== "") || entry.constant);
}

/** Tags trimmed, blank ones and those already there in another case left out. */
function tagsOf(value: unknown) {
  const seen = new Set<string>();
  return texts(value).map((tag) => tag.trim()).filter((tag) => {
    const folded = tag.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}

/** The character a card's fields describe; `flat` for a V1 card, without `data`. */
function characterOf(fields: Record<string, unknown>, flat: boolean): CardCharacter {
  const extensions = isObject(fields.extensions) ? fields.extensions : {};
  const own = isObject(extensions.evermind) ? extensions.evermind : {};
  const note = isObject(extensions.depth_prompt) ? extensions.depth_prompt : null;
  const character = Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [field, text(fields[key])]),
  ) as Record<(typeof FIELDS)[keyof typeof FIELDS], string>;
  // A V1 card from SillyTavern keeps its notes as `creatorcomment`.
  if (flat && !isText(fields.creator_notes)) character.creator_notes = text(fields.creatorcomment);
  const multilingual = isObject(fields.creator_notes_multilingual) ? fields.creator_notes_multilingual : {};
  return {
    ...character,
    // The longest the server takes, counted as it counts; the report says when it is cut.
    name: [...character.name.trim()].slice(0, NAME_LENGTH).join("") || "Unnamed",
    kind: own.kind === "scenario" ? "scenario" : "character",
    tagline: text(own.tagline),
    // Bounded by the server as the name is; the card keeps it whole, and the report says it was cut.
    nickname: [...text(fields.nickname)].slice(0, NAME_LENGTH).join(""),
    character_note: note ? text(note.prompt) : "",
    character_note_depth: depthOf(note?.depth),
    character_note_role: roleOf(note?.role),
    creator_notes_multilingual: Object.fromEntries(Object.entries(multilingual)
      .filter((pair): pair is [string, string] => typeof pair[1] === "string")
      .map(([language, notes]) => [language.toWellFormed(), notes.toWellFormed()])),
    card_rules: 2,
    alternate_greetings: texts(fields.alternate_greetings),
    tags: tagsOf(fields.tags),
    // Every entry, unfiltered: what is kept is the server's to say.
    lore_entries: bookEntries(fields).flatMap((entry, index) => isObject(entry) ? [readEntry(entry, index)] : []),
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: "\u00a0" };

/** Every block from `<name` to its closing tag, or to the end when it is never closed. Found by
 *  searching rather than by a lazy pattern, which would go over the rest of the text once for
 *  every opening it fails to close. */
function withoutBlocks(html: string, name: string) {
  // Searched in the text as written: a lower-case copy can be longer ("İ" becomes two units), and
  // its places would cut the text elsewhere.
  const opening = new RegExp(`<${name}`, "gi");
  const closing = new RegExp(`</${name}`, "gi");
  let out = "";
  let at = 0;
  for (;;) {
    opening.lastIndex = at;
    const open = opening.exec(html)?.index ?? -1;
    if (open < 0) return out + html.slice(at);
    out += html.slice(at, open);
    closing.lastIndex = open;
    const close = closing.exec(html)?.index ?? -1;
    if (close < 0) return out;
    const end = html.indexOf(">", close);
    if (end < 0) return out;
    at = end + 1;
  }
}

// The ends of a block, kept while the tags go: a line, or a paragraph for <p>. Two code points
// Unicode keeps out of every text, taken out of a card's first, so that they are only ever ours.
const LINE = "\ufdd0";
const PARAGRAPH = "\ufdd1";
const MARKS = /[\ufdd0\ufdd1]/g;
const BLOCKS = new Set(["div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "blockquote", "pre", "center", "details", "summary", "hr"]);
// The markers of the names, which become names once shown: the engine's own pattern, whole.
const NAME_TAG = new RegExp(`^${NAME_TAG_RE.source}$`);

/** What a tag leaves in the plain text. */
function tagText(tag: string): string {
  if (NAME_TAG.test(tag)) return tag;
  const name = /^<\/?([A-Za-z][A-Za-z0-9]*)/.exec(tag)?.[1].toLowerCase();
  if (name === "p") return PARAGRAPH;
  if (name === "br") return "\n";
  if (name === "td" || name === "th") return " ";
  return name && BLOCKS.has(name) ? LINE : "";
}

/** A run of block ends and blanks between them, as one break: two blocks that meet are one line
 *  apart (the items of a list), or a paragraph when one of them is a paragraph or the text itself
 *  left an empty line there. */
function blockBreak(run: string): string {
  if (!run.includes(LINE) && !run.includes(PARAGRAPH)) return run;
  const lines = run.split("\n").length - 1;
  return run.includes(PARAGRAPH) || lines >= 2 ? "\n\n" : "\n";
}

/** A line without the heading and quote marks it opens with, and the blanks among them: cut after
 *  the last "#" or ">" of its leading run of blanks and marks. Scanned by hand: a pattern repeated
 *  over that run nests one quantifier in another, and megabytes of ">" overflow the stack of the
 *  expression engine. */
function withoutLineMarks(line: string): string {
  let cut = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "#" || char === ">") cut = i + 1;
    else if (!/\s/.test(char)) break;
  }
  return cut === 0 ? line : line.slice(cut);
}

/** The presentation without its layout, its paragraphs kept: for a summary, the page's fallback,
 *  and the tagline offered at import. The markers of the names stay, to become names when shown.
 *  Every pattern stops at the next mark it could start on, so that a note full of unclosed marks
 *  still takes one pass. */
export function plainPresentation(text: string): string {
  return withoutBlocks(withoutBlocks(text.replace(MARKS, ""), "style"), "script")
    .replace(/<[^<>]*>/g, tagText)
    .replace(/[\s\ufdd0\ufdd1]+/g, blockBreak)
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    // Every mark at the start of a line, so that a quote within a quote loses both.
    .replace(/[^\n]+/g, withoutLineMarks)
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name])
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A line of = or of - alone, indented three blanks at most: under a paragraph, it makes that
// paragraph a heading (Markdown's setext heading, read as micromark reads it).
const UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*\r?$/;

/** Where the underline of the paragraph `at` stands in ends, or -1 when the paragraph has none;
 *  and where the look stopped (a blank line, or the end), so that no line is read twice. */
function underlinedEnd(text: string, at: number): { end: number; scanned: number } {
  let lineEnd = text.indexOf("\n", at);
  while (lineEnd >= 0) {
    const start = lineEnd + 1;
    const next = text.indexOf("\n", start);
    const line = text.slice(start, next < 0 ? text.length : next);
    if (line.trim() === "") return { end: -1, scanned: start };
    if (UNDERLINE.test(line)) return { end: next < 0 ? text.length : next + 1, scanned: start };
    lineEnd = next;
  }
  return { end: -1, scanned: text.length };
}

/** The text after the headings it opens with, Markdown's or HTML's: a heading is a title, not the
 *  first sentence. Searched rather than matched, so that an unclosed one takes a single pass. */
function withoutLeadingHeadings(text: string): string {
  // Searched in the text as written, never in a lower-case copy: lowering is not length-preserving
  // ("İ" becomes two units), and a place found in the copy would cut the text elsewhere.
  const htmlHeading = /<h([1-6])(?=[\s>/])/iy;
  const closings = [1, 2, 3, 4, 5, 6].map((level) => new RegExp(`</h${level}`, "gi"));
  let at = 0;
  // The lines before this place have been looked at for an underline and hold none.
  let scanned = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    let marks = 0;
    while (text[at + marks] === "#") marks++;
    if (marks >= 1 && marks <= 6 && /^[ \t\r\n]?$/.test(text[at + marks] ?? "")) {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end + 1;
      continue;
    }
    if (at >= scanned) {
      const underlined = underlinedEnd(text, at);
      if (underlined.end >= 0) {
        at = underlined.end;
        continue;
      }
      scanned = underlined.scanned;
    }
    // A banner or a wrapper before the title shows no text of its own: the title is still first.
    const empty = shownNothing(text, at);
    if (empty > at) {
      at = empty;
      continue;
    }
    htmlHeading.lastIndex = at;
    const open = htmlHeading.exec(text);
    if (!open) return text.slice(at);
    const closing = closings[Number(open[1]) - 1];
    closing.lastIndex = at;
    const close = closing.exec(text);
    const end = close ? text.indexOf(">", close.index) : -1;
    if (end < 0) return text.slice(at);
    at = end + 1;
  }
}

const MARKDOWN_IMAGE = /!\[[^[\]]*\]\([^()]*\)/y;
// A banner people can click, the shape card sites most often put first.
const LINKED_IMAGE = /\[!\[[^[\]]*\]\([^()]*\)\]\([^()]*\)/y;
// Any tag but a heading's opening, which is a title to leave out with its text.
const NO_HEADING_TAG = /<\/[A-Za-z][^<>]*>|<(?!h[1-6][\s>/])[A-Za-z][^<>]*>/iy;

/** Where a piece that shows no text, starting at `at`, ends: a Markdown image, linked or not, an
 *  HTML comment, or a tag other than a heading's opening; `at` itself when there is none. A marker
 *  of a name shows a name, and stays. */
function shownNothing(text: string, at: number): number {
  // A comment left open is not skipped: what follows it is all there is to read.
  if (text.startsWith("<!--", at)) {
    const close = text.indexOf("-->", at + 4);
    return close < 0 ? at : close + 3;
  }
  for (const piece of [MARKDOWN_IMAGE, LINKED_IMAGE, NO_HEADING_TAG]) {
    piece.lastIndex = at;
    const found = piece.exec(text);
    if (found && !NAME_TAG.test(found[0])) return piece.lastIndex;
  }
  return at;
}

/** The first sentence of the creator's notes, as plain text: what a card says of itself first.
 *  Nothing is cut at a length. The headings it opens with are left out, unless they are all it
 *  says. */
export function taglineOf(notes: string): string {
  const visible = withoutBlocks(withoutBlocks(notes, "style"), "script");
  let plain = plainPresentation(withoutLeadingHeadings(visible)) || plainPresentation(visible);
  plain = plain.replace(/\s+/g, " ").trim();
  // A full-width mark ends the sentence whatever follows: Japanese and Chinese put no space after it.
  // The marks after it and the quotes it closes go with it, in whatever order they close, or the
  // tagline would end inside a quotation.
  const end = /[.!?…](?=\s|$)|[。！？]+/.exec(plain);
  if (!end) return plain;
  let stop = end.index + end[0].length;
  for (;;) {
    const next = plain[stop];
    if (next === '"' || next === "'") {
      // A straight quote opens as it closes: it goes with the sentence only when one of its kind is
      // open before it, or the quote that opens the next sentence would end this one. An apostrophe
      // within a Latin word (Tom's, Chloé's, L'été) opens nothing, so it is left out of the count,
      // the accent of its letter written in it or after it as a mark of its own (e and U+0301).
      // The Latin script, not any letter: the quote that closes 'やあ'と sits between two kana.
      // A plural possessive (the girls') still counts as a quote: nothing in the text tells it apart.
      const before = plain.slice(0, stop).replace(/(\p{Script=Latin}\p{M}*)'(?=\p{Script=Latin})/gu, "$1");
      if (before.split(next).length % 2 !== 0) break;
    } else if (next === undefined || !"」』）】》〉”’)]".includes(next)) {
      break;
    }
    stop++;
  }
  return plain.slice(0, stop);
}

/** A parsed card and the text it was parsed from; null for what is no card. */
export function readCardJson(card: unknown, text: string, format: CardText["format"]): ReadCard | null {
  const fields = cardFields(card);
  if (!fields || !isObject(card)) return null;
  const character = characterOf(fields, fields === card);
  const original: CardText = { text, format, other_text: null };
  return {
    character,
    original,
    report: reportOf(card, character, original),
    suggestedTagline: taglineOf(character.creator_notes),
  };
}

/** The character a card describes, V1 (flat), V2 or V3 (in `data`); null for what is no card. */
export function cardToCharacter(card: unknown): CardCharacter | null {
  return readCardJson(card, JSON.stringify(card) ?? "", "json")?.character ?? null;
}
