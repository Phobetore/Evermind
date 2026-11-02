// What is kept of a card that a model wrote, a copy of `clean_card_draft` in
// backend/app/services/card_assistant.py: the cases of parity/card_draft.json fail
// when a single field differs.
//
// Only text, and a whole number written out, count as a word of a list: a null or
// a boolean is neither "None" nor "True". A value that is no list holds none, and a
// bare string is a list of one: not a row of letters, which lore matching would find
// in nearly every message. As in `loreKeyword`, `1.0` and a number past 2^53 are
// read otherwise than in Python, since the parsed number keeps neither its type nor
// its digits.
//
// `toLowerCase()` and Python's `lower()` agree on every character that Unicode 15.1
// knows, the final sigma and the dotted capital I included. They differ on the 27
// capitals that Unicode 16 added (Garay, and a few Latin and Cyrillic ones), which
// Node 22 lower-cases and Python 3.13 does not know yet.

import { isRecord } from "./llmJson";
import { LIST_FIELDS, TEXT_FIELDS, loreKeyword } from "./payloads";
import { pyStrip, sliceCodePoints } from "./text";

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
  return list.map((word) => loreKeyword(word)).filter((word) => word !== "");
}

/** Whitelist and normalize what the model returned. */
export function cleanCardDraft(draft: Record<string, unknown>): CardDraft {
  const out: CardDraft = {};
  for (const field of TEXT_FIELDS) {
    const value = draft[field];
    if (typeof value === "string" && pyStrip(value)) out[field] = pyStrip(value);
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
    const content = typeof raw.content === "string" ? pyStrip(raw.content) : "";
    if (keys.length && content) entries.push({ keys: keys.slice(0, MAX_KEYS), content });
  }
  if (entries.length) out.lore_entries = entries;
  return out;
}
