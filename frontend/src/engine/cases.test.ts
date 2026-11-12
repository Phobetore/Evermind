import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanCardDraft, withRoomForACard, words } from "./cardDraft";
import * as defaults from "./defaults";
import { isRecord, parseLlmJson, partialJson } from "./llmJson";
import { hasOriginalMacro, substitute, substituteOriginal } from "./macros";
import {
  answerTexts,
  isMovable,
  movableFacts,
  planConsolidation,
  planMemoryChanges,
} from "./memoryChanges";
import { stripThought } from "./text";
import { estimateTokens } from "./tokens";

// The cases in backend/tests/cases/ are written by the Python engine, which is the
// reference, and run by pytest too (backend/tests/test_recorded_cases.py). Each one
// names a function of that file's FUNCTIONS and gives its named arguments.

interface RecordedCase {
  fn: string;
  name: string;
  input: Record<string, unknown>;
  expected: unknown;
}

// From the name of a recorded function to the call that answers it here. The input
// is the case's, as Python reads it: the adapter only passes its keys in order.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ADAPTERS: Record<string, (input: any) => unknown> = {
  // The service raises on an answer that cannot be read: the case says null.
  memory_reply: (i) => {
    const parsed = parseLlmJson(i.text);
    return parsed === null ? null : planMemoryChanges(parsed, i.existing, i.top_position);
  },
  consolidation_reply: (i) => planConsolidation(parseLlmJson(i.text), i.movable),
  default_prompts: () => ({ ...defaults }),

  parse_llm_json: (i) => parseLlmJson(i.text),
  partial_json: (i) => {
    const [fields, writing] = partialJson(i.text);
    return { fields, writing };
  },

  clean_card_draft: (i) => cleanCardDraft(i.draft),
  with_room_for_a_card: (i) => withRoomForACard(i.connection, i.payload),

  substitute: (i) => substitute(i.text, i.char_name, i.user_name),
  substitute_original: (i) => substituteOriginal(i.text, i.original),
  has_original_macro: (i) => hasOriginalMacro(i.text),
  estimate_tokens: (i) => estimateTokens(i.text),
  strip_thought: (i) => stripThought(i.text),
  words: (i) => words(i.value),
  is_movable: (i) => isMovable(i.fact),
  movable_facts: (i) => movableFacts(i.memories),
  answer_texts: (i) => answerTexts(i.parsed),
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

  it("the cases still waiting for their function", () => {
    // The functions of chat.ts and payloads.ts, which come next: this list empties then.
    const waiting = new Set(
      loaded.flatMap((file) => file.cases.map((c) => c.fn)).filter((fn) => !Object.hasOwn(ADAPTERS, fn)),
    );
    expect([...waiting].sort()).toStrictEqual([
      "active_content",
      "auto_title",
      "build_card_payload",
      "build_chat_payload",
      "build_consolidation_payload",
      "build_extraction_payload",
      "build_impersonate_payload",
      "continue_instruction",
      "is_out_of_character",
      "match_lore",
      "select_facts",
      "trim_reply",
    ]);
  });
});

for (const { name, cases } of loaded) {
  const covered = cases.filter((c) => Object.hasOwn(ADAPTERS, c.fn));
  // A file whose functions are all still waiting would be an empty suite, which fails.
  if (!covered.length) continue;
  describe(name, () => {
    for (const c of covered) {
      it(`${c.fn}: ${c.name}`, () => {
        expect(ADAPTERS[c.fn](c.input)).toStrictEqual(c.expected);
      });
    }
  });
}
