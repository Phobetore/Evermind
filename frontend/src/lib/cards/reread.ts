import { data, DataError, type CardCharacter, type CharacterInput, type LoreEntryInput, type OriginalCard } from "@/data";
import { stripDecorators } from "@/engine";
import { pyStrip } from "@/engine/text";
import type { Character } from "@/types";
import { NEW_LORE_ENTRY } from "../loreEntry";
import { readCardBytes } from "./index";
import { chunks } from "./png";
import { bookEntries, cardFields, FIELDS, isObject, isStorable, readCardJson, type ReadCard } from "./read";
import type { ReportLine } from "./report";

// Re-reading a card made before Evermind kept cards whole. Such a card holds what the reader of the
// time made of its card, so whatever differs from that reading was changed by its owner: it is
// compared with that old reading, never with the new one, and a change is never written over.

export type RereadMode = "reread" | "keep";

/** The card found again: what the reader reads in it now, and what the import of the time made of it. */
export interface FoundCard {
  read: ReadCard;
  old: CardCharacter;
  /** How many items the book the old reading came from held, when it is another chunk of the PNG
   *  than the one read now; absent when both readings come from the same card. */
  oldBook?: number;
}

export interface RereadPlan {
  /** What changes in the form. */
  fields: Partial<CharacterInput>;
  /** The lorebook after the re-reading, in today's order, each addition after the entry of the
   *  card's nearest index below its own. */
  lore: LoreEntryInput[];
  /** What will be added or brought up to date, for the banner. */
  added: ReportLine[];
  /** The fields changed by their owner left as they are, by their name. */
  untouched: string[];
  /** The card to keep, with its reading; null when only the rules change. */
  card: OriginalCard | null;
}

// The reader of before cards were kept whole, copied as it was, for one reason: a card made then
// holds what this reader made of its card, and only this reader says what of it was changed since.
// Its entries carry their index in the card's book, as a card read now does; nothing else differs.

const OLD_FIELDS = {
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

/** A field as text: anything but a string or a number counts as absent. Half of an emoji, which
 *  Evermind cannot store, becomes the replacement character. */
const text = (value: unknown) =>
  typeof value === "string" ? value.toWellFormed()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

/** A list of texts, blank ones left out: one text alone is a list of one. */
const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).map(text).filter((item) => item.trim());

/** The object the old reader took a character from; null for what it took for no card. */
function oldFields(card: unknown): Record<string, unknown> | null {
  const fields = isObject(card) && isObject(card.data) ? card.data : card;
  if (!isObject(fields) || !Object.keys(OLD_FIELDS).some((key) => typeof fields[key] === "string")) {
    return null;
  }
  return fields;
}

const oldBook = (fields: Record<string, unknown>): unknown[] =>
  isObject(fields.character_book) && Array.isArray(fields.character_book.entries)
    ? fields.character_book.entries : [];

/** The reader of before this plan, copied as it was: chara before ccv3, entries with a keyword and text. */
export function oldReading(card: unknown): CardCharacter | null {
  const fields = oldFields(card);
  if (!fields) return null;
  const own = isObject(fields.extensions) && isObject(fields.extensions.evermind)
    ? fields.extensions.evermind : {};
  const character = Object.fromEntries(
    Object.entries(OLD_FIELDS).map(([key, field]) => [field, text(fields[key])]),
  ) as Record<(typeof OLD_FIELDS)[keyof typeof OLD_FIELDS], string>;
  return {
    ...character,
    // The longest the server takes, counted as it counts.
    name: [...character.name.trim()].slice(0, 200).join("") || "Unnamed",
    kind: own.kind === "scenario" ? "scenario" : "character",
    tagline: text(own.tagline),
    alternate_greetings: texts(fields.alternate_greetings),
    tags: texts(fields.tags),
    // What it never read, as a card made then holds it since the update.
    nickname: "",
    character_note: "",
    character_note_depth: 4,
    character_note_role: "system",
    creator_notes_multilingual: {},
    card_rules: 1,
    lore_entries: oldBook(fields).flatMap((entry, index) => isObject(entry) ? [{
      ...NEW_LORE_ENTRY,
      secondary_keys: [],
      keys: texts(entry.keys).map((key) => key.trim()),
      content: text(entry.content).trim(),
      enabled: Boolean(entry.enabled ?? true),
      origin: index,
    }] : []).filter((entry) => entry.keys.length > 0 && entry.content),
  };
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** The card the old import found in a PNG, as base64 JSON in a tEXt chunk: `chara`, else `ccv3`. */
function oldPngCard(png: Uint8Array): unknown {
  const found = new Map<string, string>();
  for (const { type, data: chunk } of chunks(png)) {
    const end = chunk.indexOf(0);
    if (type !== "tEXt" || end < 0) continue;
    const keyword = new TextDecoder().decode(chunk.subarray(0, end));
    if (!found.has(keyword)) found.set(keyword, new TextDecoder().decode(chunk.subarray(end + 1)));
  }
  for (const keyword of ["chara", "ccv3"]) {
    const base64 = found.get(keyword);
    if (base64 === undefined) continue;
    let json = "";
    try {
      json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    } catch {
      continue;
    }
    const card = parsed(json);
    if (oldReading(card)) return card;
  }
  return null;
}

type Looked = Pick<Character, "id" | "name" | "description" | "greeting" | "avatar_url" | "has_card">;

/** Whether a card is the one this character was made from: its name, or, for a character renamed
 *  since, both its description and its first message. A portrait replaced by another card's PNG is not. */
const isTheirs = (old: CardCharacter, character: Looked) =>
  old.name === character.name
  || (Boolean(old.description) && Boolean(old.greeting)
    && old.description === character.description && old.greeting === character.greeting);

/** Whether a card of the library is this character's: a card made here can bear the same name. */
const isFromLibrary = (old: CardCharacter, character: Looked) =>
  old.name === character.name
  && ((Boolean(old.description) && old.description === character.description)
    || (Boolean(old.greeting) && old.greeting === character.greeting));

/** Where a card made before the update can be read again, if it is this character's. */
export async function findOriginal(character: Looked): Promise<FoundCard | null> {
  if (character.has_card) {
    const stored = await data.characters.card(character.id);
    const read = stored ? readCardJson(parsed(stored.text), stored.text, stored.format) : null;
    if (stored && read) {
      return { read: { ...read, original: { ...read.original, other_text: stored.other_text } }, old: stored.read };
    }
  }
  if (character.avatar_url?.endsWith(".png")) {
    const bytes = new Uint8Array(await (await data.file(character.avatar_url)).arrayBuffer());
    const card = oldPngCard(bytes);
    const old = oldReading(card);
    if (old && isTheirs(old, character)) {
      try {
        const { read } = await readCardBytes(bytes, "portrait.png");
        return { read, old, oldBook: oldBook(oldFields(card)!).length };
      } catch (error) {
        // A portrait the reader of today finds no card in: the library may still have it.
        if (!(error instanceof DataError)) throw error;
      }
    }
  }
  for (const item of await data.library.list()) {
    const old = oldReading(item.card);
    if (!old || !isFromLibrary(old, character)) continue;
    const read = readCardJson(item.card, JSON.stringify(item.card), "json");
    if (read) return { read, old };
  }
  return null;
}

/** The fields the old reader read, which a re-reading never writes over once changed. */
const READ_FIELDS = ["kind", "tagline", ...Object.values(FIELDS), "alternate_greetings", "tags"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keys compared as a set: their order, or one written twice, changes nothing to what they match. */
function sameKeys(a: string[], b: string[]) {
  const one = new Set(a);
  const other = new Set(b);
  return one.size === other.size && [...one].every((key) => other.has(key));
}

/** An entry's text as both chunks of a PNG should agree on it: a V2 copy leaves the decorators out. */
const bare = (content: string) => pyStrip(stripDecorators(content));

/** How many items the book read now holds. */
function bookLength(read: ReadCard) {
  const fields = cardFields(parsed(read.original.text));
  return fields ? bookEntries(fields).length : 0;
}

/** Where each entry of the old reading sits in the card read now, by its index in its own book. */
function placesNow(found: FoundCard): Map<number, number> {
  const now = found.read.character.lore_entries;
  const read = new Set(now.flatMap((entry) => (entry.origin === null ? [] : [entry.origin])));
  // The same card, or two chunks whose books are as long: the same index.
  const sameBook = found.oldBook === undefined || found.oldBook === bookLength(found.read);
  const places = new Map<number, number>();
  const taken = new Set<number>();
  for (const entry of found.old.lore_entries) {
    if (entry.origin === null) continue;
    if (sameBook) {
      if (read.has(entry.origin)) places.set(entry.origin, entry.origin);
      continue;
    }
    const match = now.find((candidate) => candidate.origin !== null && !taken.has(candidate.origin)
      && sameKeys(candidate.keys, entry.keys) && bare(candidate.content) === bare(entry.content));
    if (match) {
      taken.add(match.origin!);
      places.set(entry.origin, match.origin!);
    }
  }
  return places;
}

/** The entry of the old reading each entry of the character is, if any, on what the two still
 *  share, never on rank alone: an entry deleted beside one written here must not hand the new one
 *  its settings. First an entry that already names its origin (one kept with its card before);
 *  then the same keys (as a set) and the same text; then the same keys or the same text, the
 *  first not taken in order, so that an entry changed in one of the two stays itself. An entry of
 *  the old reading left without one was deleted by its owner; an entry of the character left
 *  without one was made here, or rewritten whole. */
function pairs(current: LoreEntryInput[], old: LoreEntryInput[]): (LoreEntryInput | null)[] {
  const taken = new Set<number>();
  const paired: (LoreEntryInput | null)[] = current.map(() => null);
  const pass = (fits: (entry: LoreEntryInput, candidate: LoreEntryInput) => boolean) => {
    current.forEach((entry, i) => {
      if (paired[i]) return;
      const at = old.findIndex((candidate, j) => !taken.has(j) && fits(entry, candidate));
      if (at < 0) return;
      taken.add(at);
      paired[i] = old[at];
    });
  };
  const sameText = (a: LoreEntryInput, b: LoreEntryInput) => a.content.trim() === b.content.trim();
  pass((entry, candidate) => entry.origin !== null && entry.origin === candidate.origin);
  pass((entry, candidate) => sameKeys(candidate.keys, entry.keys) && sameText(candidate, entry));
  pass((entry, candidate) => sameKeys(candidate.keys, entry.keys) || sameText(candidate, entry));
  return paired;
}

/** The entries of `lore`, with each of `more` after the entry from the nearest index of the card
 *  below its own (at the head when there is none), in the order of the card. */
function withAdded(lore: LoreEntryInput[], more: LoreEntryInput[]): LoreEntryInput[] {
  const placeOf = new Map<number, number>();
  lore.forEach((entry, i) => { if (entry.origin !== null) placeOf.set(entry.origin, i); });
  const after = new Map<number, LoreEntryInput[]>();
  for (const entry of [...more].sort((a, b) => a.origin! - b.origin!)) {
    let anchor = -1;
    for (const [origin, at] of placeOf) {
      if (origin < entry.origin! && (anchor < 0 || origin > lore[anchor].origin!)) anchor = at;
    }
    if (!after.has(anchor)) after.set(anchor, []);
    after.get(anchor)!.push(entry);
  }
  const out = [...(after.get(-1) ?? [])];
  lore.forEach((entry, i) => out.push(entry, ...(after.get(i) ?? [])));
  return out;
}

/** What re-reading changes, against the form as it is now: it adds, it never overwrites a retouch. */
export function rereadPlan(current: CardCharacter, found: FoundCard | null, mode: RereadMode): RereadPlan {
  const reread = mode === "reread";
  if (!found) {
    return { fields: reread ? { card_rules: 2 } : {}, lore: current.lore_entries, added: [], untouched: [], card: null };
  }
  const { read, old } = found;
  const now = read.character;
  const fields: Partial<CharacterInput> = {};
  const added: ReportLine[] = [];
  const untouched: string[] = [];

  // A field as it was read then was never touched: it takes the reading of now. One that differs
  // was changed, or emptied, by its owner, and stays; none is filled for being empty.
  const taken: string[] = [];
  for (const field of READ_FIELDS) {
    if (same(current[field], now[field])) continue;
    if (!same(current[field], old[field])) {
      untouched.push(field);
    } else if (reread) {
      Object.assign(fields, { [field]: now[field] });
      taken.push(field);
    }
  }
  if (taken.length > 0) added.push({ key: "fields", names: taken });

  // What the old reader never read: taken from the card where the character holds nothing else.
  if (!current.nickname && now.nickname) {
    fields.nickname = now.nickname;
    added.push({ key: "nickname" });
  }
  if (!current.character_note && now.character_note) {
    fields.character_note = now.character_note;
    added.push({ key: "characterNote", count: now.character_note_depth });
  }
  if (current.character_note_depth === 4 && now.character_note_depth !== 4) fields.character_note_depth = now.character_note_depth;
  if (current.character_note_role === "system" && now.character_note_role !== "system") fields.character_note_role = now.character_note_role;
  if (Object.keys(current.creator_notes_multilingual).length === 0 && Object.keys(now.creator_notes_multilingual).length > 0) {
    fields.creator_notes_multilingual = now.creator_notes_multilingual;
    added.push({ key: "multilingualNotes", names: Object.keys(now.creator_notes_multilingual) });
  }

  const places = placesNow(found);
  const byOrigin = new Map(now.lore_entries.flatMap((entry) => (entry.origin === null ? [] : [[entry.origin, entry] as const])));
  const paired = pairs(current.lore_entries, old.lore_entries);
  const lore = current.lore_entries.map((entry, i): LoreEntryInput => {
    const before = paired[i];
    const at = before?.origin == null ? undefined : places.get(before.origin);
    // Made here, or no longer in the card: as it is.
    if (!before || at === undefined) return { ...entry, origin: null };
    const card = byOrigin.get(at)!;
    // Its settings are the card's; what the old rules read takes the reading of now only where
    // it was not changed, and never when the card is only kept.
    return {
      ...entry,
      ...card,
      keys: !reread || !same(entry.keys, before.keys) ? entry.keys : card.keys,
      content: !reread || entry.content !== before.content ? entry.content : card.content,
      enabled: !reread || entry.enabled !== before.enabled ? entry.enabled : card.enabled,
      origin: at,
    };
  });

  if (reread) {
    // The entries the old import never gave Evermind: always on with no keyword, or only in ccv3.
    // Each goes after the entry of the nearest index below it, as the export places what Evermind
    // never received, so that a card re-read and left alone keeps its author's order.
    const designated = new Set(places.values());
    const more = now.lore_entries.filter((entry) => entry.origin !== null && !designated.has(entry.origin) && isStorable(entry));
    if (more.length > 0) added.push({ key: "lore", count: more.length });
    fields.card_rules = 2;
    return { fields, lore: withAdded(lore, more), added, untouched, card: { ...read.original, read: now } };
  }

  // Kept for the export only: the reading kept with the card is the old one wherever the old
  // rules read, so that the export writes over the card only what was really changed. An entry
  // the old reading does not point at is left out of it, and so stays in the card as it is.
  const oldAt = new Map(old.lore_entries.flatMap((entry) => (entry.origin === null ? [] : [[entry.origin, entry] as const])));
  const keptLore = [...places].sort((a, b) => a[1] - b[1]).map(([origin, at]): LoreEntryInput => {
    const before = oldAt.get(origin)!;
    return { ...byOrigin.get(at)!, keys: before.keys, content: before.content, enabled: before.enabled, origin: at };
  });
  const oldFieldsRead = Object.fromEntries(READ_FIELDS.map((field) => [field, old[field]]));
  return {
    fields,
    lore,
    added,
    untouched,
    card: { ...read.original, read: { ...now, ...oldFieldsRead, lore_entries: keptLore } },
  };
}
