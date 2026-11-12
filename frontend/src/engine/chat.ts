// The prompt of one chat turn and the cleanup of its reply, step for step
// backend/app/prompting/engine.py, with the two rules of a turn that live in
// backend/app/services/chat_service.py: the continue instruction and the automatic
// title. Where Python's behaviour is odd it is kept, not smoothed: `x or y` falls back
// on 0, "" and null alike, `int()` truncates, and a stable sort that ties keeps the
// order it was given, reversed or not.

import { DEFAULT_RP_RULES, SCENARIO_RP_RULES } from "./defaults";
import { hasOriginalMacro, substitute, substituteOriginal } from "./macros";
import { PY_WS, pyLstrip, pyRstrip, pyStrip, sliceCodePoints, stripThought } from "./text";
import { estimateTokens } from "./tokens";

// Python has it in engine.py, beside the reply's cleanup: so does the engine's door.
export { stripThought };

// What the engine reads, not the types of the interface. A text, a list, a mode or a flag
// that is missing or null is read as Python reads it (`x or ""`, `.get(k, default)`), a
// null `enabled` included, which switches an entry off.
//
// What a type cannot say, the data layer that feeds the engine guarantees, as the server's
// schemas and columns do today; on anything else the two engines may part:
// - every number is finite, and positions, indexes, sizes, budgets and counts are whole
//   (INTEGER columns, `int` settings), so never NaN, -0 or a fraction;
// - every string is well formed: no lone surrogate, which the schemas refuse;
// - a row is whole: a key the server always stores (a message's `position`, a fact's
//   `source_position`, both NOT NULL) is there.
// None of this holds for what a model answers, which is any text and is read as Python
// reads it.
export interface PromptCharacter {
  kind?: string | null;
  name?: string | null;
  description?: string | null;
  personality?: string | null;
  scenario?: string | null;
  example_dialogues?: string | null;
  system_prompt?: string | null;
  post_history_instructions?: string | null;
}

export interface PromptPersona {
  name?: string | null;
  description?: string | null;
}

export interface PromptConversation {
  summary?: string | null;
  author_note?: string | null;
}

export interface PromptConnection {
  context_size?: number | null;
  max_tokens?: number | null;
}

export interface ActiveMessage {
  variants?: string[] | null;
  active_index?: number | null;
}

/** What the server writes in a message's meta that the engine reads: `greeting` is only
 *  ever true, `mode` "narrate" or "ooc". The other keys are the interface's. */
export interface MessageMeta {
  greeting?: boolean;
  mode?: string;
  [key: string]: unknown;
}

export interface PromptMessage extends ActiveMessage {
  role: string;
  position?: number;
  meta?: MessageMeta | null;
}

export interface PromptMemory {
  id?: string | null;
  content?: string | null;
  is_pinned?: boolean | null;
  /** "user" for a fact written by hand, which reaches the prompt even when its turn does. */
  source?: string | null;
  source_position?: number;
}

export interface PromptLoreEntry {
  keys?: string[] | null;
  content?: string | null;
  enabled?: boolean | null;
}

export interface PromptPassage {
  role?: string | null;
  content?: string | null;
  position?: number | null;
}

/** The arguments of Python's `build_chat_payload`, by the same names. */
export interface ChatInput {
  character: PromptCharacter;
  persona: PromptPersona | null;
  conversation: PromptConversation | null;
  messages: readonly PromptMessage[];
  connection: PromptConnection;
  global_instructions?: string;
  memories?: readonly PromptMemory[] | null;
  lore_entries?: readonly PromptLoreEntry[] | null;
  reply_length?: string;
  history_limit?: number;
  relevance_scores?: Record<string, number> | null;
  retrieved_passages?: readonly PromptPassage[] | null;
  fold_leading_assistant?: boolean;
}

/** What the builder reports about the prompt it made: the first six are shown, the last
 *  two decide which old passages recall may add. */
export interface PromptStats {
  used_tokens: number;
  budget: number;
  context_size: number;
  messages_included: number;
  messages_total: number;
  lore_matched: number;
  /** The position of the oldest turn in the prompt, 0 when there is none. */
  oldest_visible: number;
  /** The `source_position` of each fact shown, null for a fact with none. */
  fact_positions: (number | null)[];
}

export interface PromptPayload<S = PromptStats> {
  system: string;
  messages: { role: string; content: string }[];
  stop: string[];
  post_history: string;
  stats: S;
}

// Enough for what someone marked, without another wall of text.
const MAX_PINNED_RESTATED = 8;

// Said again at generation time, since a rule weighs less the further back it is.
const POST_HISTORY_REMINDER =
  "[Stay in character as {{char}}. Write only {{char}}'s next turn. Every line " +
  "of dialogue and every action must be a COMPLETE sentence — never leave " +
  "{{char}} trailing off mid-thought as a tic, and never END your reply on an " +
  "unfinished line or a lone word followed by '...'. Do NOT reuse phrasings, " +
  "images or sentence structures from your recent replies — especially not " +
  "how they ended; vary them. Move the scene forward with something new. " +
  "Never write or decide {{user}}'s actions.]";

const BUDGET_MARGIN = 200;
const SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES = 0.6;
const MAX_FACTS = 60; // so that a long story cannot crowd out the card
const FACTS_TOKEN_BUDGET = 700; // floor, used on tiny contexts
const MAX_FACTS_TOKEN_BUDGET = 2000; // cap, so facts never dominate the window
const FACTS_BUDGET_SHARE = 0.12; // of the budget, between the two
const LORE_SCAN_MESSAGES = 6;
const LORE_TOKEN_BUDGET = 800;

/** The instruction a continuation sends as the player's turn, after the reply it extends. */
export const CONTINUE_INSTRUCTION =
  "[Continue your previous reply exactly where it stopped. Do not repeat anything, " +
  "do not start over — just keep going seamlessly.]";

/** Python's `sorted(items, key=key, reverse=reverse)`. Stable both ways: equal keys keep
 *  the order they came in, even reversed. The keys are compared, never subtracted, so
 *  that two facts with no score, both Infinity, tie rather than give NaN. */
function sortedBy<T>(items: readonly T[], key: (item: T) => number, reverse = false): T[] {
  const keyed = items.map((item) => ({ item, key: key(item) }));
  const sign = reverse ? -1 : 1;
  keyed.sort((a, b) => (a.key < b.key ? -sign : a.key > b.key ? sign : 0));
  return keyed.map((entry) => entry.item);
}

export function activeContent(message: ActiveMessage): string {
  const variants = message.variants?.length ? message.variants : [""];
  let index = message.active_index || 0;
  if (!(index >= 0 && index < variants.length)) index = variants.length - 1;
  return variants[index];
}

export function isOutOfCharacter(message: { meta?: MessageMeta | null }): boolean {
  return message.meta?.mode === "ooc";
}

/** Which facts get injected: pinned always survive, the rest fill the budget by relevance
 *  when scores are given, a fact with no vector yet first, else newest-first (recency).
 *  Returned oldest-first for chronological reading. */
export function selectFacts<M extends PromptMemory>(
  memories: readonly M[],
  tokenBudget: number = FACTS_TOKEN_BUDGET,
  relevanceScores: Record<string, number> | null = null,
): M[] {
  const pinned = memories.filter((m) => m.is_pinned);
  const loose = memories.filter((m) => !m.is_pinned);
  const position = (m: M) => m.source_position ?? 0;
  // Own keys only: an id such as "constructor" has no score of its own.
  const score = (m: M, scores: Record<string, number>) =>
    typeof m.id === "string" && Object.hasOwn(scores, m.id) ? scores[m.id] : Infinity;
  const others =
    relevanceScores != null
      ? sortedBy(loose, (m) => score(m, relevanceScores), true)
      : sortedBy(loose, position, true);

  const kept: M[] = [];
  let budget = tokenBudget;
  for (const memory of [...pinned, ...others]) {
    if (kept.length >= MAX_FACTS) break;
    const cost = estimateTokens(memory.content || "");
    if (!memory.is_pinned && cost > budget) continue;
    budget -= cost;
    kept.push(memory);
  }
  return sortedBy(kept, position);
}

function formatFacts(
  memories: readonly PromptMemory[],
  tokenBudget: number,
  relevanceScores: Record<string, number> | null,
): string {
  return selectFacts(memories, tokenBudget, relevanceScores)
    .map((memory) => {
      const position = memory.source_position || 0;
      const prefix = position ? `(turn ${position}) ` : "";
      return `- ${prefix}${pyStrip(memory.content || "")}`;
    })
    .join("\n");
}

/** Entries whose keywords appear in the recent turns, whatever the case, in the
 *  lorebook's order, within the lore token budget. */
export function matchLore<E extends PromptLoreEntry>(
  entries: readonly E[],
  messages: readonly PromptMessage[],
): E[] {
  if (!entries.length) return [];
  const recent = sortedBy(messages, (m) => m.position ?? 0).slice(-LORE_SCAN_MESSAGES);
  const text = recent.map(activeContent).join("\n").toLowerCase();

  const matched = entries.filter(
    (entry) =>
      (entry.enabled === undefined || entry.enabled) &&
      (entry.keys || []).some((key) => key && text.includes(key.toLowerCase())),
  );
  const kept: E[] = [];
  let budget = LORE_TOKEN_BUDGET;
  for (const entry of matched) {
    const cost = estimateTokens(entry.content || "");
    if (cost > budget) continue;
    budget -= cost;
    kept.push(entry);
  }
  return kept;
}

interface SystemParts {
  character: PromptCharacter;
  persona: PromptPersona | null;
  summary: string;
  globalInstructions: string;
  includeExamples: boolean;
  charName: string;
  userName: string;
  memories: readonly PromptMemory[] | null;
  lore: readonly PromptLoreEntry[];
  factsBudget: number;
  relevanceScores: Record<string, number> | null;
  passages: readonly PromptPassage[] | null;
}

function buildSystem(parts: SystemParts): string {
  const { character, persona, summary, globalInstructions, includeExamples, charName, userName } = parts;
  const { memories, lore, factsBudget, relevanceScores, passages } = parts;
  const isScenario = character.kind === "scenario";
  const sections: string[] = [];

  sections.push(
    isScenario
      ? `You are running "${charName}", an immersive roleplay scenario, for ${userName}.`
      : `You are ${charName} in an endless immersive roleplay with ${userName}.`,
  );

  const identity: string[] = [];
  if (character.description) identity.push(character.description);
  if (character.personality) {
    const label = isScenario ? "Tone and themes" : `${charName}'s personality`;
    identity.push(`${label}: ${character.personality}`);
  }
  if (character.scenario) identity.push(`Current scenario: ${character.scenario}`);
  if (identity.length) {
    const header = isScenario ? "SCENARIO" : `ABOUT ${charName.toUpperCase()}`;
    sections.push(`### ${header}\n` + identity.join("\n\n"));
  }

  if (persona && (persona.name || persona.description)) {
    const body = persona.description || "";
    sections.push(pyRstrip(`### ABOUT ${userName.toUpperCase()} (the player's character)\n${body}`));
  }

  if (summary) sections.push(`### STORY SO FAR\n${summary}`);

  if (lore.length) {
    const loreBlock = lore.map((entry) => pyStrip(entry.content || "")).join("\n\n");
    sections.push(`### WORLD KNOWLEDGE (relevant to the current scene)\n${loreBlock}`);
  }

  if (memories?.length) {
    const facts = formatFacts(memories, factsBudget, relevanceScores);
    if (facts) {
      sections.push(
        "### ESTABLISHED FACTS (hard canon — never contradict these, " +
          `${charName} never forgets them)\n${facts}`,
      );
    }
  }

  if (passages?.length) {
    const lines = sortedBy(passages, (p) => p.position || 0).map((p) => {
      const speaker = p.role === "assistant" ? charName : userName;
      return `(turn ${p.position || 0}) ${speaker}: ${pyStrip(p.content || "")}`;
    });
    sections.push(
      "### RELEVANT PAST (verbatim excerpts retrieved from earlier in this " +
        `story — may repeat; ${charName} recalls these)\n` +
        lines.join("\n"),
    );
  }

  if (includeExamples && character.example_dialogues) {
    sections.push(
      "### EXAMPLE OF HOW YOU WRITE\n(style reference only — never quote or reuse verbatim)\n" +
        character.example_dialogues,
    );
  }

  const defaultRules = isScenario ? SCENARIO_RP_RULES : DEFAULT_RP_RULES;
  const cardPrompt = pyStrip(character.system_prompt || "");
  let rules = defaultRules;
  if (cardPrompt) {
    rules = hasOriginalMacro(cardPrompt) ? substituteOriginal(cardPrompt, defaultRules) : cardPrompt;
  }
  sections.push(rules);

  if (pyStrip(globalInstructions)) {
    sections.push(`### PLAYER'S STANDING INSTRUCTIONS\n${pyStrip(globalInstructions)}`);
  }

  return substitute(sections.join("\n\n"), charName, userName);
}

// A Map, not an object: "constructor" is no length.
const LENGTH_OVERRIDES = new Map([
  ["short", "LENGTH OVERRIDE: keep every reply to ONE tight paragraph. Dense, punchy, no padding."],
  [
    "long",
    "LENGTH OVERRIDE: write expansive replies of 3 to 5 rich paragraphs, " +
      "with deep sensory and emotional detail — still ending on something " +
      "{{user}} can react to.",
  ],
]);

interface Turn {
  role: string;
  content: string;
  position: number;
}

/** Python's `min((t["position"] for t in turns), default=fallback)`. */
function oldestPosition(turns: readonly Turn[], fallback: number): number {
  if (!turns.length) return fallback;
  return turns.reduce((oldest, turn) => Math.min(oldest, turn.position), turns[0].position);
}

/** Python's `int()` of a number: no -0, which a strict comparison tells from 0. */
const int = (n: number) => Math.trunc(n) + 0;

export function buildChatPayload(input: ChatInput): PromptPayload {
  const { character, persona, conversation, messages, connection } = input;
  const memories = input.memories ?? null;
  const historyLimit = input.history_limit ?? 0;
  const relevanceScores = input.relevance_scores ?? null;
  const passages = input.retrieved_passages ?? null;
  let globalInstructions = input.global_instructions ?? "";

  const charName = character.name || "Character";
  const userName = persona?.name || "User";
  const summary = conversation?.summary || "";

  const contextSize = int(connection.context_size || 8192);
  const maxTokens = int(connection.max_tokens || 1024);
  const budget = Math.max(512, contextSize - maxTokens - BUDGET_MARGIN);

  const lore = matchLore(input.lore_entries ?? [], messages);

  const lengthOverride = LENGTH_OVERRIDES.get(input.reply_length ?? "medium");
  if (lengthOverride) globalInstructions = pyStrip(globalInstructions + "\n\n" + lengthOverride);

  // What the model reads last carries the most weight.
  const postBits: string[] = [];
  const cardNote = pyStrip(character.post_history_instructions || "");
  if (cardNote) postBits.push(cardNote);
  const pinned = (memories ?? []).filter((m) => m.is_pinned);
  if (pinned.length) {
    const lines = pinned
      .slice(0, MAX_PINNED_RESTATED)
      .map((m) => `- ${pyStrip(m.content || "")}`)
      .join("\n");
    postBits.push(`[Still true, and ${charName} has not forgotten any of it:\n${lines}]`);
  }
  const sceneDirective = pyStrip(conversation?.author_note || "");
  if (sceneDirective) postBits.push(`[Scene directive from ${userName}]: ${sceneDirective}`);
  postBits.push(POST_HISTORY_REMINDER);
  const postHistory = substitute(postBits.join("\n\n"), charName, userName);

  const factsBudget = Math.min(
    MAX_FACTS_TOKEN_BUDGET,
    Math.max(FACTS_TOKEN_BUDGET, Math.trunc(budget * FACTS_BUDGET_SHARE)),
  );

  // Newest first, the newest always kept, then reversed to read oldest first.
  const renderTurns = (room: number): Turn[] => {
    let remaining = room;
    const ordered = sortedBy(messages, (m) => m.position ?? 0);
    const turns: Turn[] = [];
    for (let i = 0; i < ordered.length; i++) {
      if (historyLimit && turns.length >= historyLimit) break;
      const message = ordered[ordered.length - 1 - i];
      let content = substitute(activeContent(message), charName, userName);
      // Player message modes: stored raw, marked up only for the model.
      const mode = message.meta?.mode;
      if (mode === "narrate") content = `[Narration] ${content}`;
      else if (mode === "ooc") content = `(OOC: ${content})`;
      const cost = estimateTokens(content) + 4;
      if (i > 0 && cost > remaining) break;
      remaining -= cost;
      turns.push({ role: message.role, content, position: message.position ?? 0 });
    }
    return turns.reverse();
  };

  const systemWith = (includeExamples: boolean, shown: readonly PromptMemory[] | null) =>
    buildSystem({
      character,
      persona,
      summary,
      globalInstructions,
      includeExamples,
      charName,
      userName,
      memories: shown,
      lore,
      factsBudget,
      relevanceScores,
      passages,
    });

  // A fact the model drew from a turn it still sees is left out unless pinned or written
  // by hand: an echo feeds repetition loops. Which turns stay is first estimated with
  // every fact in the system prompt.
  const everyFact = systemWith(true, memories);
  const provisional = renderTurns(budget - estimateTokens(everyFact) - estimateTokens(postHistory));
  const oldestVisible = oldestPosition(provisional, 0);
  const relevantMemories = (memories ?? []).filter(
    (m) => m.is_pinned || m.source === "user" || (m.source_position || 0) < oldestVisible,
  );
  const factsShown = selectFacts(relevantMemories, factsBudget, relevanceScores);

  let system = systemWith(true, relevantMemories);
  if (estimateTokens(system) > budget * SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES) {
    system = systemWith(false, relevantMemories);
  }

  const rendered = renderTurns(budget - estimateTokens(system) - estimateTokens(postHistory));
  // The oldest turn actually sent: the estimate above, with every fact, may leave out older ones.
  const visibleOldest = oldestPosition(rendered, oldestVisible);
  const turns = rendered.map(({ role, content }) => ({ role, content }));

  // Some chat templates answer nothing to a conversation that opens on the assistant, as
  // one with a greeting does. Folded into the system prompt, those turns keep every word;
  // only ever as a retry, since the model then reads the opening as instruction rather
  // than as its own voice.
  if (input.fold_leading_assistant && turns.some((t) => t.role !== "assistant")) {
    let leading = 0;
    while (leading < turns.length && turns[leading].role === "assistant") leading++;
    const spoken = turns.splice(0, leading).map((t) => t.content);
    if (spoken.length) {
      const block = spoken.map((s) => `${charName}: ${s}`).join("\n\n");
      system =
        `${system}\n\n### THE SCENE SO FAR ` +
        `(${charName} has already said this aloud; carry on from it ` +
        `rather than repeating it)\n${block}`;
    }
  }

  const used =
    estimateTokens(system) +
    estimateTokens(postHistory) +
    turns.reduce((sum, t) => sum + estimateTokens(t.content) + 4, 0);
  const stats: PromptStats = {
    used_tokens: used,
    budget,
    context_size: contextSize,
    messages_included: turns.length,
    messages_total: messages.length,
    lore_matched: lore.length,
    oldest_visible: visibleOldest,
    fact_positions: factsShown.map((m) => m.source_position ?? null),
  };
  return { system, messages: turns, stop: [`\n${userName}:`], post_history: postHistory, stats };
}

/** Post-generation cleanup: drop the model's thinking, anything it wrote for the player,
 *  and a leading "Name:" speaker tag if present. The offsets are found and used on the
 *  same string, so counting in UTF-16 units where Python counts code points changes nothing. */
export function trimReply(text: string, charName: string, userName: string): string {
  let body = stripThought(text);
  for (const marker of [`\n${userName}:`, `\n${userName} :`]) {
    const index = body.indexOf(marker);
    if (index !== -1) body = body.slice(0, index);
  }
  const stripped = pyLstrip(body);
  for (const prefix of [`${charName}:`, `${charName} :`]) {
    if (stripped.startsWith(prefix)) {
      body = pyLstrip(stripped.slice(prefix.length));
      break;
    }
  }
  return pyRstrip(body);
}

// Python's `\s` in a pattern on text is what `str.isspace()` calls a space.
const SPACES = new RegExp(`[${PY_WS}]+`, "g");
const AROUND_A_TITLE = new Set([..." \"'«»*"]);

/** Python's `text.strip(chars)`, for characters of a single UTF-16 unit. */
function stripChars(text: string, chars: Set<string>): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.has(text[start])) start++;
  while (end > start && chars.has(text[end - 1])) end--;
  return text.slice(start, end);
}

/** A conversation's title from its first message, the markup of a roleplay taken out. */
export function autoTitle(content: string): string {
  // Bounded first: these patterns are quadratic on a long run of unclosed brackets.
  const head = sliceCodePoints(content, 1000);
  let text = head.replace(/\*[^*]*\*/g, " ").replace(/\[[^\]]*\]/g, " ");
  text = stripChars(text.replace(SPACES, " "), AROUND_A_TITLE);
  if (!text) text = pyStrip(head.replace(/[*[\]]+/g, " ").replace(SPACES, " "));
  return sliceCodePoints(text, 60);
}
