import { describe, expect, test } from "vitest";
import { BUILT_IN } from "@/engine";
import { translate } from "@/i18n/translate";
import type { Outlook, OutlookEntry, Way } from "@/types";
import { asked, isFull, lighterSaying, nameOfId, offeredWay, pagesPart, readingLine, sheetRow, wayLabel, wayName } from "./ways";

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
    // A "y" before a consonant is said as a vowel (Yves), before a vowel as a consonant (Yann).
    expect(readingLine(entry(), "Yves", fr)).toBe("Ce qu'Yves lit : ≈ 18 pages · relit 24 messages, tous ceux demandés");
    expect(readingLine(entry(), "Yvonne", fr)).toMatch(/^Ce qu'Yvonne lit/);
    expect(readingLine(entry(), "Yann", fr)).toBe("Ce que Yann lit : ≈ 18 pages · relit 24 messages, tous ceux demandés");
    expect(readingLine(entry(), "yasmine", fr)).toMatch(/^Ce que yasmine lit/);
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

  // A story of none or one message, and a prompt of about one page.
  const none = entry({ messages_total: 0, messages_included: 0, used_tokens: 400 });
  const one = entry({ messages_total: 1, messages_included: 1, used_tokens: 400 });
  test.each([
    ["en", "What Brume reads: ≈ 1 page · no message to reread yet", "What Brume reads: ≈ 1 page · rereads 1 message, all it was asked",
      "No message to reread yet", "Rereads 1 message, all it was asked"],
    ["fr", "Ce que Brume lit : ≈ 1 page · aucun message à relire pour l'instant", "Ce que Brume lit : ≈ 1 page · relit 1 message, le seul demandé",
      "Aucun message à relire pour l'instant", "Relit 1 message, le seul demandé"],
    ["de", "Was Brume liest: ≈ 1 Seite · noch keine Nachricht zu lesen", "Was Brume liest: ≈ 1 Seite · liest 1 Nachricht, mehr ist nicht verlangt",
      "Noch keine Nachricht zu lesen", "Liest 1 Nachricht erneut, mehr ist nicht verlangt"],
    ["es", "Lo que Brume lee: ≈ 1 página · aún no hay mensajes que releer", "Lo que Brume lee: ≈ 1 página · relee 1 mensaje, el único pedido",
      "Aún no hay mensajes que releer", "Relee 1 mensaje, el único pedido"],
  ] as const)("in %s says none and one message, and one page, as they are", (locale, lineNone, lineOne, aloneNone, aloneOne) => {
    const said = (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
    expect(readingLine(none, "Brume", said)).toBe(lineNone);
    expect(readingLine(one, "Brume", said)).toBe(lineOne);
    expect(readingLine(none, null, said)).toBe(aloneNone);
    expect(readingLine(one, null, said)).toBe(aloneOne);
  });

  test.each([
    ["en", "What Brume reads: ≈ 18 pages · rereads 24 messages, all it was asked", "What Small reads: ≈ 7 pages · rereads 1 of the 60 asked"],
    ["fr", "Ce que Brume lit : ≈ 18 pages · relit 24 messages, tous ceux demandés", "Ce que Small lit : ≈ 7 pages · relit 1 des 60 demandés"],
    ["de", "Was Brume liest: ≈ 18 Seiten · liest 24 Nachrichten, alle verlangten", "Was Small liest: ≈ 7 Seiten · liest 1 der 60 verlangten"],
    ["es", "Lo que Brume lee: ≈ 18 páginas · relee 24 mensajes, todos los pedidos", "Lo que Small lee: ≈ 7 páginas · relee 1 de los 60 pedidos"],
  ] as const)("in %s says more messages and pages as before, and what it rereads of what was asked", (locale, many, some) => {
    const said = (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
    expect(readingLine(entry(), "Brume", said)).toBe(many);
    expect(readingLine(entry({ history_limit: 60, messages_included: 1, used_tokens: 3_400 }), "Small", said)).toBe(some);
  });
});

describe("a way's row in a sheet", () => {
  test.each([
    ["en", "No message to reread yet", "Rereads the only message", "Rereads 3 of the 40 messages", "≈ 1 page sent", "≈ 18 pages sent"],
    ["fr", "Aucun message à relire pour l'instant", "Relit le seul message", "Relit 3 des 40 messages", "≈ 1 page envoyée", "≈ 18 pages envoyées"],
    ["de", "Noch keine Nachricht zu lesen", "Liest die einzige Nachricht", "Liest 3 der 40 Nachrichten", "≈ 1 Seite gesendet", "≈ 18 Seiten gesendet"],
    ["es", "Aún no hay mensajes que releer", "Relee el único mensaje", "Relee 3 de los 40 mensajes", "≈ 1 página enviada", "≈ 18 páginas enviadas"],
  ] as const)("in %s says none, the only one and the others, then the pages sent", (locale, nothing, only, some, page, many) => {
    const said = (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars);
    expect(sheetRow(0, 0, null, said)).toBe(nothing);
    expect(sheetRow(1, 1, null, said)).toBe(only);
    expect(sheetRow(3, 40, null, said)).toBe(some);
    expect(sheetRow(0, 0, 400, said)).toBe(`${nothing} · ${page}`);
    expect(sheetRow(1, 1, 400, said)).toBe(`${only} · ${page}`);
    expect(sheetRow(3, 40, 9_000, said)).toBe(`${some} · ${many}`);
  });

  test("a single message not reread is said as before", () => {
    expect(sheetRow(0, 1, null, en)).toBe("Rereads 0 of the 1 messages");
  });
});

describe("a count beside its noun", () => {
  test("a full capacity's line on a way's page says one message as one", () => {
    expect(fr("ways.card.fullAll", { read: 1, count: 1 })).toContain("elle relit 1 message, tout ce qui tient");
    expect(fr("ways.card.full", { read: 1, count: 1, asked: 24 })).toContain("elle relit 1 message sur les 24 demandés");
    expect(fr("ways.card.full", { read: 0, count: 0, asked: 24 })).toContain("elle relit 0 message sur les 24 demandés");
    expect(en("ways.card.fullAll", { read: 1, count: 1 })).toContain("it rereads 1 message, all that fits");
    expect(en("ways.card.fullAll", { read: 0, count: 0 })).toContain("it rereads 0 messages, all that fits");
    expect(en("ways.card.askedOnly", { count: 1 })).toBe("Rereads up to 1 message.");
  });

  test("a full capacity's chip, read aloud, says one message as one", () => {
    const full = outlook({ history_limit: 60, messages_included: 1 }).current;
    expect(wayLabel(full, en).aria).toBe("Way to play: Balanced. Its reading capacity is full: it rereads 1 message of 60. Change.");
    expect(wayLabel(full, fr).aria).toContain("elle relit 1 message sur 60");
  });

  test("a full capacity in the conversation's sheet says one page as one", () => {
    expect(en("ways.reading.full", { capacity: pagesPart(400, en), sent: pagesPart(400, en, true) }))
      .toBe("Its reading capacity is full (≈ 1 page): ≈ 1 page sent, the rest is kept for its reply.");
    expect(fr("ways.reading.full", { capacity: pagesPart(32_768, fr), sent: pagesPart(9_000, fr, true) }))
      .toBe("Sa capacité de lecture est pleine (≈ 66 pages) : ≈ 18 pages envoyées, le reste est gardé pour sa réponse.");
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
