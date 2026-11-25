import { describe, expect, test } from "vitest";
import { BUILT_IN } from "@/engine";
import { translate } from "@/i18n/translate";
import type { Ai, ProbeModel } from "@/types";
import { cheapestKey, estimateOf, estimateText, readerOfAi, readerOfRow, readingOf } from "./estimate";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

const balanced = BUILT_IN.balanced;

/** Brume 12B as the mockup has it: 32,768 tokens read at once, 0.20 / 0.60 read from the
 *  service, it does not reason, its ceiling left to Evermind, and nothing measured yet. */
function brume(over: Partial<Ai> = {}): Ai {
  return {
    id: "m1",
    service: {
      id: "s1", name: "OpenRouter", family: "openrouter", local: false, loopback: false,
      provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key_set: true, api_key_hint: "4f2a",
    },
    model: "brume/12b",
    name: "Brume 12B",
    is_default: true,
    context: { own: null, read: 32_768, read_kind: "served", used: 32_768, source: "read" },
    output_read: null,
    reasons: false,
    price: { read_in: 0.2, read_out: 0.6, own_in: null, own_out: null, varies: false },
    free: false,
    limits_read_at: null,
    reply_cap: { mode: "auto", tokens: null },
    temperature: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
    migrated: false,
    notices: [],
    // max(200, 6 % of 32,768): nothing measured yet.
    margin: 1966,
    token_ratio: null,
    reply_tokens: { short: null, medium: null, long: null },
    thinking_allowance: 3072,
    thinking_measured: false,
    usage_seen: null,
    anthropic: false,
    conversation_count: 0,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...over,
  };
}

function row(over: Partial<ProbeModel> = {}): ProbeModel {
  return {
    id: "vendor/model",
    name: "Model",
    vendor: null,
    created: null,
    context: { served: 32_768, configured: null, max: null },
    max_output: null,
    price: { input: 0.2, output: 0.6, varies: false, cache_read: null, cache_write: null },
    reasons: false,
    ...over,
  };
}

describe("what an ai reads of the reference story, and what 100 messages cost", () => {
  test("balanced on brume 12b is the mockup's figure", () => {
    const reading = readingOf(readerOfAi(brume()), balanced);
    // The reply's room: balanced keeps 1,024, which an auto ceiling keeps as it is.
    // budget = 32,768 - 1,024 - 1,966 = 29,778, at a ratio of 1.
    expect(reading.budget).toBe(29_778);
    // The reminders at that budget: facts max(700, 12 % = 3,573) capped at 2,000, lorebook 800,
    // passages 1,500.
    expect(reading.parts.reminders).toBe(4_300);
    // 1,700 for the card, the reminders, 24 messages of 280: 12,720, under the budget.
    expect(reading.used).toBe(12_720);
    expect(reading.parts).toEqual({ card: 1_700, reminders: 4_300, history: 6_720, room: 1_024 });
    // (29,778 - 1,700 - 4,300) / 280 = 84, at most the 24 the way asks for.
    expect(reading.reread).toBe(24);
    expect(reading.asked).toBe(24);
    expect(reading.full).toBe(false);
    // 12,720 / 500 = 25.4 pages.
    expect(reading.pages).toBe(25);

    // A message: 12,720 read at 0.20, 450 written at 0.60 (balanced's medium reply), per million:
    // 2,544 + 270 = 2,814, so 0.2814 for 100 messages.
    const estimate = estimateOf(readerOfAi(brume()), balanced);
    expect(estimate.kind).toBe("amount");
    if (estimate.kind !== "amount") return;
    expect(estimate.per100).toBeCloseTo(0.2814, 10);
    expect(estimate.fuller).toBeNull();
    expect(estimateText(estimate, "en", en)).toBe("≈ $0.28 per 100 messages");
    expect(estimateText(estimate, "fr", fr)).toBe("≈ 0,28 $ les 100 messages");
  });

  test("a model that reasons and has not answered yet gives a floor and a fuller figure", () => {
    const ai = brume({ reasons: true });
    // Its thinking comes out of the reply's room: 1,024 + 3,072 kept, so the budget is 26,706,
    // still above the 12,720 the story takes.
    expect(readingOf(readerOfAi(ai), balanced).budget).toBe(26_706);
    const estimate = estimateOf(readerOfAi(ai), balanced);
    if (estimate.kind !== "amount") throw new Error(estimate.kind);
    expect(estimate.per100).toBeCloseTo(0.2814, 10);
    // 3,072 tokens of thinking at 0.60: 0.18432 more for 100 messages.
    expect(estimate.fuller).toBeCloseTo(0.46572, 10);
    expect(estimateText(estimate, "en", en)).toBe("at least $0.28 per 100 messages (≈ $0.47 with its thinking)");
  });

  test("a measured reply length replaces the guess", () => {
    const ai = brume({ reasons: true, thinking_measured: true, reply_tokens: { short: null, medium: 300, long: null } });
    const estimate = estimateOf(readerOfAi(ai), balanced);
    if (estimate.kind !== "amount") throw new Error(estimate.kind);
    // 12,720 at 0.20 and 300 at 0.60: 2,724 a message. Its thinking is in what was measured.
    expect(estimate.per100).toBeCloseTo(0.2724, 10);
    expect(estimate.fuller).toBeNull();
  });

  test("maximum fills the budget", () => {
    const reading = readingOf(readerOfAi(brume()), BUILT_IN.maximum);
    // 32,768 - 2,048 - 1,966.
    expect(reading.budget).toBe(28_754);
    expect(reading.used).toBe(reading.budget);
    expect(reading.asked).toBeNull();
    expect(reading.full).toBe(true);
    // Facts 3,450, lorebook 1,600, passages 2,875: (28,754 - 1,700 - 7,925) / 280.
    expect(reading.reread).toBe(68);
  });

  test("a small window is full and says how many it rereads", () => {
    const ai = brume({ context: { own: null, read: 8_192, read_kind: "served", used: 8_192, source: "read" }, margin: 491 });
    const reading = readingOf(readerOfAi(ai), BUILT_IN.immersive);
    // 8,192 - 2,048 - 491 = 5,653; reminders 700 + 339 + 565; (5,653 - 1,700 - 1,604) / 280 = 8.
    expect(reading.budget).toBe(5_653);
    expect(reading.used).toBe(5_653);
    expect(reading.reread).toBe(8);
    expect(reading.asked).toBe(60);
    expect(reading.full).toBe(true);
  });

  test("a measured ratio counts in the server's tokens", () => {
    const ai = brume({ token_ratio: 1.25, margin: 983 });
    const reading = readingOf(readerOfAi(ai), balanced);
    // (32,768 - 1,024 - 983) / 1.25 = 24,608.8, in the engine's own tokens.
    expect(reading.budget).toBe(24_608);
    expect(reading.used).toBe(12_720);
    expect(reading.parts).toEqual({ card: 2_125, reminders: 5_375, history: 8_400, room: 1_024 });
    // 15,900 of the server's tokens.
    expect(reading.pages).toBe(32);
    const estimate = estimateOf(readerOfAi(ai), balanced);
    if (estimate.kind !== "amount") throw new Error(estimate.kind);
    expect(estimate.per100).toBeCloseTo(0.345, 10);
  });

  test("free, no price, a price that varies", () => {
    const free = estimateOf(readerOfAi(brume({ free: true })), balanced);
    expect(free).toEqual({ kind: "free" });
    expect(estimateText(free, "en", en)).toBe(en("ai.free"));
    const none = estimateOf(readerOfAi(brume({ price: { read_in: null, read_out: 0.6, own_in: null, own_out: null, varies: false } })), balanced);
    expect(none).toEqual({ kind: "none" });
    expect(estimateText(none, "en", en)).toBe(en("ai.priceNone"));
    const varies = estimateOf(readerOfAi(brume({ price: { read_in: null, read_out: null, own_in: null, own_out: null, varies: true } })), balanced);
    expect(varies).toEqual({ kind: "varies" });
    expect(estimateText(varies, "en", en)).toBe(en("ai.priceVaries"));
    // Read as nothing and nothing, as the price line says it.
    const zero = brume({ price: { read_in: 0, read_out: 0, own_in: null, own_out: null, varies: false } });
    expect(estimateOf(readerOfAi(zero), balanced)).toEqual({ kind: "free" });
  });

  test("under a cent, less than a cent", () => {
    const cheap = brume({ price: { read_in: 0.0001, read_out: 0.0001, own_in: null, own_out: null, varies: false } });
    const estimate = estimateOf(readerOfAi(cheap), balanced);
    expect(estimateText(estimate, "en", en)).toBe("less than $0.01 per 100 messages");
  });

  test("at least under a cent, with its thinking above", () => {
    const cheap = brume({ reasons: true, price: { read_in: 0.001, read_out: 0.1, own_in: null, own_out: null, varies: false } });
    const estimate = estimateOf(readerOfAi(cheap), balanced);
    if (estimate.kind !== "amount") throw new Error(estimate.kind);
    // 12,720 at 0.001 and 450 at 0.1: 57.72 a message, 0.005772 for 100; its 3,072 of thinking
    // at 0.1 add 0.03072, so 0.036492 with them: over a cent, both figures are said.
    expect(estimate.per100).toBeCloseTo(0.005772, 10);
    expect(estimate.fuller).toBeCloseTo(0.036492, 10);
    expect(estimateText(estimate, "en", en)).toBe("at least $0.0058 per 100 messages (≈ $0.036 with its thinking)");
  });

  test("an anthropic ai keeps what anthropic is sent", () => {
    const anthropic = (over: Partial<Ai>) => brume({
      service: { ...brume().service, family: "anthropic", provider: "anthropic" },
      anthropic: true,
      ...over,
    });
    // Balanced's 1,024 is raised to Anthropic's floor: 32,768 - 4,096 - 1,966.
    const balancedRead = readingOf(readerOfAi(anthropic({})), balanced);
    expect(balancedRead.budget).toBe(26_706);
    expect(balancedRead.parts.room).toBe(4_096);
    // A room left open: 4,096 is sent and kept, where another AI of 8,192 would keep a quarter,
    // 2,048. 8,192 - 4,096 - 491 = 3,605.
    const small = { context: { own: null, read: 8_192, read_kind: "served" as const, used: 8_192, source: "read" as const }, margin: 491 };
    const open = { ...balanced, reply_room: null };
    expect(readingOf(readerOfAi(anthropic(small)), open).budget).toBe(3_605);
    expect(readingOf(readerOfAi(brume(small)), open).budget).toBe(5_653);
  });

  test("a measured thinking keeps its own room", () => {
    const ai = brume({ reasons: true, thinking_measured: true, thinking_allowance: 1_500, margin: 983 });
    const reading = readingOf(readerOfAi(ai), balanced);
    // 1,024 for the reply and the 1,500 it was measured to think: 32,768 - 2,524 - 983.
    expect(reading.parts.room).toBe(2_524);
    expect(reading.budget).toBe(29_261);
  });

  test("a window under what the card and the reminders take rereads nothing", () => {
    const window = (used: number) => brume({ context: { own: null, read: used, read_kind: "served", used, source: "read" }, margin: 200 });
    const reading = readingOf(readerOfAi(window(2_048)), BUILT_IN.immersive);
    // Immersive's room, at most half the window: 1,024. 2,048 - 1,024 - 200 = 824; the reminders
    // at 824: facts 700, lorebook 6 % = 49, passages 10 % = 82, 831 in all, over what is left.
    expect(reading.budget).toBe(824);
    expect(reading.reread).toBe(0);
    expect(reading.used).toBe(824);
    // The card takes all there is; the reminders and the story, nothing.
    expect(reading.parts).toEqual({ card: 824, reminders: 0, history: 0, room: 1_024 });
    expect(reading.full).toBe(true);
    expect(reading.pages).toBe(2);
    // 1,024 - 512 - 200 = 312: the engine still gives a prompt its floor.
    const tiny = readingOf(readerOfAi(window(1_024)), BUILT_IN.immersive);
    expect(tiny.budget).toBe(512);
    expect(tiny.parts).toEqual({ card: 512, reminders: 0, history: 0, room: 512 });
  });

  test("the price shown is the price used", () => {
    const typed = brume({ price: { read_in: 0.2, read_out: 0.6, own_in: 1, own_out: 2, varies: false } });
    const estimate = estimateOf(readerOfAi(typed), balanced);
    if (estimate.kind !== "amount") throw new Error(estimate.kind);
    // 12,720 at 1 and 450 at 2: 13,620 a message.
    expect(estimate.per100).toBeCloseTo(1.362, 10);
    expect(estimateText(estimate, "en", en)).toBe("≈ $1.40 per 100 messages");
  });
});

describe("a model not added yet", () => {
  test("reads what its line says, and is counted as nothing measured", () => {
    expect(readingOf(readerOfRow(row(), "openrouter"), balanced).budget).toBe(29_778);
    // Nothing said of its size: what Evermind assumes, 16,384, with a margin of 983.
    const untold = row({ context: { served: null, configured: null, max: null } });
    expect(readingOf(readerOfRow(untold, "openrouter"), balanced).budget).toBe(16_384 - 1_024 - 983);
    const most = row({ context: { served: null, configured: null, max: 8_192 } });
    expect(readingOf(readerOfRow(most, "openrouter"), balanced).budget).toBe(8_192 - 1_024 - 491);
    // A size set on the server comes before the most the model can read: 12,000, a margin of 720.
    const configured = row({ context: { served: null, configured: 12_000, max: 32_768 } });
    expect(readingOf(readerOfRow(configured, "openrouter"), balanced).budget).toBe(12_000 - 1_024 - 720);
  });

  test("a row keeps no more than it writes, and anthropic's floor", () => {
    // It writes 600 at most: 600 kept of balanced's 1,024. 32,768 - 600 - 1,966.
    const short = readingOf(readerOfRow(row({ max_output: 600 }), "openrouter"), balanced);
    expect(short.parts.room).toBe(600);
    expect(short.budget).toBe(30_202);
    // On Anthropic, 4,096: 32,768 - 4,096 - 1,966.
    const anthropic = readingOf(readerOfRow(row(), "anthropic"), balanced);
    expect(anthropic.parts.room).toBe(4_096);
    expect(anthropic.budget).toBe(26_706);
  });

  test("cheapest weighs each row under the way it is given", () => {
    // Under balanced, both read the same 12,720: the cheaper to read comes first.
    const wide = row({ id: "wide", context: { served: 131_072, configured: null, max: null } });
    const dear = row({ id: "dear", price: { input: 0.3, output: 0.6, varies: false, cache_read: null, cache_write: null } });
    expect(cheapestKey(wide, "openrouter", balanced)).toBeCloseTo(0.2814, 10);
    expect(cheapestKey(dear, "openrouter", balanced)).toBeCloseTo(0.4086, 10);
    // Under maximum, each fills its budget: 131,072 - 2,048 - 7,864 = 121,160 at 0.20 and 1,100
    // at 0.60 is 2.4892; 32,768 - 2,048 - 1,966 = 28,754 at 0.30 and 1,100 at 0.60 is 0.92862.
    expect(cheapestKey(wide, "openrouter", BUILT_IN.maximum)).toBeCloseTo(2.4892, 10);
    expect(cheapestKey(dear, "openrouter", BUILT_IN.maximum)).toBeCloseTo(0.92862, 10);
  });

  test("cheapest ranks a thinking row on its fuller figure", () => {
    const thinking = row({ reasons: true });
    // Dearer to read, but it does not think: 0.4086 against 0.2814 at least, 0.4657 with thinking.
    const plain = row({ price: { input: 0.3, output: 0.6, varies: false, cache_read: null, cache_write: null } });
    const thinkingKey = cheapestKey(thinking, "openrouter", balanced) as number;
    const plainKey = cheapestKey(plain, "openrouter", balanced) as number;
    expect(thinkingKey).toBeCloseTo(0.46572, 10);
    expect(plainKey).toBeCloseTo(0.4086, 10);
    expect(plainKey).toBeLessThan(thinkingKey);
  });
});
