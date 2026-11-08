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

  it.each(["fr", "de", "es"] as const)("written into a sentence in %s has its decimal comma", (locale) => {
    expect(translate(locale, "connections.temperatureHint")).toMatch(/\b0,8\b/);
  });
});
