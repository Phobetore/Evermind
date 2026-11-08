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
