// The prompt of one chat turn, a copy of backend/app/prompting/engine.py:
// the cases of parity/ (chat, facts, lore, active) fail when a single word
// differs. Where Python's behaviour is odd it is kept, not smoothed: `x or y`
// falls back on 0, "" and null alike, `int()` truncates, and a stable sort that
// ties keeps the order it was given.

import { DEFAULT_RP_RULES, SCENARIO_RP_RULES } from "./defaults";
import { hasOriginalMacro, substitute, substituteOriginal } from "./macros";
import { pyRstrip, pyStrip } from "./text";
import { estimateTokens } from "./tokens";

// What the engine reads, not the types of src/types: a card saved by an older
// version has fields missing or null. A text, a list, a mode or a flag that is
// missing or null is read as Python reads it (`x or ""`, `.get(k, default)`),
// a null `enabled` included, which switches an entry off. Not a null
// `position`, `priority` or `source_position`: Python sorts and compares them
// as numbers and fails on a null, where this reads 0. Those columns are NOT
// NULL in the database, so no stored row holds one.
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

export interface PromptMessage extends ActiveMessage {
  role: string;
  position?: number | null;
  meta?: Record<string, unknown> | null;
}

export interface PromptMemory {
  id?: string | null;
  content?: string | null;
  is_pinned?: boolean | null;
  source_position?: number | null;
}

export interface PromptLoreEntry {
  keys?: string[] | null;
  content?: string | null;
  enabled?: boolean | null;
  case_sensitive?: boolean | null;
  priority?: number | null;
}

export interface PromptPassage {
  role?: string | null;
  content?: string | null;
  position?: number | null;
}

export interface ChatInput {
  character: PromptCharacter;
  persona: PromptPersona | null;
  conversation: PromptConversation | null;
  messages: PromptMessage[];
  connection: PromptConnection;
  global_instructions?: string;
  memories?: PromptMemory[] | null;
  lore_entries?: PromptLoreEntry[] | null;
  reply_length?: string;
  history_limit?: number;
  relevance_scores?: Record<string, number> | null;
  retrieved_passages?: PromptPassage[] | null;
  fold_leading_assistant?: boolean;
}

export interface PromptPayload {
  system: string;
  messages: { role: string; content: string }[];
  stop: string[];
  post_history: string;
  stats: Record<string, unknown>;
}

// Enough for what someone has deliberately marked, not so many that the block
// becomes another wall of text to skim. Pinning more than this is a sign the
// facts want consolidating rather than repeating.
const MAX_PINNED_RESTATED = 8;

// Re-stated at generation time because rule adherence decays with distance:
// on a long chat the system prompt is thousands of tokens away, drowned out
// by the model's own recent output.
const POST_HISTORY_REMINDER =
  "[Stay in character as {{char}}. Write only {{char}}'s next turn. Every line " +
  "of dialogue and every action must be a COMPLETE sentence — never leave " +
  "{{char}} trailing off mid-thought as a tic, and never END your reply on an " +
  "unfinished line or a lone word followed by '...'. Do NOT reuse phrasings, " +
  "images or sentence structures from your recent replies — especially not " +
  "how they ended; vary them. Move the scene forward with something new. " +
  "Never write or decide {{user}}'s actions.]";

const BUDGET_MARGIN = 200;
// If the system prompt alone eats more than this share of the budget, the
// example-dialogue block is dropped first (card identity is never dropped).
const SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES = 0.6;
// Established facts: pinned first, then newest; capped so a very long story
// cannot crowd out the card and history.
const MAX_FACTS = 60;
const FACTS_TOKEN_BUDGET = 700; // floor, used on tiny contexts
const MAX_FACTS_TOKEN_BUDGET = 2000; // cap, so facts never dominate the window
// Lorebook: keyword-triggered world knowledge, scanned over the recent turns.
const LORE_SCAN_MESSAGES = 6;
const LORE_TOKEN_BUDGET = 800;

/** Python's `sorted(items, key=key, reverse=reverse)`. Stable both ways: equal
 *  keys keep the order they came in, even reversed. The keys are compared with
 *  `<` and `>`, not subtracted, so that two keys of -Infinity (a fact with no
 *  score) tie by comparison and not as the NaN of `-Infinity - -Infinity`. */
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

/** Which facts get injected: pinned always survive, the rest fill the budget by
 *  relevance when scores are given, else newest-first (recency). Returned
 *  oldest-first for chronological reading. */
export function selectFacts<M extends PromptMemory>(
  memories: readonly M[],
  tokenBudget: number = FACTS_TOKEN_BUDGET,
  relevanceScores: Record<string, number> | null = null,
): M[] {
  const pinned = memories.filter((m) => m.is_pinned);
  const loose = memories.filter((m) => !m.is_pinned);
  const position = (m: M) => m.source_position ?? 0;
  // Own properties only: an id such as "constructor" is not a score.
  const score = (m: M, scores: Record<string, number>) =>
    typeof m.id === "string" && Object.hasOwn(scores, m.id) ? scores[m.id] : -Infinity;
  const others =
    relevanceScores !== null
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
  const lines: string[] = [];
  for (const memory of selectFacts(memories, tokenBudget, relevanceScores)) {
    const position = memory.source_position || 0;
    const prefix = position ? `(turn ${position}) ` : "";
    lines.push(`- ${prefix}${pyStrip(memory.content || "")}`);
  }
  return lines.join("\n");
}

/** Entries whose keywords appear in the recent turns, priority first, within
 *  the lore token budget. */
export function matchLore<E extends PromptLoreEntry>(
  entries: readonly E[],
  messages: readonly PromptMessage[],
): E[] {
  if (!entries.length) return [];
  const recent = sortedBy(messages, (m) => m.position ?? 0).slice(-LORE_SCAN_MESSAGES);
  const text = recent.map(activeContent).join("\n");
  const lowered = text.toLowerCase();

  const matched: E[] = [];
  for (const entry of entries) {
    if (!(entry.enabled === undefined || entry.enabled)) continue;
    const haystack = entry.case_sensitive ? text : lowered;
    for (const key of entry.keys || []) {
      const needle = entry.case_sensitive ? key : key.toLowerCase();
      if (needle && haystack.includes(needle)) {
        matched.push(entry);
        break;
      }
    }
  }

  const byPriority = sortedBy(matched, (e) => e.priority ?? 0, true);
  const kept: E[] = [];
  let budget = LORE_TOKEN_BUDGET;
  for (const entry of byPriority) {
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
  const {
    character,
    persona,
    summary,
    globalInstructions,
    includeExamples,
    charName,
    userName,
    memories,
    lore,
    factsBudget,
    relevanceScores,
    passages,
  } = parts;
  const isScenario = character.kind === "scenario";
  const sections: string[] = [];

  if (isScenario) {
    sections.push(
      `You are running "${charName}", an immersive roleplay scenario, for ${userName}.`,
    );
  } else {
    sections.push(`You are ${charName} in an endless immersive roleplay with ${userName}.`);
  }

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
    sections.push(
      pyRstrip(`### ABOUT ${userName.toUpperCase()} (the player's character)\n${body}`),
    );
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
    const lines: string[] = [];
    for (const p of sortedBy(passages, (p) => p.position || 0)) {
      const speaker = p.role === "assistant" ? charName : userName;
      const pos = p.position || 0;
      lines.push(`(turn ${pos}) ${speaker}: ${pyStrip(p.content || "")}`);
    }
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
  let rules: string;
  if (cardPrompt) {
    rules = hasOriginalMacro(cardPrompt) ? substituteOriginal(cardPrompt, defaultRules) : cardPrompt;
  } else {
    rules = defaultRules;
  }
  sections.push(rules);

  if (pyStrip(globalInstructions)) {
    sections.push(`### PLAYER'S STANDING INSTRUCTIONS\n${pyStrip(globalInstructions)}`);
  }

  return substitute(sections.join("\n\n"), charName, userName);
}

// A Map, not an object: "constructor" is not a length.
const LENGTH_OVERRIDES = new Map([
  [
    "short",
    "LENGTH OVERRIDE: keep every reply to ONE tight paragraph. Dense, punchy, no padding.",
  ],
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

/** The lowest position among the turns; `fallback` when there is none. */
function oldestPosition(turns: readonly Turn[], fallback: number): number {
  return turns.reduce(
    (oldest, turn) => Math.min(oldest, turn.position),
    turns[0]?.position ?? fallback,
  );
}

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

  const contextSize = Math.trunc(connection.context_size || 8192);
  const maxTokens = Math.trunc(connection.max_tokens || 1024);
  const budget = Math.max(512, contextSize - maxTokens - BUDGET_MARGIN);

  const lore = matchLore(input.lore_entries ?? [], messages);

  const lengthOverride = LENGTH_OVERRIDES.get(input.reply_length ?? "medium");
  if (lengthOverride) {
    globalInstructions = pyStrip(globalInstructions + "\n\n" + lengthOverride);
  }

  // Post-history block: what the model reads LAST, right before generating,
  // so it carries the most weight when the system prompt is far away up top.
  // Order: the card's own note, the pinned facts, then the player's live scene
  // directive, then a compact reminder of the guardrails models most often
  // drift on.
  const postBits: string[] = [];
  const cardNote = pyStrip(character.post_history_instructions || "");
  if (cardNote) postBits.push(cardNote);
  // Pinned facts, said again down here: a pin used to buy only an exemption
  // from the fact budget, which is worth nothing when the block sits thousands
  // of tokens above the model's own recent output.
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

  // Established facts scale with the context window (about 12%, capped): 700
  // tokens was starving long stories on a 16k context. Pinned facts bypass this.
  const factsBudget = Math.min(
    MAX_FACTS_TOKEN_BUDGET,
    Math.max(FACTS_TOKEN_BUDGET, Math.trunc(budget * 0.12)),
  );

  // History cap: past this many raw turns the model is mostly imitating its own
  // recent output instead of listening to instructions; the story beyond the
  // window lives in the summary and established facts.
  const renderTurns = (room: number): Turn[] => {
    let remaining = room;
    const ordered = sortedBy(messages, (m) => m.position ?? 0);
    const turns: Turn[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const message = ordered[ordered.length - 1 - i];
      if (historyLimit && turns.length >= historyLimit) break;
      let content = substitute(activeContent(message), charName, userName);
      // Player message modes: stored raw, marked up only for the model.
      const mode = message.meta?.mode;
      if (mode === "narrate") {
        content = `[Narration] ${content}`;
      } else if (mode === "ooc") {
        content = `(OOC: ${content})`;
      }
      const cost = estimateTokens(content) + 4;
      if (i > 0 && cost > remaining) break;
      remaining -= cost;
      turns.push({ role: message.role, content, position: message.position ?? 0 });
    }
    return turns.reverse();
  };

  const systemWith = (includeExamples: boolean, memoriesIn: readonly PromptMemory[] | null) =>
    buildSystem({
      character,
      persona,
      summary,
      globalInstructions,
      includeExamples,
      charName,
      userName,
      memories: memoriesIn,
      lore,
      factsBudget,
      relevanceScores,
      passages,
    });

  // Estimate the history window with a provisional (worst-case) fact block, so
  // we know which turns stay visible. Facts covering a still-visible turn are
  // then dropped: re-stating a message the model already sees is pure echo and
  // a top cause of repetition loops on long chats.
  const staticSystem = systemWith(true, memories);
  const provisional = renderTurns(
    budget - estimateTokens(staticSystem) - estimateTokens(postHistory),
  );
  const oldestVisible = oldestPosition(provisional, 0);
  const relevantMemories = (memories ?? []).filter(
    (m) => m.is_pinned || (m.source_position || 0) < oldestVisible,
  );
  const factsShown = selectFacts(relevantMemories, factsBudget, relevanceScores);

  let system = systemWith(true, relevantMemories);
  if (estimateTokens(system) > budget * SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES) {
    system = systemWith(false, relevantMemories);
  }

  const turns = renderTurns(budget - estimateTokens(system) - estimateTokens(postHistory));
  // The TRUE visible window: the oldest turn actually rendered. The provisional
  // `oldestVisible` (used above for the fact anti-echo filter) is computed from
  // a worst-case system with all memories, so it can under-count the window.
  // Consumers that need an exact boundary (passage dedup) must use this value.
  const visibleOldest = oldestPosition(turns, oldestVisible);
  const spokenTurns = turns.map(({ role, content }) => ({ role, content }));

  // Some chat templates refuse a conversation whose first message is the
  // assistant's, and answer with nothing at all rather than an error. Folding
  // the leading assistant turns into the system prompt keeps every word of them
  // and leaves a list that starts with the player. Only ever done as a retry,
  // since it is the weaker shape: the model reads the opening as instruction
  // rather than as its own voice.
  let folded = 0;
  if (input.fold_leading_assistant && spokenTurns.some((t) => t.role !== "assistant")) {
    let leading = 0;
    while (leading < spokenTurns.length && spokenTurns[leading].role === "assistant") leading++;
    const spoken = spokenTurns.splice(0, leading).map((t) => t.content);
    if (spoken.length) {
      folded = spoken.length;
      const block = spoken.map((s) => `${charName}: ${s}`).join("\n\n");
      system =
        `${system}\n\n### THE SCENE SO FAR ` +
        `(${charName} has already said this aloud; carry on from it ` +
        `rather than repeating it)\n${block}`;
    }
  }

  const stop = [`\n${userName}:`];
  const used =
    estimateTokens(system) +
    estimateTokens(postHistory) +
    spokenTurns.reduce((sum, t) => sum + estimateTokens(t.content) + 4, 0);
  const stats = {
    used_tokens: used,
    budget,
    context_size: contextSize,
    messages_included: spokenTurns.length,
    messages_total: messages.length,
    lore_matched: lore.length,
    facts_injected: factsShown.length,
    facts_total: (memories ?? []).length,
    oldest_visible: visibleOldest,
    fact_positions: factsShown.map((m) => m.source_position ?? null),
    passages_injected: (passages ?? []).length,
    leading_assistant_folded: folded,
  };
  return { system, messages: spokenTurns, stop, post_history: postHistory, stats };
}
