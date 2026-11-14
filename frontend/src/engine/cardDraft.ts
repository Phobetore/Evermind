// What is kept of a card a model wrote, and how much room it gets to write it: step for
// step `clean_card_draft` and `with_room_for_a_card` in backend/app/services/card_assistant.py,
// with `words` and the card fields of backend/app/prompting/payloads.py, which the card
// prompt reads too.
//
// `toLowerCase()` and Python's `lower()` agree on the final sigma and the dotted capital I,
// which the recorded cases hold.

import { field, numberSource } from "./llmJson";
import { estimateTokens } from "./tokens";
import { isWritable, pyStrip, sliceCodePoints, textOf } from "./text";

export const TEXT_FIELDS = [
  "name",
  "tagline",
  "description",
  "personality",
  "scenario",
  "greeting",
  "example_dialogues",
] as const;
export const LIST_FIELDS = ["alternate_greetings", "tags"] as const;

const MAX_LORE_ENTRIES = 8;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 40; // code points
const MAX_KEYS = 6;

// A whole card with a lorebook runs past 2048 tokens, and a card cut short loses its last fields.
const CEILING = 4096;
// What the estimate of the prompt may miss: a ceiling past the context is refused by most servers.
const CONTEXT_MARGIN = 128;

// Python's `str(x)` for an element that is text or an int; null for anything else.
const writtenNumber = (source: string) => (/[.eE]/.test(source) ? null : source);
const writtenValue = (x: unknown) =>
  typeof x === "string" ? x : typeof x === "number" && Number.isInteger(x) ? BigInt(x).toString() : null;

/** The words of what stands for a list: each element that is text or a whole number,
 *  stripped, a bare string being a list of one. A lone surrogate cannot be written back:
 *  no word. A number read from a model's answer is taken as it was written, where the
 *  browser says (see `numberSource`): a whole float (`1.0`) is then no word, and an integer
 *  keeps all its digits, one of more than 308 included, which reads as null. Elsewhere a
 *  number is a double: a whole float is a word, an integer past 2^53 is rounded, and one
 *  of more than 308 digits is null, so no word. The source belongs to the very list the
 *  reader returned: a copy of it reads as doubles, so `cleanCardDraft` must be given the
 *  object `parseLlmJson` or `partialJson` returned, never a copy of it. */
export function words(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const found: string[] = [];
  for (const [i, x] of list.entries()) {
    const source = list === value ? numberSource(list, String(i)) : undefined;
    const written = source !== undefined ? writtenNumber(source) : writtenValue(x);
    if (written === null) continue;
    const word = pyStrip(written);
    if (word && isWritable(word)) found.push(word);
  }
  return found;
}

/** Each item the first time it comes, as it was first written: case and the spaces around it
 *  do not make another. */
function once(items: string[]): string[] {
  const first = new Map<string, string>();
  for (const item of items) {
    const same = pyStrip(item).toLowerCase();
    if (!first.has(same)) first.set(same, item);
  }
  return [...first.values()];
}

export interface DraftLoreEntry {
  keys: string[];
  content: string;
}

export type CardDraft = Partial<Record<(typeof TEXT_FIELDS)[number], string>> &
  Partial<Record<(typeof LIST_FIELDS)[number], string[]>> & { lore_entries?: DraftLoreEntry[] };

/** Whitelist and normalize what the model returned. */
export function cleanCardDraft(draft: Record<string, unknown>): CardDraft {
  const out: CardDraft = {};
  for (const name of TEXT_FIELDS) {
    const value = textOf(field(draft, name));
    if (value) out[name] = value;
  }
  for (const name of LIST_FIELDS) {
    let found = words(field(draft, name));
    if (name === "tags") found = found.map((tag) => sliceCodePoints(tag.toLowerCase(), MAX_TAG_LENGTH));
    // A model repeats itself, and lowercasing makes "Fantasy" and "fantasy" one tag.
    found = once(found);
    if (name === "tags") found = found.slice(0, MAX_TAGS);
    if (found.length) out[name] = found;
  }

  const entries: DraftLoreEntry[] = [];
  const lore = field(draft, "lore_entries");
  for (const raw of (Array.isArray(lore) ? lore : []).slice(0, MAX_LORE_ENTRIES)) {
    // A keyword written twice shows as two chips, and triggers the entry no more often.
    const keys = once(words(field(raw, "keys")));
    const content = textOf(field(raw, "content"));
    if (keys.length && content) entries.push({ keys: keys.slice(0, MAX_KEYS), content });
  }
  if (entries.length) out.lore_entries = entries;
  return out;
}

/** What `withRoomForACard` reads of a connection. */
export interface CardConnection {
  context_size?: number | null;
  max_tokens?: number | null;
}

/** The connection with a ceiling on the answer that a whole card fits under.
 *
 *  Only a ceiling the connection sets is raised: with none, the model's server decides,
 *  as for every other request. It never goes past what the context leaves once the
 *  prompt is in, nor under what the connection itself asks for. */
export function withRoomForACard<C extends CardConnection>(
  connection: C,
  payload: { system: string; messages: { content?: string | null }[] },
): C {
  const own = connection.max_tokens;
  if (!own) return connection;
  const prompt =
    estimateTokens(payload.system) +
    payload.messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
  const room = (connection.context_size || 0) - prompt - CONTEXT_MARGIN;
  return { ...connection, max_tokens: Math.max(own, Math.min(CEILING, room)) };
}
