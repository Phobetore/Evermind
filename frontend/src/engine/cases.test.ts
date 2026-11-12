import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as defaults from "./defaults";
import * as engine from "./index";
import { isRecord } from "./llmJson";

// The cases in backend/tests/cases/ are written by the Python engine, which is the
// reference, and run by pytest too (backend/tests/test_recorded_cases.py). Each one
// names a function of that file's FUNCTIONS and gives its named arguments.

interface RecordedCase {
  fn: string;
  name: string;
  input: Record<string, unknown>;
  expected: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Run = (input: any) => unknown;

interface Adapter {
  // The functions of index.ts that the call reaches, so that none is left untested.
  covers: string[];
  run: Run;
}

const via = (covers: string[], run: Run): Adapter => ({ covers, run });

// From the name of a recorded function to the call that answers it here, through
// index.ts, the engine's only door. The input is the case's, as Python reads it: the
// adapter only passes its keys in order, or the whole of it where Python takes keywords.
const ADAPTERS: Record<string, Adapter> = {
  // The service raises on an answer that cannot be read: the case says null.
  memory_reply: via(["parseLlmJson", "planMemoryChanges"], (i) => {
    const parsed = engine.parseLlmJson(i.text);
    return parsed === null ? null : engine.planMemoryChanges(parsed, i.existing, i.top_position);
  }),
  consolidation_reply: via(["parseLlmJson", "planConsolidation"], (i) =>
    engine.planConsolidation(engine.parseLlmJson(i.text), i.movable),
  ),
  default_prompts: via([], () => ({ ...defaults })),

  build_chat_payload: via(["buildChatPayload"], (i) => engine.buildChatPayload(i)),
  match_lore: via(["matchLore"], (i) => engine.matchLore(i.entries, i.messages)),
  select_facts: via(["selectFacts"], (i) => engine.selectFacts(i.memories, i.token_budget, i.relevance_scores)),
  active_content: via(["activeContent"], (i) => engine.activeContent(i.message)),
  is_out_of_character: via(["isOutOfCharacter"], (i) => engine.isOutOfCharacter(i.message)),

  substitute: via(["substitute"], (i) => engine.substitute(i.text, i.char_name, i.user_name)),
  substitute_original: via(["substituteOriginal"], (i) => engine.substituteOriginal(i.text, i.original)),
  has_original_macro: via(["hasOriginalMacro"], (i) => engine.hasOriginalMacro(i.text)),
  estimate_tokens: via(["estimateTokens"], (i) => engine.estimateTokens(i.text)),
  strip_thought: via(["stripThought"], (i) => engine.stripThought(i.text)),
  trim_reply: via(["trimReply"], (i) => engine.trimReply(i.text, i.char_name, i.user_name)),
  words: via(["words"], (i) => engine.words(i.value)),
  is_movable: via(["isMovable"], (i) => engine.isMovable(i.fact)),
  movable_facts: via(["movableFacts"], (i) => engine.movableFacts(i.memories)),
  answer_texts: via(["answerTexts"], (i) => engine.answerTexts(i.parsed)),

  build_impersonate_payload: via(["buildImpersonatePayload"], (i) => engine.buildImpersonatePayload(i)),
  build_extraction_payload: via(["buildExtractionPayload"], (i) => engine.buildExtractionPayload(i)),
  build_consolidation_payload: via(["buildConsolidationPayload"], (i) => engine.buildConsolidationPayload(i)),
  build_card_payload: via(["buildCardPayload"], (i) => engine.buildCardPayload(i)),

  parse_llm_json: via(["parseLlmJson"], (i) => engine.parseLlmJson(i.text)),
  partial_json: via(["partialJson"], (i) => {
    const [fields, writing] = engine.partialJson(i.text);
    return { fields, writing };
  }),

  clean_card_draft: via(["cleanCardDraft"], (i) => engine.cleanCardDraft(i.draft)),
  with_room_for_a_card: via(["withRoomForACard"], (i) => engine.withRoomForACard(i.connection, i.payload)),

  continue_instruction: via([], () => engine.CONTINUE_INSTRUCTION),
  auto_title: via(["autoTitle"], (i) => engine.autoTitle(i.content)),
};

// toStrictEqual tells two classes apart by their `.constructor`, and on an object with
// an own key of that name, as a model's answer may hold, that is a value: two equal
// ones would differ by being two objects. That key is compared here, the rest as usual.
expect.addEqualityTesters([
  function keyNamedConstructor(a, b, testers) {
    if (!isRecord(a) || !isRecord(b)) return undefined;
    if (!Object.hasOwn(a, "constructor") || !Object.hasOwn(b, "constructor")) return undefined;
    const { constructor: inA, ...restOfA } = a;
    const { constructor: inB, ...restOfB } = b;
    return this.equals(inA, inB, testers, true) && this.equals(restOfA, restOfB, testers, true);
  },
]);

const dir = new URL("../../../backend/tests/cases/", import.meta.url);
const files = readdirSync(fileURLToPath(dir))
  .filter((name) => name.endsWith(".json"))
  .sort();
const loaded = files.map((name) => ({
  name,
  cases: (JSON.parse(readFileSync(new URL(name, dir), "utf8")) as { cases: RecordedCase[] }).cases,
}));

describe("the recorded cases", () => {
  it("are found and read", () => {
    // A wrong path would otherwise run no case at all, and pass.
    expect(files).toContain("memory_changes.json");
    expect(files).toContain("llm_json.json");
    expect(loaded.reduce((n, file) => n + file.cases.length, 0)).toBeGreaterThan(300);
  });

  it("are compared strictly", () => {
    // A key left undefined is not a key left out, which is what Python does.
    expect({ tags: undefined }).not.toStrictEqual({});
    expect({ constructor: { a: 1 }, b: undefined }).not.toStrictEqual({ constructor: { a: 1 } });
    expect({ constructor: { a: 1 } }).not.toStrictEqual({ constructor: { a: 2 } });
    expect({ constructor: { a: 1 }, b: 2 }).toStrictEqual({ constructor: { a: 1 }, b: 2 });
  });

  it("every recorded function has its adapter, and every function index.ts offers is reached by one", () => {
    const recorded = new Set(loaded.flatMap((file) => file.cases.map((c) => c.fn)));
    expect([...recorded].sort()).toStrictEqual(Object.keys(ADAPTERS).sort());

    // Both ways: an adapter that names what index.ts does not offer would cover nothing.
    const offered = Object.entries(engine)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    const covered = new Set(Object.values(ADAPTERS).flatMap((adapter) => adapter.covers));
    expect([...covered].sort()).toStrictEqual(offered.sort());
  });
});

for (const { name, cases } of loaded) {
  describe(name, () => {
    for (const c of cases) {
      it(`${c.fn}: ${c.name}`, () => {
        expect(ADAPTERS[c.fn].run(c.input)).toStrictEqual(c.expected);
      });
    }
  });
}
