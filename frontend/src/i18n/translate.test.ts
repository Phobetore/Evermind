import { describe, expect, it } from "vitest";
import { translate } from "./translate";

describe("a count", () => {
  it.each([
    ["en", "1 message", "2 messages"],
    ["fr", "1 message", "2 messages"],
    ["de", "1 Nachricht", "2 Nachrichten"],
    ["es", "1 mensaje", "2 mensajes"],
  ] as const)("in %s takes the form its number takes", (locale, one, two) => {
    expect(translate(locale, "chatList.messageCount", { count: 1 })).toBe(one);
    expect(translate(locale, "chatList.messageCount", { count: 2 })).toBe(two);
  });

  it("of none is singular in French only, as the language has it", () => {
    expect(translate("fr", "chatList.messageCount", { count: 0 })).toBe("0 message");
    expect(translate("en", "chatList.messageCount", { count: 0 })).toBe("0 messages");
  });

  it("with no form of its own keeps the sentence there is", () => {
    expect(translate("en", "time.minutesAgo", { count: 1 })).toBe("1 min ago");
  });
});

describe("a number", () => {
  it.each([
    ["en", "54.1 t/s · first token in 0.23s", "19%"],
    ["fr", "54,1 t/s · 1er token en 0,23\u202fs", "19\u00a0%"],
    ["de", "54,1 T/s · erstes Token in 0,23\u00a0s", "19\u00a0%"],
    ["es", "54,1 t/s · primer token en 0,23\u00a0s", "19\u00a0%"],
  ] as const)("is written in %s as the language writes it", (locale, speed, share) => {
    expect(translate(locale, "connections.benchmarkResult", { tokensPerSecond: 54.1, firstTokenSeconds: 0.23 }))
      .toBe(speed);
    expect(translate(locale, "chat.context.percent", { pct: 19 })).toBe(share);
  });

  it.each([
    ["en", "about 31,000 tokens"],
    ["fr", "environ 31 000 tokens"],
    ["de", "etwa 31.000 Tokens"],
    ["es", "unos 31.000 tokens"],
  ] as const)("asked for grouped is grouped in %s, where a plain one is not", (locale, said) => {
    expect(translate(locale, "errors.briefTooLong", { needed: 31000, context: 16384 })).toContain(said);
    expect(translate(locale, "chatList.messageCount", { count: 16384 })).toContain("16384");
  });

  it.each([
    ["en", "Lorebook: 12,000 entries", "the last 12,000 messages", "with the lorebook"],
    ["fr", "Lorebook : 12 000 entrées", "les 12 000 derniers messages", "avec le lorebook"],
    ["de", "Lorebook: 12.000 Einträge", "den letzten 12.000 Nachrichten", "mit dem Lorebook"],
    ["es", "Lorebook: 12.000 entradas", "los últimos 12.000 mensajes", "con el lorebook"],
  ] as const)("on a card's page, of entries and of messages is grouped in %s, and the lorebook is named so", (locale, lore, note, hint) => {
    expect(translate(locale, "characters.detail.lore", { count: 12000 })).toBe(lore);
    expect(translate(locale, "characters.detail.characterNote", { count: 12000 })).toContain(note);
    expect(translate(locale, "characters.detail.modelReadsHint")).toContain(hint);
  });

  it.each([
    ["en", "Lorebook: 1,500 entries", "12,000 lorebook entries"],
    ["fr", "1 500", "12 000 entrées"],
    ["de", "Lorebook: 1.500 Einträge", "12.000 Lorebook-Einträge"],
    // Spanish groups a number of four digits only from five: "1500", "12.000".
    ["es", "Lorebook: 1500 entradas", "12.000 entradas del lorebook"],
  ] as const)("of a card's entries is grouped in %s", (locale, report, banner) => {
    expect(translate(locale, "cards.report.lore", { count: 1500 })).toContain(report);
    expect(translate(locale, "characters.reread.lore", { count: 12000 })).toContain(banner);
  });

  it.each(["fr", "de", "es"] as const)("written into a sentence in %s has its decimal comma", (locale) => {
    expect(translate(locale, "connections.temperatureHint")).toMatch(/\b0,8\b/);
  });
});

describe("a price", () => {
  const price = { input: 5.7, output: 0.075 };
  it.each([
    ["en", "$5.70 read, $0.075 written, per million tokens"],
    ["fr", "5,70 $ lus, 0,075 $ écrits, le million de tokens"],
    ["de", "5,70 $ gelesen, 0,075 $ geschrieben, pro Million Tokens"],
    ["es", "5,70 $ leídos, 0,075 $ escritos, por millón de tokens"],
  ] as const)("keeps its cents and its small figures in %s", (locale, sentence) => {
    expect(translate(locale, "ai.priceKnown", price)).toBe(sentence);
  });

  it("that rounds to nothing is not written as nothing", () => {
    expect(translate("en", "ai.priceKnown", { input: 0.00001, output: 3 })).toBe("$0.00001 read, $3 written, per million tokens");
    expect(translate("fr", "ai.priceKnown", { input: 0.0000001, output: 3 })).toContain("0,0000001 $ lus");
  });

  it("is written whole when it is", () => {
    expect(translate("fr", "ai.priceKnown", { input: 3, output: 15 })).toBe("3 $ lus, 15 $ écrits, le million de tokens");
  });
});
