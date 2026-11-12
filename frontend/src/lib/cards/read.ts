import type { CardCharacter, CardText, LoreEntryInput } from "@/data";
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
/** The longest name the server takes, counted as it counts, in code points. */
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
  // With `spec`, `data` wins over the V1 fields SillyTavern copies at the root.
  const fields = isObject(card.data) ? card.data : card;
  if (Object.keys(FIELDS).some((key) => typeof fields[key] === "string")) return fields;
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
    nickname: text(fields.nickname),
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
  const lower = html.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    const open = lower.indexOf(`<${name}`, at);
    if (open < 0) return out + html.slice(at);
    out += html.slice(at, open);
    const close = lower.indexOf(`</${name}`, open);
    if (close < 0) return out;
    const end = lower.indexOf(">", close);
    if (end < 0) return out;
    at = end + 1;
  }
}

/** The first sentence of the creator's notes, as plain text: what a card says of itself first.
 *  Nothing is cut at a length. Every pattern stops at the next mark it could start on, so that a
 *  note full of unclosed marks still takes one pass. */
export function taglineOf(notes: string): string {
  let plain = withoutBlocks(withoutBlocks(notes, "style"), "script")
    .replace(/<[^<>]*>/g, "")
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    // Every mark at the start of a line, so that a quote within a quote loses both.
    .replace(/^(?:[^\S\n]*(?:#+|>))+/gm, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]);
  plain = plain.replace(/\s+/g, " ").trim();
  // A full-width mark ends the sentence whatever follows: Japanese and Chinese put no space after it.
  const end = /[.!?…](?=\s|$)|[。！？]/.exec(plain);
  return end ? plain.slice(0, end.index + 1) : plain;
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
