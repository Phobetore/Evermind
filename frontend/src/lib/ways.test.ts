import { describe, expect, test } from "vitest";
import { BUILT_IN } from "@/engine";
import { translate } from "@/i18n/translate";
import type { Outlook, OutlookEntry, Way } from "@/types";
import { asked, isFull, lighterSaying, nameOfId, offeredWay, readingLine, wayLabel, wayName } from "./ways";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

function way(id: string, over: Partial<Way> = {}): Way {
  return { id, name: null, built_in: id in BUILT_IN, overridden: false, ...(BUILT_IN[id] ?? BUILT_IN.balanced), ...over };
}

function entry(over: Partial<OutlookEntry> = {}): OutlookEntry {
  return {
    model_id: "m1", play_style: "balanced", used_tokens: 9_000, budget: 29_778, context_size: 32_768,
    messages_included: 24, messages_total: 200, history_limit: 24, reply_room: 1_024,
    parts: { card: 1_700, reminders: 600, history: 6_700 }, cap_short: null, ...over,
  };
}

function outlook(current: Partial<OutlookEntry> & { way?: Way & { adjusted: boolean } } = {}, ways: Outlook["ways"] = []): Outlook {
  const { way: own = { ...way("balanced"), adjusted: false }, ...rest } = current;
  return { current: { ...entry(rest), way: own }, models: [], ways };
}

describe("the way's chip", () => {
  test("the chip says adjusted, and rereads n of m when full", () => {
    expect(wayLabel(outlook().current, en)).toEqual({
      text: "Balanced", aria: "Way to play: Balanced. Change.", full: false,
    });
    const adjusted = outlook({ way: { ...way("balanced"), adjusted: true } }).current;
    expect(wayLabel(adjusted, en).text).toBe("Balanced · adjusted");
    const full = outlook({
      play_style: "immersive", way: { ...way("immersive"), adjusted: false },
      history_limit: 60, messages_included: 33,
    }).current;
    expect(wayLabel(full, en)).toEqual({
      text: "Immersive · rereads 33 of 60",
      aria: "Way to play: Immersive. Its reading capacity is full: it rereads 33 messages of 60. Change.",
      full: true,
    });
    expect(wayLabel(full, fr).text).toBe("Immersif · relit 33 sur 60");
  });

  test("a built-in and my settings are named in the interface's language", () => {
    expect(wayName(way("light"), fr)).toBe("Léger");
    expect(wayName(way("maximum"), en)).toBe("Maximum");
    expect(wayName(way("mine", { built_in: false }), fr)).toBe("Mes réglages");
    expect(wayName(way("w1", { built_in: false, name: "Long nights" }), fr)).toBe("Long nights");
    // "My settings" renamed is called what it was named.
    expect(wayName(way("mine", { built_in: false, name: "Old ones" }), fr)).toBe("Old ones");
  });

  test("asked counts the whole story when the way rereads all", () => {
    expect(asked(entry({ history_limit: 0, messages_total: 140 }))).toBe(140);
    expect(asked(entry({ history_limit: 24, messages_total: 10 }))).toBe(10);
    expect(asked(entry({ history_limit: 24, messages_total: 140 }))).toBe(24);
    expect(isFull(entry({ history_limit: 0, messages_total: 140, messages_included: 139 }))).toBe(true);
    expect(isFull(entry({ history_limit: 24, messages_total: 10, messages_included: 10 }))).toBe(false);
  });

  test("lighter saying only when light rereads more", () => {
    const light = (included: number) => ({ ...entry({ play_style: "light", messages_included: included, history_limit: 16 }), way: way("light") });
    const small = { play_style: "immersive", history_limit: 60, messages_included: 8, way: { ...way("immersive"), adjusted: false } };
    expect(lighterSaying(outlook(small, [light(14)]), en)).toBe("In Light, it would reread 14.");
    expect(lighterSaying(outlook(small, [light(14)]), fr)).toBe("En Léger, elle en relirait 14.");
    expect(lighterSaying(outlook(small, [light(8)]), en)).toBeNull();
    expect(lighterSaying(outlook(small, []), en)).toBeNull();
  });

  test("a way known by its id alone is named only when the interface names it", () => {
    expect(nameOfId("light", fr)).toBe("Léger");
    expect(nameOfId("mine", en)).toBe("My settings");
    expect(nameOfId("w1", en)).toBeNull();
  });
});

describe("the reading line", () => {
  test("says the pages sent and the messages reread, all of those asked", () => {
    expect(readingLine(entry(), "Aube", en)).toBe("What Aube reads: ≈ 18 pages · rereads 24 messages, all it was asked");
    expect(readingLine(entry({ messages_total: 10, messages_included: 10 }), "Brume", fr))
      .toBe("Ce que Brume lit : ≈ 18 pages · relit 10 messages, tous ceux demandés");
  });

  test("french elides before a vowel, the other languages say it as they always do", () => {
    expect(readingLine(entry(), "Aube", fr)).toBe("Ce qu'Aube lit : ≈ 18 pages · relit 24 messages, tous ceux demandés");
    expect(readingLine(entry(), "élan", fr)).toBe("Ce qu'élan lit : ≈ 18 pages · relit 24 messages, tous ceux demandés");
    expect(readingLine(entry(), "Aube", (key, vars) => translate("de", key, vars))).toBe("Was Aube liest: ≈ 18 Seiten · liest 24 Nachrichten, alle verlangten");
  });

  test("a full capacity says what it rereads of what was asked", () => {
    const full = entry({ history_limit: 60, messages_included: 33, used_tokens: 3_400 });
    expect(readingLine(full, "Obsidienne", fr)).toBe("Ce qu'Obsidienne lit : ≈ 7 pages · relit 33 des 60 demandés");
    expect(readingLine(full, "Small", en)).toBe("What Small reads: ≈ 7 pages · rereads 33 of the 60 asked");
  });

  test("with no ai or no size said, the messages alone", () => {
    expect(readingLine(entry(), null, en)).toBe("Rereads 24 messages, all it was asked");
    expect(readingLine(entry({ history_limit: 60, messages_included: 33 }), null, fr)).toBe("Relit 33 des 60 demandés");
  });
});

describe("the way offered", () => {
  test("is the default's figures, and balanced's when the list lacks it", () => {
    const listed = (id: string, over: Partial<Way> = {}) => ({ ...way(id, over), conversations: 0 });
    const ways = [listed("balanced"), listed("immersive", { history_limit: 80, overridden: true })];
    expect(offeredWay({ default: "immersive", passages_available: false, ways }).history_limit).toBe(80);
    expect(offeredWay({ default: "gone", passages_available: false, ways: [] })).toEqual(BUILT_IN.balanced);
  });
});
