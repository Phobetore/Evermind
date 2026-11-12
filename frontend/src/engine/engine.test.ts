import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanCardDraft } from "./cardDraft";
import * as engine from "./index";
import { parseLlmJson, partialJson } from "./llmJson";
import { MAX_TURNS_PER_RUN, planMemoryChanges } from "./memoryChanges";
import { pyMin } from "./text";

// What a recorded case cannot hold: how the engine is built, and answers that a case
// file would not carry, or that would make it heavy.

const dir = fileURLToPath(new URL(".", import.meta.url));

describe("the engine", () => {
  it("the engine imports nothing but its own files", () => {
    // So that it can run wherever the page does, without the interface around it.
    const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThanOrEqual(7);
    for (const name of sources) {
      const text = readFileSync(dir + name, "utf8");
      for (const [, from] of text.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        expect(from, `${name} imports ${from}`).toMatch(/^\.\//);
      }
      expect(text, `${name} imports for its side effects`).not.toMatch(/^\s*import\s+["']/m);
    }
  });

  it("a key named __proto__ in a reply changes no prototype", () => {
    // An answer that cannot be read would leave {}, which has no own __proto__.
    const parsed = parseLlmJson('{"__proto__": {"facts": [{"content": "Hidden."}]}, "summary": "S."}') ?? {};
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(planMemoryChanges(parsed, [], 3)).toStrictEqual({ add: [], update: {}, delete: [], summary: "S." });

    const [fields, writing] = partialJson('{"__proto__": {"name": "Hidden"}, "name": "An');
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(Object.hasOwn(fields, "__proto__")).toBe(true);
    expect(writing).toBe("name");

    // An id comes from storage, not from the model; still, it is a key like any other.
    const plan = planMemoryChanges(
      { updated_facts: [{ replaces: "Old.", content: "New." }] },
      [{ id: "__proto__", content: "Old.", is_pinned: false, source: "auto" }],
      3,
    );
    expect(Object.hasOwn(plan.update, "__proto__")).toBe(true);
    expect(plan.update["__proto__"]).toBe("New.");
    expect(({} as Record<string, unknown>).facts).toBeUndefined();
  });

  it("a reply nested 100,000 deep is refused without a stack overflow", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(parseLlmJson(`{"a": ${deep}}`)).toBeNull();
    expect(parseLlmJson(`Here: {"a": ${deep}} done`)).toBeNull();
    expect(partialJson(`{"a": ${deep}, "b": "x`)).toStrictEqual([{}, null]);
    expect(partialJson(`{"name": "Ana", "tags": [${deep}`)).toStrictEqual([{ name: "Ana", tags: [] }, "tags"]);
    // Refused by counting, at a depth JSON.parse would still read: 900 brackets read, 901 do not.
    const nested = (depth: number) => `{"a": ${"[".repeat(depth - 1)}${"]".repeat(depth - 1)}}`;
    expect(parseLlmJson(nested(900))).not.toBeNull();
    expect(parseLlmJson(nested(901))).toBeNull();
  });

  it("NaN outside a string reads as null", () => {
    expect(parseLlmJson('{"a": NaN, "b": [Infinity, -Infinity], "c": "NaN", "d": 1e400}')).toStrictEqual({
      a: null,
      b: [null, null],
      c: "NaN",
      d: null,
    });
    // Python's integers have no -0; its floats do.
    expect(parseLlmJson('{"a": -0, "b": -0.0}')).toStrictEqual({ a: 0, b: -0 });
  });

  it("numbers in a card answer become words as Python's do", () => {
    // A case file is read by a plain JSON.parse, which keeps no number's source: so here.
    // The expected values are what clean_card_draft gives in Python for the same text.
    const big = "9".repeat(309);
    const answer = `{"tags": [1.0, 2, 1e2, -0.0, 12345678901234567890], "lore_entries": [{"keys": [3.0, 9007199254740993, -12, ${big}], "content": "C"}]}`;
    expect(cleanCardDraft(parseLlmJson(answer) ?? {})).toStrictEqual({
      tags: ["2", "12345678901234567890"],
      lore_entries: [{ keys: ["9007199254740993", "-12", big], content: "C" }],
    });
    // A list still being written keeps its numbers as they were written too.
    const [fields, writing] = partialJson('{"name": "A", "tags": [1.0, 12345678901234567890, -0.0, 4, 7');
    expect(writing).toBe("tags");
    expect(cleanCardDraft(fields)).toStrictEqual({ name: "A", tags: ["12345678901234567890", "4"] });
  });

  it("no summary builder, and the ghostwriter reads no memories", () => {
    // The summary is the memory pass's to write, and Python has no builder of its own for it.
    expect(Object.keys(engine).filter((name) => /summar/i.test(name))).toStrictEqual([]);

    // A fact would take room from the turns that the ghostwriter reads, and say nothing it uses.
    const input = {
      character: { name: "Ana" },
      persona: { name: "Alex" },
      conversation: {},
      messages: Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        variants: [`Turn ${i}. ` + "word ".repeat(100)],
        position: i + 1,
      })),
      connection: {},
    };
    const memories = [
      { id: "a", content: "A secret. ".repeat(350), is_pinned: true, source: "auto", source_position: 1 },
    ];
    // The fact does take room when the chat payload is given it: so the test can fail.
    expect(engine.buildChatPayload({ ...input, memories }).messages.length).toBeLessThan(
      engine.buildChatPayload(input).messages.length,
    );
    expect(engine.buildImpersonatePayload({ ...input, memories } as typeof input)).toStrictEqual(
      engine.buildImpersonatePayload(input),
    );
  });

  it("the smallest of several numbers is the first, as Python's min picks it", () => {
    expect(pyMin([], 7)).toBe(7);
    expect(pyMin([3, 1, 2], 0)).toBe(1);
    // Of two that compare equal, the first: Math.min would give -0 both ways, and NaN.
    expect(Object.is(pyMin([0, -0], 9), 0)).toBe(true);
    expect(Object.is(pyMin([-0, 0], 9), -0)).toBe(true);
    expect(pyMin([1, NaN], 9)).toBe(1);
  });

  it("the constants say what Python's say", () => {
    expect(MAX_TURNS_PER_RUN).toBe(40);
    expect(engine.MIN_FACTS_TO_CONSOLIDATE).toBe(8);
  });
});
