import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanCardDraft } from "./cardDraft";
import { parseLlmJson, partialJson } from "./llmJson";
import { MAX_TURNS_PER_RUN, planMemoryChanges } from "./memoryChanges";

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
    const parsed = parseLlmJson('{"__proto__": {"facts": [{"content": "Hidden."}]}, "summary": "S."}');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed as object, "__proto__")).toBe(true);
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
    expect(cleanCardDraft(parseLlmJson(answer))).toStrictEqual({
      tags: ["2", "12345678901234567890"],
      lore_entries: [{ keys: ["9007199254740993", "-12", big], content: "C" }],
    });
    // A list still being written keeps its numbers as they were written too.
    const [fields, writing] = partialJson('{"name": "A", "tags": [1.0, 12345678901234567890, -0.0, 4, 7');
    expect(writing).toBe("tags");
    expect(cleanCardDraft(fields)).toStrictEqual({ name: "A", tags: ["12345678901234567890", "4"] });
  });

  it("the constants say what Python's say", () => {
    expect(MAX_TURNS_PER_RUN).toBe(40);
  });
});
