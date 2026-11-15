import { describe, expect, it, vi } from "vitest";
import { buildChatPayload, expandMacros } from "./index";
import { ROLE_REMINDER } from "@/engine";
import * as macros from "./macros";
import { describeMarkers } from "./macros";

// What a recorded case cannot hold: how long a card's markers take on a text built to be slow.

// Each call the engine makes to resolve a card's text is counted, and still resolves it.
vi.mock("./macros", async (importOriginal) => {
  const original = await importOriginal<typeof import("./macros")>();
  return { ...original, expandMacros: vi.fn(original.expandMacros) };
});

describe("a card's markers", () => {
  it("unclosed markers take linear time", () => {
    // A marker's body holds no brace, so an unclosed one ends at the next: otherwise each start
    // would scan to the end of the text, some 10^12 steps on this one.
    for (const unit of ["{{random:", "{{//"]) {
      const text = unit.repeat(Math.floor(7_000_000 / unit.length));
      const start = performance.now();
      expect(expandMacros(text, "Serana", "Alex", "c1")).toBe(text);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  it("a card's text is resolved once however often the prompt is built", () => {
    // Resolving reads the whole text: done again for each build of the system prompt while the
    // examples are fitted, a description of megabytes would cost that many full reads.
    const counted = vi.mocked(macros.expandMacros);
    const description = "A vampire {{random:a,b}}. " + "x".repeat(2_000_000);
    const blocks = Array.from({ length: 64 }, (_, i) => `{{char}}: Line ${i}. ` + "e".repeat(140));
    counted.mockClear();
    const start = performance.now();
    const built = buildChatPayload({
      character: {
        name: "Serana",
        card_rules: 2,
        description,
        personality: "wry",
        scenario: "Night.",
        system_prompt: "{{original}}",
        example_dialogues: blocks.map((block) => `<START>\n${block}\n`).join(""),
      },
      persona: { name: "Alex" },
      conversation: { id: "c1" },
      messages: ["Hi.", "Hello {{roll:d6}}.", "Well?"].map((text, i) => ({
        role: i % 2 ? "assistant" : "user",
        variants: [text],
        position: i,
      })),
      connection: {},
    });
    const elapsed = performance.now() - start;
    // The examples did not all fit, so the prompt was built several times.
    expect(built.system).not.toContain("Line 63.");
    const texts = counted.mock.calls.map(([text]) => text);
    expect(texts.filter((text) => text === description)).toHaveLength(1);
    expect(new Set(texts).size).toBe(texts.length);
    // About the time of one full read of the description.
    const once = performance.now();
    expandMacros(description, "Serana", "Alex", "c1");
    expect(elapsed).toBeLessThan(4 * (performance.now() - once) + 1000);
  });
});

describe("a card's markers for people", () => {
  it("markers read as words for people", () => {
    const show = (text: string) => describeMarkers(text, "Ilse", "Tom");
    expect(show("{{// note}}x")).toBe("x");
    expect(show("<USER> and <bot> and <CHAR>")).toBe("Tom and Ilse and Ilse");
    expect(show("{{random:matin,soir}}")).toBe("matin / soir");
    expect(show("{{pick::a::b}}")).toBe("a / b");
    // An escaped comma is a comma of the choice, not a place to split it.
    expect(show("{{random:a\\,b,c}}")).toBe("a,b / c");
    expect(show("a\\,b")).toBe("a\\,b");
    expect(show("{{roll:d20}}")).toBe("d20");
    expect(show("{{roll:0}}")).toBe("{{roll:0}}");
    expect(show("{{char}} meets {{user}}")).toBe("Ilse meets Tom");
  });

  it("the patterns are the engine's", () => {
    // Without a choice to draw, nothing tells the two apart: the same patterns, in the same order.
    const texts = [
      "",
      "Plain words.",
      "{{// a comment}}{{char}} waits for {{USER}}.",
      "<USER> and <BoT> and <cHaR> and <user >",
      "{{ char }} and {{Original}} and {{ // spaced comment }}",
      "{{//unclosed and {{char}}",
      "<uſer> is {{uſer}}",
      "{{ CHAR }}\n\n{{user}}: line\n{{// two}}{{// in a row}}",
      "Names $& and $1 stay as written: <BOT>",
      "{{{{char}}}} and <<USER>>",
    ];
    for (const text of texts) {
      for (const seed of ["", "c1", "another"]) {
        expect(describeMarkers(text, "Ilse $&", "Tom $1")).toBe(expandMacros(text, "Ilse $&", "Tom $1", seed));
      }
    }
  });

  it("unclosed markers take linear time for people too", () => {
    for (const unit of ["{{random:", "{{//"]) {
      const text = unit.repeat(Math.floor(7_000_000 / unit.length));
      const start = performance.now();
      expect(describeMarkers(text, "Serana", "Alex")).toBe(text);
      expect(performance.now() - start).toBeLessThan(2000);
    }
  });

  it("the role reminder is the one the model reads", () => {
    expect(ROLE_REMINDER).toBe("Stay in character as {{char}}. Write only {{char}}'s next turn.");
  });
});
