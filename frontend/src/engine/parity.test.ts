import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeContent,
  buildChatPayload,
  matchLore,
  selectFacts,
  type ActiveMessage,
  type ChatInput,
  type PromptLoreEntry,
  type PromptMemory,
  type PromptMessage,
} from "./chat";
import { cleanCardDraft } from "./cardDraft";
import * as defaults from "./defaults";
import { parseLlmJson } from "./llmJson";
import { hasOriginalMacro, substitute, substituteOriginal } from "./macros";
import { planConsolidation, planMemoryChanges, type KnownFact } from "./memoryChanges";
import {
  MAX_TURNS_PER_RUN,
  MIN_FACTS_TO_CONSOLIDATE,
  buildCardPayload,
  buildConsolidationPayload,
  buildExtractionPayload,
  buildImpersonatePayload,
  buildSummaryPayload,
  movableFacts,
  type CardInput,
  type ConsolidationInput,
  type ExtractionInput,
  type ImpersonateInput,
  type SummaryInput,
} from "./payloads";
import { cosineScores, selectPassages, type RankedCandidate } from "./retrieval";
import { pyLstrip, pyRstrip, pyStrip } from "./text";
import { estimateTokens } from "./tokens";
import {
  continueHistory,
  passageCandidates,
  passageInfos,
  sceneOf,
  trimReply,
  type PassageStats,
} from "./turn";

// The cases in parity/ at the root of the repository are the ones the Python
// engine runs too (backend/tests/test_parity.py): the Python is the reference,
// and `expected` is what it wrote.

interface ParityCase {
  fn: string;
  name: string;
  input: unknown;
  expected: unknown;
}

// The twin of FUNCTIONS in backend/tests/parity_cases.py: the same names, and
// each one adapts the case's input object to the arguments of the function.
const adapt =
  <I>(run: (input: I) => unknown) =>
  (input: unknown) =>
    run(input as I);

const FUNCTIONS: Record<string, (input: unknown) => unknown> = {
  substitute: adapt<{ text: string; char_name: string; user_name: string }>((i) =>
    substitute(i.text, i.char_name, i.user_name),
  ),
  substitute_original: adapt<{ text: string; original: string }>((i) =>
    substituteOriginal(i.text, i.original),
  ),
  has_original_macro: adapt<{ text: string }>((i) => hasOriginalMacro(i.text)),
  estimate_tokens: adapt<{ text: string }>((i) => estimateTokens(i.text)),
  py_strip: adapt<{ text: string }>((i) => pyStrip(i.text)),
  py_lstrip: adapt<{ text: string }>((i) => pyLstrip(i.text)),
  py_rstrip: adapt<{ text: string }>((i) => pyRstrip(i.text)),
  default_prompts: () => ({ ...defaults }),
  active_content: adapt<{ message: ActiveMessage }>((i) => activeContent(i.message)),
  build_chat_payload: adapt<ChatInput>(buildChatPayload),
  select_facts: adapt<{
    memories: PromptMemory[];
    token_budget?: number;
    relevance_scores?: Record<string, number> | null;
  }>((i) => selectFacts(i.memories, i.token_budget, i.relevance_scores)),
  match_lore: adapt<{ entries: PromptLoreEntry[]; messages: PromptMessage[] }>((i) =>
    matchLore(i.entries, i.messages),
  ),
  trim_reply: adapt<{ text: string; char_name: string; user_name: string }>((i) =>
    trimReply(i.text, i.char_name, i.user_name),
  ),
  continue_history: adapt<{ messages: { position: number }[] }>((i) => continueHistory(i.messages)),
  scene_of: adapt<{ history: ActiveMessage[] }>((i) => sceneOf(i.history)),
  passage_candidates: adapt<{ history: PromptMessage[]; stats: PassageStats }>((i) =>
    passageCandidates(i.history, i.stats),
  ),
  passage_infos: adapt<{
    candidates: (ActiveMessage & { id: string; role: string; position?: number | null })[];
    ids: string[];
  }>((i) => passageInfos(i.candidates, i.ids)),
  // A set is not JSON: the list in the case is read as one, and null is no set.
  select_passages: adapt<{
    ranked: Record<string, number>;
    candidates: RankedCandidate[];
    token_budget: number;
    exclude_positions?: (number | null)[] | null;
  }>((i) =>
    selectPassages(
      i.ranked,
      i.candidates,
      i.token_budget,
      i.exclude_positions ? new Set(i.exclude_positions) : null,
    ),
  ),
  cosine_scores: adapt<{ query_vec: number[]; rows: number[][] }>((i) =>
    cosineScores(i.query_vec, i.rows),
  ),
  build_impersonate_payload: adapt<ImpersonateInput>(buildImpersonatePayload),
  build_summary_payload: adapt<SummaryInput>(buildSummaryPayload),
  build_extraction_payload: adapt<ExtractionInput>(buildExtractionPayload),
  movable_facts: adapt<{ memories: { is_pinned: boolean; source: string }[] }>((i) =>
    movableFacts(i.memories),
  ),
  build_consolidation_payload: adapt<ConsolidationInput>(buildConsolidationPayload),
  build_card_payload: adapt<CardInput>(buildCardPayload),
  payload_limits: () => ({
    max_turns_per_run: MAX_TURNS_PER_RUN,
    min_facts_to_consolidate: MIN_FACTS_TO_CONSOLIDATE,
  }),
  parse_llm_json: adapt<{ text: string }>((i) => parseLlmJson(i.text)),
  // The service raises on an answer that cannot be read: here it is null.
  memory_reply: adapt<{ text: string; existing: KnownFact[]; top_position: number }>((i) => {
    const parsed = parseLlmJson(i.text);
    return parsed && planMemoryChanges(parsed, i.existing, i.top_position);
  }),
  consolidation_reply: adapt<{ text: string; movable: { source_position: number }[] }>((i) =>
    planConsolidation(parseLlmJson(i.text), i.movable),
  ),
  clean_card_draft: adapt<{ draft: Record<string, unknown> }>((i) => cleanCardDraft(i.draft)),
};

const dir = fileURLToPath(new URL("../../../parity/", import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .sort();
const loaded = files.map((name) => ({
  name,
  cases: (JSON.parse(readFileSync(dir + name, "utf8")) as { cases: ParityCase[] }).cases,
}));

describe("the shared cases", () => {
  it("are found and read", () => {
    // A wrong path would otherwise run no case at all and pass.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(loaded.reduce((n, file) => n + file.cases.length, 0)).toBeGreaterThanOrEqual(20);
  });

  it("name exactly the registered functions", () => {
    // Both ways: a case with no function, and a function that no case calls.
    const named = new Set(loaded.flatMap((file) => file.cases.map((c) => c.fn)));
    expect([...named].sort()).toEqual(Object.keys(FUNCTIONS).sort());
  });
});

for (const { name, cases } of loaded) {
  describe(name, () => {
    for (const c of cases) {
      it(`${c.fn}: ${c.name}`, () => {
        const run = FUNCTIONS[c.fn];
        expect(run, `no function registered for "${c.fn}"`).toBeDefined();
        expect(run(c.input)).toEqual(c.expected);
      });
    }
  });
}
