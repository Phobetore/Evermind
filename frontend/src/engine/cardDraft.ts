// What is kept of a card that a model wrote, a copy of `clean_card_draft` in
// backend/app/services/card_assistant.py: the cases of parity/card_draft.json fail
// when a single field differs.
//
// Only text, and a whole number written out, count as a word of a list: a null or
// a boolean is neither "None" nor "True". A value that is no list holds none, and a
// bare string is a list of one: not a row of letters, which lore matching would find
// in nearly every message. A text that cannot be written back (a lone surrogate) is
// left out. As in `loreKeyword`, two kinds of number are read otherwise than in
// Python, since the parsed number keeps neither its type nor its digits: a float of
// whole value (`1.0`, `1e3`, `5E0`, `-0.0`) is a word here and none there, and an
// integer past 2^53 is a word there and none here.
//
// `toLowerCase()` and Python's `lower()` agree on every character that Unicode 15.1
// knows, the final sigma and the dotted capital I included. They differ on the 27
// capitals that Unicode 16 added (Garay, and a few Latin and Cyrillic ones), which
// Node 22 lower-cases and Python 3.13 does not know yet.

import { LIST_FIELDS, TEXT_FIELDS, loreKeyword } from "./payloads";
import { isWritable, pyStrip, sliceCodePoints } from "./text";
import { isRecord } from "./values";

const MAX_LORE_ENTRIES = 8;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40; // code points
const MAX_KEYS = 6;

export interface DraftLoreEntry {
  keys: string[];
  content: string;
}

export type CardDraft = Partial<Record<(typeof TEXT_FIELDS)[number], string>> &
  Partial<Record<(typeof LIST_FIELDS)[number], string[]>> & { lore_entries?: DraftLoreEntry[] };

function words(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list.map((word) => loreKeyword(word)).filter((word) => word !== "" && isWritable(word));
}

/** Whitelist and normalize what the model returned. */
export function cleanCardDraft(draft: Record<string, unknown>): CardDraft {
  const out: CardDraft = {};
  for (const field of TEXT_FIELDS) {
    const value = draft[field];
    if (typeof value === "string" && pyStrip(value) && isWritable(value)) out[field] = pyStrip(value);
  }
  for (const field of LIST_FIELDS) {
    const found = words(draft[field]);
    if (found.length) out[field] = found;
  }
  if (out.tags) {
    out.tags = out.tags
      .map((tag) => sliceCodePoints(tag.toLowerCase(), MAX_TAG_LENGTH))
      .slice(0, MAX_TAGS);
  }

  const entries: DraftLoreEntry[] = [];
  const lore = draft.lore_entries;
  for (const raw of (Array.isArray(lore) ? lore : []).slice(0, MAX_LORE_ENTRIES)) {
    if (!isRecord(raw)) continue;
    const keys = words(raw.keys);
    const content =
      typeof raw.content === "string" && isWritable(raw.content) ? pyStrip(raw.content) : "";
    if (keys.length && content) entries.push({ keys: keys.slice(0, MAX_KEYS), content });
  }
  if (entries.length) out.lore_entries = entries;
  return out;
}
