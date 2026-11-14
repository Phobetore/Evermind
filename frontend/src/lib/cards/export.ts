import type { CardCharacter, LoreEntryInput, StoredCard } from "@/data";
import type { NoteRole } from "@/types";
import { bookEntries, cardFields, FIELDS, isNewerV3, isObject, isText } from "./read";

// The card a character is exported as. A card that was read is written back as it came in, with
// what was changed here written over it: a column is written only where it differs from the
// reading kept with the card, so that a change to the rules of reading never passes for an edit,
// and everything Evermind does not read, or does not keep, stays where its author put it.

type Card<Spec extends string, Version extends string> =
  { spec: Spec; spec_version: Version; data: Record<string, unknown> } & Record<string, unknown>;

export interface ExportedCard {
  /** For the chara chunk, and for a JSON file whose card was V2, or made here. */
  v2: Card<"chara_card_v2", "2.0">;
  /** For the ccv3 chunk, and for a JSON file whose card was V3: 3.0, or the newer version it said. */
  v3: Card<"chara_card_v3", string>;
  json: "v2" | "v3";
}

type Fields = Record<string, unknown>;

/** SillyTavern's numbers for the roles. */
const ROLES: readonly NoteRole[] = ["system", "user", "assistant"];

/** The copies of the card's fields a V1 reader finds at the root, by their name there → in `data`. */
const V1_COPIES = {
  name: "name",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  first_mes: "first_mes",
  mes_example: "mes_example",
  creatorcomment: "creator_notes",
  tags: "tags",
} as const;

/** The fields of the flat shape of Pygmalion, which a V2 card has no place for. */
const PYGMALION_FIELDS = ["char_name", "char_persona", "char_greeting", "world_scenario", "example_dialogue"];

/** The fields of a card Evermind reads at the root of a flat V1 card. */
const FLAT_FIELDS = [...Object.keys(FIELDS), "nickname", "creator_notes_multilingual"];

/** Whether two values hold the same, compared as JSON holds them. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const objectIn = (parent: Fields, key: string): Fields => {
  if (!isObject(parent[key])) parent[key] = {};
  return parent[key] as Fields;
};

/** The standard place of an entry, which a reader that knows only the specification goes by. */
const placeOf = (position: number) => (position === 0 ? "before_char" : "after_char");

/** Each setting of an entry: the value as Evermind holds it, and where it goes in the card's entry. */
const ENTRY_SETTINGS: [keyof LoreEntryInput, (entry: Fields, value: LoreEntryInput) => void][] = [
  ["keys", (entry, { keys }) => { entry.keys = keys; }],
  ["content", (entry, { content }) => { entry.content = content; }],
  ["enabled", (entry, { enabled }) => { entry.enabled = enabled; }],
  ["comment", (entry, { comment }) => { entry.comment = comment; }],
  ["constant", (entry, { constant }) => { entry.constant = constant; }],
  ["selective", (entry, { selective }) => { entry.selective = selective; }],
  ["secondary_keys", (entry, { secondary_keys }) => { entry.secondary_keys = secondary_keys; }],
  ["insertion_order", (entry, { insertion_order }) => { entry.insertion_order = insertion_order; }],
  ["selective_logic", (entry, { selective_logic }) => { objectIn(entry, "extensions").selectiveLogic = selective_logic; }],
  ["position", (entry, { position }) => {
    objectIn(entry, "extensions").position = position;
    entry.position = placeOf(position);
  }],
  ["depth", (entry, { depth }) => { objectIn(entry, "extensions").depth = depth; }],
  ["role", (entry, { role }) => { objectIn(entry, "extensions").role = ROLES.indexOf(role); }],
  ["whole_words", (entry, { whole_words }) => { objectIn(entry, "extensions").match_whole_words = whole_words; }],
  ["exclude_recursion", (entry, { exclude_recursion }) => { objectIn(entry, "extensions").exclude_recursion = exclude_recursion; }],
  ["prevent_recursion", (entry, { prevent_recursion }) => { objectIn(entry, "extensions").prevent_recursion = prevent_recursion; }],
];

/** An entry made here, or one whose origin the reading does not know: every setting written. */
function wholeEntry(entry: LoreEntryInput): Fields {
  const out: Fields = {};
  for (const [, write] of ENTRY_SETTINGS) write(out, entry);
  const { extensions, ...rest } = out;
  // Keys never match as a regular expression in Evermind, which V3 says with its flag; settings
  // last, as SillyTavern writes an entry.
  return { ...rest, position: placeOf(entry.position), use_regex: false, extensions };
}

/** The settings of `entry` that differ from what was read of the same entry, written on a copy of
 *  the card's entry. Whether anything was written comes back with it. */
function editedEntry(original: Fields, entry: LoreEntryInput, read: LoreEntryInput): [Fields, boolean] {
  const out = structuredClone(original);
  let written = false;
  for (const [name, write] of ENTRY_SETTINGS) {
    if (same(entry[name], read[name])) continue;
    write(out, entry);
    written = true;
  }
  return [out, written];
}

/** The book's entries: Evermind's, in its order, each on the entry it comes from; then every item
 *  of the card Evermind never received, at its place, after the entry exported from the nearest
 *  index below it. An entry the server received and nobody here points at any more was deleted. */
function bookOf(originals: unknown[], lore: LoreEntryInput[], read: LoreEntryInput[]): [unknown[], boolean] {
  const received = new Map<number, LoreEntryInput>();
  for (const entry of read) if (entry.origin !== null) received.set(entry.origin, entry);
  const pointed = new Set(lore.flatMap((entry) => (entry.origin === null ? [] : [entry.origin])));

  let changed = false;
  const exported = lore.map((entry) => {
    const original = entry.origin === null ? undefined : originals[entry.origin];
    const before = entry.origin === null ? undefined : received.get(entry.origin);
    if (!before || !isObject(original)) {
      changed = true;
      return wholeEntry(entry);
    }
    const [out, written] = editedEntry(original, entry, before);
    changed ||= written;
    return out;
  });
  // The order is Evermind's: moving an entry is a change too.
  const origins = lore.map((entry) => entry.origin);
  if (origins.some((origin, i) => i > 0 && (origin ?? -1) <= (origins[i - 1] ?? -1))) changed = true;

  // Where each exported entry from a given index ends up: the last one, if several come from it.
  const placeOfOrigin = new Map<number, number>();
  lore.forEach((entry, i) => { if (entry.origin !== null) placeOfOrigin.set(entry.origin, i); });
  // What goes after each exported entry, by its place; -1 is the head of the book.
  const after = new Map<number, unknown[]>();
  let anchor = -1;
  originals.forEach((item, index) => {
    if (!pointed.has(index)) {
      if (received.has(index)) {
        changed = true;
      } else {
        if (!after.has(anchor)) after.set(anchor, []);
        after.get(anchor)!.push(item);
      }
    }
    // Only the index itself and those below count for the items that follow it.
    const at = placeOfOrigin.get(index);
    if (at !== undefined) anchor = at;
  });
  const entries = [...(after.get(-1) ?? [])];
  exported.forEach((entry, i) => entries.push(entry, ...(after.get(i) ?? [])));
  return [entries, changed];
}

/** The columns written where they differ from the reading, on a copy of the card's fields. */
function writeColumns(fields: Fields, character: CardCharacter, read: CardCharacter): { written: Set<string>; changed: boolean } {
  const written = new Set<string>();
  const write = (key: string, value: unknown) => {
    fields[key] = value;
    written.add(key);
  };
  for (const [key, column] of Object.entries(FIELDS)) {
    if (!same(character[column], read[column])) write(key, character[column]);
  }
  for (const column of ["alternate_greetings", "tags", "nickname", "creator_notes_multilingual"] as const) {
    if (!same(character[column], read[column])) write(column, character[column]);
  }

  const own: Fields = {};
  if (!same(character.kind, read.kind)) own.kind = character.kind;
  if (!same(character.tagline, read.tagline)) own.tagline = character.tagline;
  if (Object.keys(own).length > 0) {
    Object.assign(objectIn(objectIn(fields, "extensions"), "evermind"), own);
    written.add("extensions");
  }

  const note: Fields = {};
  if (!same(character.character_note, read.character_note)) note.prompt = character.character_note;
  if (!same(character.character_note_depth, read.character_note_depth)) note.depth = character.character_note_depth;
  if (!same(character.character_note_role, read.character_note_role)) note.role = character.character_note_role;
  if (Object.keys(note).length > 0) {
    const extensions = objectIn(fields, "extensions");
    // A note that had no place gets all three: a reader would otherwise fall back on its own depth.
    const whole = !isObject(extensions.depth_prompt);
    Object.assign(objectIn(extensions, "depth_prompt"), whole
      ? { prompt: character.character_note, depth: character.character_note_depth, role: character.character_note_role }
      : note);
    written.add("extensions");
  }

  const book = isObject(fields.character_book) ? fields.character_book : null;
  // Entries kept in an object rather than a list were never read, so never received: they go first,
  // as items Evermind never received, rather than be lost under an entry added here.
  const originals = book && isObject(book.entries) ? Object.values(book.entries) : book ? bookEntries(fields) : [];
  const [entries, changed] = bookOf(originals, character.lore_entries, read.lore_entries);
  if (book) {
    // A book without a list of entries keeps its shape until there is one of Evermind's to write.
    if (Array.isArray(book.entries) || character.lore_entries.length > 0) book.entries = entries;
  } else if (entries.length > 0) {
    fields.character_book = { entries };
  }
  return { written, changed: changed || written.size > 0 };
}

/** The V1 copies at the root rewritten from `data` where their field in it was written, and only
 *  those the card had. */
function followCopies(root: Fields, data: Fields, written: Set<string>) {
  for (const [copy, field] of Object.entries(V1_COPIES)) {
    if (written.has(field) && copy in root) root[copy] = data[field];
  }
}

/** The data of a V3 card, from that of a V2 one: what the V3 specification requires and V2 lacks. */
function asV3(data: Fields, changed: boolean, now: Date): Fields {
  const out = structuredClone(data);
  if (!Array.isArray(out.group_only_greetings)) out.group_only_greetings = [];
  if (isObject(out.character_book)) {
    if (!isObject(out.character_book.extensions)) out.character_book.extensions = {};
    if (Array.isArray(out.character_book.entries)) {
      for (const entry of out.character_book.entries) {
        if (isObject(entry) && typeof entry.use_regex !== "boolean") entry.use_regex = false;
      }
    }
  }
  if (changed) out.modification_date = Math.floor(now.getTime() / 1000);
  return out;
}

/** The data of a V2 card: the book's own extensions, which V2 requires, where they are missing. */
function asV2(data: Fields): Fields {
  const out = structuredClone(data);
  if (isObject(out.character_book) && !isObject(out.character_book.extensions)) out.character_book.extensions = {};
  return out;
}

/** Both cards, around the same data and the same root. A V3 of a newer version keeps it: Evermind
 *  writes only what 3.0 has, and leaves the rest of the card as its author wrote it. */
function cardsOf(root: Fields, data: Fields, changed: boolean, now: Date, json: "v2" | "v3", version = "3.0"): ExportedCard {
  return {
    v2: { ...root, spec: "chara_card_v2", spec_version: "2.0", data: asV2(data) },
    v3: { ...root, spec: "chara_card_v3", spec_version: version, data: asV3(data, changed, now) },
    json,
  };
}

/** A card made here, from its columns: Evermind's fields, the settings in SillyTavern's places,
 *  and the V1 copies at the root, as SillyTavern writes them. */
function madeHere(character: CardCharacter, now: Date): ExportedCard {
  const data: Fields = Object.fromEntries(Object.entries(FIELDS).map(([key, column]) => [key, character[column]]));
  data.alternate_greetings = character.alternate_greetings;
  data.tags = character.tags;
  if (character.nickname) data.nickname = character.nickname;
  if (Object.keys(character.creator_notes_multilingual).length > 0) {
    data.creator_notes_multilingual = character.creator_notes_multilingual;
  }
  const extensions: Fields = { evermind: { kind: character.kind, tagline: character.tagline } };
  if (character.character_note) {
    extensions.depth_prompt = {
      prompt: character.character_note, depth: character.character_note_depth, role: character.character_note_role,
    };
  }
  data.extensions = extensions;
  if (character.lore_entries.length > 0) data.character_book = { entries: character.lore_entries.map(wholeEntry) };
  const root: Fields = Object.fromEntries(Object.entries(V1_COPIES).map(([copy, field]) => [copy, data[field]]));
  return cardsOf(root, data, true, now, "v2");
}

/** A flat card's `data` of its own, which is no card, would be written over by the card's: it
 *  moves to the first free name beside it instead. */
function keepOwnData(root: Fields) {
  if (!("data" in root)) return;
  let name = "data_v1";
  for (let n = 2; name in root; n++) name = `data_v1_${n}`;
  root[name] = root.data;
  delete root.data;
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The kept card, with what Evermind holds written over what differs from the reading kept with
 *  it; a new card for one made here. */
export function cardForExport(character: CardCharacter, stored: StoredCard | null, now: Date): ExportedCard {
  const card = stored ? parsed(stored.text) : null;
  const fields = cardFields(card);
  if (!stored || !fields || !isObject(card)) return madeHere(character, now);

  let root: Fields;
  let data: Fields;
  if (fields === card.data) {
    // V2 or V3: the root keeps all it had, its V1 copies following their data.
    root = structuredClone(card);
    data = root.data as Fields;
    delete root.spec;
    delete root.spec_version;
    delete root.data;
  } else if (fields === card) {
    // A flat V1 card: its root stays as it is, as copies; its card's fields go into data.
    root = structuredClone(card);
    data = {};
    for (const key of [...FLAT_FIELDS, "alternate_greetings", "tags", "character_book", "extensions"]) {
      if (key in root) data[key] = structuredClone(root[key]);
    }
    // SillyTavern keeps the notes of a V1 card in creatorcomment, which the reader takes whenever
    // creator_notes is no text: the export goes by the same rule, or the notes read would be lost.
    if (!isText(data.creator_notes) && "creatorcomment" in root) data.creator_notes = structuredClone(root.creatorcomment);
    keepOwnData(root);
  } else {
    // The flat shape of Pygmalion: its fields under the names of a card, and no longer at the root.
    root = structuredClone(card);
    for (const key of PYGMALION_FIELDS) delete root[key];
    data = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => [key, structuredClone(value)]));
    keepOwnData(root);
  }

  const { written, changed } = writeColumns(data, character, stored.read);
  followCopies(root, data, written);
  const v3 = card.spec === "chara_card_v3";
  return cardsOf(root, data, changed, now, v3 ? "v3" : "v2", isNewerV3(card) ? String(card.spec_version) : "3.0");
}
