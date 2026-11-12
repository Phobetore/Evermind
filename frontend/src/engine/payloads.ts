// The prompts that are not a chat turn's, step for step backend/app/prompting/payloads.py:
// ghost-writing the player's next message, extracting and consolidating the memory, and
// drafting a card. Like the Python, none of it checks what it is given: a position is a
// number, a message has a role, a fact a content.

import { LIST_FIELDS, TEXT_FIELDS, words } from "./cardDraft";
import {
  activeContent,
  buildChatPayload,
  isOutOfCharacter,
  type ChatInput,
  type PromptCharacter,
  type PromptMessage,
  type PromptPayload,
  type PromptPersona,
} from "./chat";
import {
  CARD_ASSISTANT_PROMPT,
  IMPERSONATE_PROMPT,
  MEMORY_CONSOLIDATION_PROMPT,
  MEMORY_EXTRACTION_PROMPT,
} from "./defaults";
import { isRecord } from "./llmJson";
import { substitute } from "./macros";
import { MAX_TURNS_PER_RUN } from "./memoryChanges";
import { pyStrip } from "./text";

// Python's card prompt reads `words` here: so does the engine's door.
export { words };

export const MIN_FACTS_TO_CONSOLIDATE = 8; // fewer than this and merging them is not worth a call

const CARD_FIELDS: readonly string[] = [...TEXT_FIELDS, ...LIST_FIELDS];

/** A payload that is not a chat turn's reports nothing: Python leaves its stats empty. */
type PlainPayload = PromptPayload<Record<string, never>>;

const plain = (system: string, messages: PlainPayload["messages"], stop: string[]): PlainPayload => ({
  system,
  messages,
  stop,
  post_history: "",
  stats: {},
});

/** What the ghostwriter reads: the chat, without its memory, which it has no use for. */
export type ImpersonateInput = Pick<
  ChatInput,
  "character" | "persona" | "conversation" | "messages" | "connection"
>;

/** The prompt that ghost-writes the player's next message. */
export function buildImpersonatePayload(input: ImpersonateInput): PlainPayload {
  // Only these five: a fact given along would take room from the turns in the chat payload.
  const { character, persona, conversation, messages, connection } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  // Without what the card says to the character among the turns: the player's pen reads no
  // reminder meant for the character.
  const base = buildChatPayload({ character, persona, conversation, messages, connection, insertions: false });

  const contextBits: string[] = [];
  if (persona?.description) contextBits.push(`ABOUT ${userName}: ${persona.description}`);
  if (conversation?.summary) contextBits.push(`STORY SO FAR: ${conversation.summary}`);
  let system = substitute(IMPERSONATE_PROMPT, charName, userName);
  if (contextBits.length) system += "\n\n" + contextBits.join("\n\n");

  // Flip roles: the character's turns become "user", the player's become
  // "assistant", so the model naturally continues as the player.
  const flipped = base.messages.map((m) => ({
    role: m.role === "assistant" ? "user" : "assistant",
    content: m.content,
  }));
  return plain(system, flipped, [`\n${charName}:`]);
}

export interface ExtractionMessage extends PromptMessage {
  position: number;
}

export interface ExtractionInput<M extends ExtractionMessage = ExtractionMessage> {
  character: PromptCharacter;
  persona: PromptPersona | null;
  conversation: { summary?: string | null; memory_position?: number | null };
  messages: readonly M[];
  memories: readonly { content: string }[];
}

/** The prompt that reads the turns since the last pass for new facts and a new summary,
 *  and those turns, the newest last: the caller marks the last one's position as read.
 *  Null when there is no turn since, or none in character.
 *
 *  A memory position of 0 means nothing was read, so the first turn is one to read,
 *  unless it is the greeting, which is the card's and not the story's. */
export function buildExtractionPayload<M extends ExtractionMessage>(
  input: ExtractionInput<M>,
): { payload: PlainPayload; turns: M[] } | null {
  const { character, persona, conversation, messages, memories } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const memoryPosition = conversation.memory_position || 0;

  const unread = (message: M) =>
    message.position > memoryPosition ||
    (memoryPosition === 0 && message.position === 0 && !message.meta?.greeting);

  const turns = messages.filter(unread).slice(-MAX_TURNS_PER_RUN);
  // What the player said out of character is for the next reply, not a line of the
  // story; it still comes back with the turns, which it is one of.
  const newTurns = turns.filter((m) => !isOutOfCharacter(m));
  if (!newTurns.length) return null;

  const factsBlock = memories.map((m) => `- ${m.content}`).join("\n") || "(none yet)";
  const turnsBlock = newTurns
    .map(
      (m) =>
        `${m.role === "user" ? userName : charName} (turn ${m.position}): ` +
        substitute(activeContent(m), charName, userName),
    )
    .join("\n\n");

  const payload = plain(
    substitute(MEMORY_EXTRACTION_PROMPT, charName, userName),
    [
      {
        role: "user",
        content:
          `CURRENT SUMMARY:\n${conversation.summary || "(empty)"}\n\n` +
          `FACTS ALREADY RECORDED:\n${factsBlock}\n\n` +
          `NEWEST TURNS:\n${turnsBlock}\n\n` +
          "Reply with the JSON now.",
      },
    ],
    [],
  );
  return { payload, turns };
}

export interface ConsolidationInput {
  character: PromptCharacter;
  persona: PromptPersona | null;
  movable: readonly { content: string }[];
}

/** The prompt that merges these facts into a shorter, denser set. */
export function buildConsolidationPayload(input: ConsolidationInput): PlainPayload {
  const { character, persona, movable } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const factsBlock = movable.map((m) => `- ${m.content}`).join("\n");
  return plain(
    substitute(MEMORY_CONSOLIDATION_PROMPT, charName, userName),
    [{ role: "user", content: `FACTS TO CONSOLIDATE:\n${factsBlock}\n\nReply with the JSON now.` }],
    [],
  );
}

/** What the creator has already written, among the fields a card draft fills. */
function existingFields(existing: Record<string, unknown> | null): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    const holds = typeof value === "string" ? value !== "" : Array.isArray(value) && value.length > 0;
    if (holds && CARD_FIELDS.includes(key)) filled[key] = value;
  }
  return filled;
}

/** How Python's `json.dumps` writes a number that `JSON.parse` read. A fraction is written
 *  the same in both but for the small ones, which Python gives an exponent from 1e-5 on,
 *  of two digits at least, where JavaScript waits for 1e-7. A whole number cannot be told
 *  apart from the float Python would write as `1.0` or, from 1e16 on, as `1.5e+16`, and one
 *  past 2^53 has been rounded. A card's fields are strings, so no card prompt holds a number. */
function pyNumber(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity";
  const [digits, exponent] = n.toExponential().split("e");
  const power = Number(exponent);
  return power >= -4 ? String(n) : `${digits}e-${String(-power).padStart(2, "0")}`;
}

/** Python's `json.dumps(value, ensure_ascii=False, indent=2)`: `JSON.stringify(value, null, 2)`
 *  but for the numbers. Still not the same: an object key that reads as an integer, which
 *  JavaScript puts first, and a lone surrogate, which JavaScript escapes and Python writes as
 *  it is. A case could record them, but a card's fields are strings or lists of strings, so
 *  none of this reaches a card prompt and no case holds it. */
function pyJsonDumps(value: unknown, depth = 0): string {
  const inner = " ".repeat(2 * (depth + 1));
  const outer = " ".repeat(2 * depth);
  if (typeof value === "number") return pyNumber(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((item) => inner + pyJsonDumps(item, depth + 1)).join(",\n")}\n${outer}]`;
  }
  if (isRecord(value)) {
    const members = Object.entries(value).map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${pyJsonDumps(item, depth + 1)}`,
    );
    return members.length ? `{\n${members.join(",\n")}\n${outer}}` : "{}";
  }
  return JSON.stringify(value);
}

export interface CardInput {
  prompt: string;
  kind: string;
  existing: Record<string, unknown> | null;
}

/** The prompt that turns a creator's brief into a card draft. */
export function buildCardPayload(input: CardInput): PlainPayload {
  const { prompt, kind, existing } = input;
  const kindLine =
    kind === "scenario"
      ? "The card is a SCENARIO (the AI narrates the world and plays every character except the player)."
      : "The card is a CHARACTER (the AI embodies one person the player talks to).";
  const filled = existingFields(existing);
  const parts = [`${kindLine}\n\nCREATOR'S BRIEF:\n${pyStrip(prompt)}`];
  if (Object.keys(filled).length) {
    parts.push("EXISTING FIELDS (keep their content, fill the rest):\n" + pyJsonDumps(filled));
  }

  // A lorebook, or an entry, that is not what it should be holds no keyword.
  const entries = existing?.lore_entries;
  const knownKeys = (Array.isArray(entries) ? entries : []).flatMap((raw) =>
    isRecord(raw) ? words(raw.keys) : [],
  );
  if (knownKeys.length) {
    // A Set keeps each keyword where it was first seen, as `dict.fromkeys` does.
    parts.push("EXISTING LOREBOOK KEYWORDS (cover other subjects):\n" + [...new Set(knownKeys)].join(", "));
  }

  parts.push("Reply with the JSON now.");
  return plain(CARD_ASSISTANT_PROMPT, [{ role: "user", content: parts.join("\n\n") }], []);
}
