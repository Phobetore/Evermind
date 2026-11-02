// The prompts that are not a chat turn's, a copy of backend/app/prompting/payloads.py:
// the cases of parity/payloads.json fail when a single word differs. Like the
// Python, none of it checks what it is given: a position is a number, and a
// message a role.

import {
  activeContent,
  buildChatPayload,
  type ActiveMessage,
  type ChatInput,
  type PromptCharacter,
  type PromptPayload,
  type PromptPersona,
} from "./chat";
import {
  CARD_ASSISTANT_PROMPT,
  IMPERSONATE_PROMPT,
  MEMORY_CONSOLIDATION_PROMPT,
  MEMORY_EXTRACTION_PROMPT,
  SUMMARIZE_PROMPT,
} from "./defaults";
import { isRecord } from "./llmJson";
import { substitute } from "./macros";
import { pyStrip } from "./text";

export const MAX_TURNS_PER_RUN = 40; // safety cap on turns fed to one extraction call
export const MIN_FACTS_TO_CONSOLIDATE = 8; // fewer than this and merging them is not worth a call

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
const CARD_FIELDS: readonly string[] = [...TEXT_FIELDS, ...LIST_FIELDS];

/** What the Python builds as `PromptPayload(system=..., messages=..., stop=...)`:
 *  the rest keeps its defaults. */
function plain(system: string, messages: PromptPayload["messages"], stop: string[]): PromptPayload {
  return { system, messages, stop, post_history: "", stats: {} };
}

type ChatSource = Pick<
  ChatInput,
  "character" | "persona" | "conversation" | "messages" | "connection"
>;

export type ImpersonateInput = ChatSource & Pick<ChatInput, "memories">;

/** The prompt that ghost-writes the player's next message. */
export function buildImpersonatePayload(input: ImpersonateInput): PromptPayload {
  const { character, persona, conversation, messages, connection, memories } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const base = buildChatPayload({ character, persona, conversation, messages, connection, memories });

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

export type SummaryInput = ChatSource;

/** The prompt that writes the story so far. */
export function buildSummaryPayload(input: SummaryInput): PromptPayload {
  const { character, persona, conversation, messages, connection } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const base = buildChatPayload({ character, persona, conversation, messages, connection });
  return plain(
    substitute(SUMMARIZE_PROMPT, charName, userName),
    [
      ...base.messages,
      { role: "user", content: "[Write the summary of the roleplay so far now.]" },
    ],
    [],
  );
}

export interface ExtractionMessage extends ActiveMessage {
  role: string;
  position: number;
}

export interface ExtractionInput {
  character: PromptCharacter;
  persona: PromptPersona | null;
  conversation: { summary?: string | null; memory_position?: number | null };
  messages: readonly ExtractionMessage[];
  memories: readonly { content: string }[];
}

/** The prompt that reads the turns since the last pass for new facts and a new
 *  summary, and the position of the newest of those turns. Null when there is no
 *  turn since. */
export function buildExtractionPayload(
  input: ExtractionInput,
): { payload: PromptPayload; top_position: number } | null {
  const { character, persona, conversation, messages, memories } = input;
  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const memoryPosition = conversation.memory_position || 0;

  const newTurns = messages.filter((m) => m.position > memoryPosition).slice(-MAX_TURNS_PER_RUN);
  if (!newTurns.length) return null;
  const topPosition = Math.max(...newTurns.map((m) => m.position));

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
  return { payload, top_position: topPosition };
}

/** The facts that consolidation may merge: neither pinned nor written by hand. */
export function movableFacts<M extends { is_pinned?: boolean | null; source?: string | null }>(
  memories: readonly M[],
): M[] {
  return memories.filter((m) => !m.is_pinned && m.source === "auto");
}

export interface ConsolidationInput {
  character: PromptCharacter;
  persona: PromptPersona | null;
  movable: readonly { content: string }[];
}

/** The prompt that merges these facts into a shorter, denser set. */
export function buildConsolidationPayload(input: ConsolidationInput): PromptPayload {
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
export function existingFields(existing: Record<string, unknown> | null): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    const holds = typeof value === "string" ? value !== "" : Array.isArray(value) && value.length > 0;
    if (holds && CARD_FIELDS.includes(key)) filled[key] = value;
  }
  return filled;
}

/** The text of a keyword of an existing lorebook entry, "" when it is none: a
 *  string, or a whole number written out. Two numbers are read otherwise than in
 *  Python, since `JSON.parse` keeps neither the type nor the digits of a number:
 *  `1.0` is a float there and no keyword, where the parsed `1` is "1" here; and an
 *  integer past 2^53 is a keyword there, and none here. */
export function loreKeyword(key: unknown): string {
  if (typeof key === "string") return pyStrip(key);
  if (typeof key === "number" && Number.isSafeInteger(key)) return String(key);
  return "";
}

// A lorebook, or the keys of an entry, that is not a list holds nothing, whatever
// it is: a string is not a list of letters.
function loreKeywords(existing: Record<string, unknown> | null): string[] {
  const found: string[] = [];
  const entries = existing?.lore_entries;
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!isRecord(raw)) continue;
    for (const key of Array.isArray(raw.keys) ? raw.keys : []) {
      const text = loreKeyword(key);
      if (text) found.push(text);
    }
  }
  return found;
}

/** How Python writes a number in `json.dumps`. A whole number is written as
 *  JavaScript writes it, which is how Python writes an int, and a float from 1e21
 *  on. A float that Python wrote as `1.0` or `1e+16` is a whole number here too,
 *  and cannot be told apart. A fraction is written the same in both but for the
 *  small ones, which Python gives an exponent from 1e-5 on, of two digits at
 *  least, where JavaScript waits for 1e-7. There is no fraction at the other end:
 *  past 2^52, every double is whole. */
function pyNumber(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
  const [digits, exponent] = n.toExponential().split("e");
  const power = Number(exponent);
  if (power >= -4) return String(n);
  return `${digits}e-${String(-power).padStart(2, "0")}`;
}

/** Python's `json.dumps(value, ensure_ascii=False, indent=2)` for what comes out
 *  of `JSON.parse`. It is `JSON.stringify(value, null, 2)` but for the numbers,
 *  which `pyNumber` writes. Strings are the same in both, and so are the empty
 *  list and object. Not the same, and not told apart by any case since a file of
 *  cases cannot hold them: an integer-like object key (JavaScript puts it first, in
 *  ascending order), an integer past 2^53, and a lone surrogate, which JavaScript
 *  escapes and Python leaves as it is. */
export function pyJsonDumps(value: unknown): string {
  const write = (item: unknown, depth: number): string => {
    if (typeof item === "number") return pyNumber(item);
    const inner = " ".repeat(2 * (depth + 1));
    const outer = " ".repeat(2 * depth);
    if (Array.isArray(item)) {
      if (!item.length) return "[]";
      const items = item.map((each) => inner + write(each, depth + 1));
      return `[\n${items.join(",\n")}\n${outer}]`;
    }
    if (isRecord(item)) {
      const entries = Object.entries(item);
      if (!entries.length) return "{}";
      const members = entries.map(
        ([key, each]) => `${inner}${JSON.stringify(key)}: ${write(each, depth + 1)}`,
      );
      return `{\n${members.join(",\n")}\n${outer}}`;
    }
    return JSON.stringify(item);
  };
  return write(value, 0);
}

export interface CardInput {
  prompt: string;
  kind: string;
  existing: Record<string, unknown> | null;
}

/** The prompt that turns a creator's brief into a card draft. */
export function buildCardPayload(input: CardInput): PromptPayload {
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

  const knownKeys = loreKeywords(existing);
  if (knownKeys.length) {
    parts.push(
      "EXISTING LOREBOOK KEYWORDS (cover other subjects):\n" + [...new Set(knownKeys)].join(", "),
    );
  }

  parts.push("Reply with the JSON now.");
  return plain(CARD_ASSISTANT_PROMPT, [{ role: "user", content: parts.join("\n\n") }], []);
}
