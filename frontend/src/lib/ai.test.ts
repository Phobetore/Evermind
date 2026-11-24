import { describe, expect, test } from "vitest";
import { translate } from "@/i18n/translate";
import type { Ai, ProbeModel } from "@/types";
import {
  type Hit,
  type Searchable,
  ageLine,
  cheapestKey,
  freeOnly,
  isNew,
  near,
  normalised,
  pages,
  priceLine,
  readsLine,
  roomFor,
  search,
  searchable,
  serviceLine,
  sortRows,
  splitName,
  successorOf,
  suggestions,
} from "./ai";

const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

const READ_AT = "2026-11-24T12:00:00Z";
const DAY = 86_400;
const readSeconds = Date.parse(READ_AT) / 1000;

function row(name: string, over: Partial<ProbeModel> = {}): ProbeModel {
  return {
    id: name.toLowerCase().replace(/\W+/g, "-"),
    name,
    vendor: null,
    created: null,
    context: { served: null, configured: null, max: null },
    max_output: null,
    price: { input: null, output: null, varies: false, cache_read: null, cache_write: null },
    reasons: null,
    ...over,
  };
}

const made = (rows: ProbeModel[], t = fr): Searchable[] => rows.map((r) => searchable(r, READ_AT, t));
const names = (hits: Hit[]) => hits.map((h) => h.row.name);

function ai(over: Partial<Ai> = {}): Ai {
  return {
    id: "m1",
    service: {
      id: "s1", name: "OpenRouter", family: "openrouter", local: false, loopback: false,
      provider: "openai-compatible", base_url: "https://openrouter.ai/api/v1", api_key_set: true, api_key_hint: "4f2a",
    },
    model: "sylve/mini",
    name: "Sylve Mini",
    is_default: false,
    context: { own: null, read: 16_384, read_kind: "served", used: 16_384, source: "read" },
    output_read: null,
    reasons: null,
    price: { read_in: null, read_out: null, own_in: null, own_out: null, varies: false },
    free: false,
    limits_read_at: null,
    reply_cap: { mode: "auto", tokens: null },
    temperature: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
    migrated: false,
    notices: [],
    conversation_count: 0,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    ...over,
  };
}

describe("pages and room", () => {
  test.each([
    [250, 1],
    [16_384, 33],
    [200_000, 400],
    [1_048_576, 2_100],
  ])("%i tokens read as %i pages", (tokens, expected) => {
    expect(pages(tokens)).toBe(expected);
  });

  test("a page is never fewer than one", () => {
    expect(pages(1)).toBe(1);
    expect(pages(0)).toBe(1);
  });

  test("the room a reply needs follows the length asked", () => {
    expect(roomFor({ reply_length: "short" })).toBe(512);
    expect(roomFor({ reply_length: "medium" })).toBe(1024);
    expect(roomFor({ reply_length: "long" })).toBe(2048);
  });
});

describe("a name cut in the middle", () => {
  test("a short name is whole", () => {
    expect(splitName("Brume 12B")).toEqual(["Brume 12B", ""]);
    expect(splitName("12345678901234")).toEqual(["12345678901234", ""]);
  });

  test("the last word, with its separator, stays at the end", () => {
    const name = "Obsidienne R1 Distill Llama 70B Instruct";
    expect(splitName(name)).toEqual(["Obsidienne R1 Distill Llama 70B", " Instruct"]);
    expect(splitName("meta-llama/llama-3.3-70b-instruct")).toEqual(["meta-llama/llama-3.3-70b", "-instruct"]);
  });

  test("a last word too long to read keeps the last 7 characters", () => {
    expect(splitName("Brume Abcdefghijklmnopqrst")).toEqual(["Brume Abcdefghijklm", "nopqrst"]);
    expect(splitName("Unbrokennamewithnospaces")).toEqual(["Unbrokennamewithn", "ospaces"]);
  });

  test("head and tail always make the name again", () => {
    for (const name of ["a b c d e f g h i j k l", "x/y:z-w_vvvvvvvvvvvvvvvvvvvv", "tail "]) {
      const [head, tail] = splitName(name);
      expect(head + tail).toBe(name);
    }
  });
});

describe("normalised", () => {
  test("accents, case and every non-letter go", () => {
    expect(normalised("Sylve 2.5")).toBe("sylve25");
    expect(normalised("sylve-2-5")).toBe("sylve25");
    expect(normalised("éCLAIR")).toBe("eclair");
  });
});

describe("near", () => {
  test("one edit, a swap of neighbours counting as one", () => {
    expect(near("osbidienne", ["obsidienne"])).toBe(true);
    expect(near("aurroe", ["aurore"])).toBe(true);
    expect(near("obsidiene", ["obsidienne"])).toBe(true);
    expect(near("auroxx", ["aurore"])).toBe(false);
  });

  test("inside one word, never across two", () => {
    expect(near("gemini", ["sylve", "mini"])).toBe(false);
    expect(near("larg", ["large"])).toBe(true);
  });
});

describe("search", () => {
  const rows = made([
    row("Eclair Mini", { vendor: "Eclair Labs" }),
    row("Mistral Large", { id: "mistralai/mistral-large-2411", vendor: "Mistral AI" }),
    row("gpt-4o", { id: "openai/gpt-4o", vendor: "OpenAI" }),
    row("Sylve 2.5", { vendor: "Sylve" }),
    row("Aurore Large", { vendor: "Aurore" }),
    row("Sillage 7B", { id: "sillage/sillage-7b", vendor: "Studio" }),
    row("Obsidienne", { vendor: "Obsidienne Labs", price: { input: 0, output: 0, varies: false, cache_read: null, cache_write: null } }),
    row("Sylve Mini"),
  ]);
  const found = (query: string) => names(search(rows, query));

  test("an empty query keeps every row, in order", () => {
    expect(found("")).toHaveLength(rows.length);
    expect(search(rows, "  ").every((h) => h.score === 0)).toBe(true);
  });

  test("case and accents do not matter", () => {
    expect(search(rows, "éCLAIR")[0]).toMatchObject({ score: 0, row: { name: "Eclair Mini" } });
  });

  test("every word must be found, in any order", () => {
    expect(found("mistral large")).toContain("Mistral Large");
    expect(found("large mistral")).toContain("Mistral Large");
    expect(found("mistral large")).not.toContain("Aurore Large");
  });

  test("a gap, a dash or none read the same", () => {
    for (const q of ["gpt4o", "gpt 4o", "gpt-4o"]) expect(found(q)).toEqual(["gpt-4o"]);
    for (const q of ["sylve 2.5", "sylve-2-5", "sylve25"]) expect(found(q)).toEqual(["Sylve 2.5"]);
  });

  test("a maker found alone scores 1, a name found scores 0", () => {
    const byMaker = made([row("Zephyr", { vendor: "Aurore" }), row("Aurore Large")]);
    expect(search(byMaker, "aurore").map((h) => [h.row.name, h.score])).toEqual([["Zephyr", 1], ["Aurore Large", 0]]);
  });

  test("a word of five letters may be a letter off, scoring 2", () => {
    expect(search(rows, "obsidiene").find((h) => h.row.name === "Obsidienne")?.score).toBe(2);
    expect(search(rows, "osbidienne").find((h) => h.row.name === "Obsidienne")?.score).toBe(2);
    expect(found("aurroe")).toContain("Aurore Large");
  });

  test("a word some row holds exactly is never read as a typo", () => {
    expect(found("large")).toEqual(["Mistral Large", "Aurore Large"]);
    expect(found("large")).not.toContain("Sillage 7B");
    expect(found("sillage")).toEqual(["Sillage 7B"]);
  });

  test("a word of three letters is never a typo", () => {
    expect(found("gtp")).toEqual([]);
  });

  test("a near match never spans two words", () => {
    expect(found("gemini")).toEqual([]);
    expect(found("xyz")).toEqual([]);
  });

  test("a tag printed on the row is found in the page's language and in English", () => {
    expect(found("gratuit")).toEqual(["Obsidienne"]);
    expect(found("free")).toEqual(["Obsidienne"]);
    const english = made([row("Brume", { reasons: true }), row("Autre")], en);
    expect(names(search(english, "thinks"))).toEqual(["Brume"]);
    expect(names(search(made([row("Brume", { reasons: true }), row("Autre")], fr), "thinks"))).toEqual(["Brume"]);
    expect(names(search(made([row("Brume", { reasons: true }), row("Autre")], fr), "réfléchit"))).toEqual(["Brume"]);
  });

  test("a new model is found by « nouveau »", () => {
    const fresh = made([row("Brume", { created: readSeconds - 3 * DAY }), row("Vieux", { created: readSeconds - 90 * DAY })]);
    expect(names(search(fresh, "nouveau"))).toEqual(["Brume"]);
    expect(names(search(fresh, "new"))).toEqual(["Brume"]);
  });
});

describe("suggestions", () => {
  const rows = made([row("Aurore Large"), row("Aurore Medium"), row("Sylve Mini")]);

  test("a name two letters off is offered, the shortest first", () => {
    expect(suggestions(rows, "aurrorre")).toEqual(["Aurore Large", "Aurore Medium"]);
    expect(suggestions(rows, "aurore lrg")).toEqual(["Aurore Large", "Aurore Medium"]);
  });

  test("a word too far from every name suggests nothing", () => {
    expect(suggestions(rows, "gemini")).toEqual([]);
    expect(suggestions(rows, "gpt")).toEqual([]);
    expect(suggestions(rows, "xyz")).toEqual([]);
  });

  test("at most three, the nearest first", () => {
    const many = made([row("Aurore Four"), row("Aurorre Three"), row("Aurore Two"), row("Aurore One")]);
    expect(suggestions(many, "aurore")).toEqual(["Aurore Two", "Aurore One", "Aurore Four"]);
  });
});

describe("sorting", () => {
  const collator = new Intl.Collator("en");
  const price = (input: number | null, output: number | null) =>
    ({ input, output, varies: false, cache_read: null, cache_write: null });
  const hit = (r: ProbeModel, score = 0): Hit => ({ row: r, score });
  const ctx = (served: number | null) => ({ served, configured: null, max: null });
  const order = (hits: Hit[], key: Parameters<typeof sortRows>[1]) => sortRows(hits, key, collator).map((r) => r.name);

  test("the service's order is kept", () => {
    expect(order([hit(row("b")), hit(row("a")), hit(row("c"))], "service")).toEqual(["b", "a", "c"]);
  });

  test("newest first, the unknown last", () => {
    const hits = [row("old", { created: 10 }), row("none"), row("new", { created: 99 })].map((r) => hit(r));
    expect(order(hits, "newest")).toEqual(["new", "old", "none"]);
  });

  test("cheapest first; as dear, the one that reads more", () => {
    const hits = [
      row("dear", { price: price(3, 15) }),
      row("cheap-small", { price: price(1, 1), context: ctx(1_000) }),
      row("cheap-big", { price: price(1, 1), context: ctx(9_000) }),
      row("unknown"),
    ].map((r) => hit(r));
    expect(order(hits, "cheapest")).toEqual(["cheap-big", "cheap-small", "dear", "unknown"]);
  });

  test("reads the most first; as much, the cheaper", () => {
    const hits = [
      row("a", { context: ctx(8_000), price: price(5, 5) }),
      row("b", { context: ctx(8_000), price: price(1, 1) }),
      row("c", { context: ctx(9_000), price: price(9, 9) }),
      row("d"),
    ].map((r) => hit(r));
    expect(order(hits, "reads")).toEqual(["c", "b", "a", "d"]);
  });

  test("what a row reads is what is served, else configured, else its maximum", () => {
    const hits = [
      row("max", { context: { served: null, configured: null, max: 5_000 } }),
      row("served", { context: { served: 7_000, configured: 1_000, max: 9_000 } }),
      row("configured", { context: { served: null, configured: 6_000, max: 9_000 } }),
    ].map((r) => hit(r));
    expect(order(hits, "reads")).toEqual(["served", "configured", "max"]);
  });

  test("by name, the language's way", () => {
    expect(order([hit(row("zèbre")), hit(row("Abeille")), hit(row("éclair"))], "name")).toEqual(["Abeille", "éclair", "zèbre"]);
  });

  test("a lower score comes before any sort", () => {
    const hits = [hit(row("a-cheap", { price: price(0.1, 0.1) }), 1), hit(row("b-dear", { price: price(9, 9) }), 0)];
    expect(order(hits, "cheapest")).toEqual(["b-dear", "a-cheap"]);
  });

  test("cheapest key weighs a message of the reference story", () => {
    expect(cheapestKey(row("x", { price: price(3, 15) }))).toBeCloseTo(3.75);
    expect(cheapestKey(row("x", { price: price(0, 0) }))).toBe(0);
    expect(cheapestKey(row("x", { price: price(null, null) }))).toBeNull();
    expect(cheapestKey(row("x", { price: price(1, null) }))).toBeNull();
    expect(cheapestKey(row("x", { price: { ...price(1, 1), varies: true } }))).toBeNull();
  });
});

describe("what a row says of itself", () => {
  test("free is a price of nothing read, not a price left out", () => {
    const zero = { input: 0, output: 0, varies: false, cache_read: null, cache_write: null };
    expect(freeOnly(row("x", { price: zero }))).toBe(true);
    expect(freeOnly(row("x", { price: { ...zero, input: 0.1 } }))).toBe(false);
    expect(freeOnly(row("x", { price: { ...zero, input: null, output: null } }))).toBe(false);
  });

  test("new is within 30 days before the read", () => {
    expect(isNew(row("x", { created: readSeconds - 29 * DAY }), READ_AT)).toBe(true);
    expect(isNew(row("x", { created: readSeconds - 31 * DAY }), READ_AT)).toBe(false);
    expect(isNew(row("x", { created: null }), READ_AT)).toBe(false);
  });

  test("the age of a list", () => {
    const at = Date.parse(READ_AT);
    expect(ageLine(READ_AT, at + 10_000, fr)).toBe("Liste lue il y a quelques secondes");
    expect(ageLine(READ_AT, at + 2 * 60_000, fr)).toBe("Liste lue il y a 2 min");
    expect(ageLine(READ_AT, at + 2 * 60_000, en)).toBe("List read 2 min ago");
  });
});

describe("the lines of an ai", () => {
  test("where its service is", () => {
    const ollama = (host: string, local: boolean, loopback: boolean) =>
      ai({ service: { ...ai().service, name: "Ollama", family: "ollama", base_url: host, local, loopback } });
    expect(serviceLine(ai(), fr)).toBe("OpenRouter, en ligne");
    expect(serviceLine(ollama("http://127.0.0.1:11434", true, true), fr)).toBe("Ollama, sur ce PC");
    expect(serviceLine(ollama("http://192.168.1.20:11434", true, false), fr)).toBe("Ollama, sur votre réseau");
    expect(serviceLine(ollama("http://192.168.1.20:11434", true, false), en)).toBe("Ollama, on your network");
  });

  test("what it reads at once", () => {
    expect(readsLine(16_384, fr)).toBe("lit ≈ 33 pages à la fois");
    expect(readsLine(1_048_576, fr)).toBe("lit ≈ 2 100 pages à la fois");
    expect(readsLine(null, fr)).toBe("capacité de lecture non dite");
  });

  test("what it costs", () => {
    const none = ai().price;
    expect(priceLine(none, true, fr)).toBe("gratuit");
    expect(priceLine({ ...none, read_in: 0, read_out: 0 }, false, fr)).toBe("gratuit");
    expect(priceLine({ ...none, read_in: 3, read_out: 15 }, false, fr)).toBe("3 $ lus, 15 $ écrits, le million de tokens");
    expect(priceLine({ ...none, read_in: 5.7, read_out: 0.075 }, false, fr)).toBe("5,70 $ lus, 0,075 $ écrits, le million de tokens");
    expect(priceLine({ ...none, read_in: 5.7, read_out: 0.075 }, false, en)).toBe("$5.70 read, $0.075 written, per million tokens");
    expect(priceLine({ ...none, own_in: 1, own_out: 2 }, false, fr)).toBe("1 $ lus, 2 $ écrits, le million de tokens");
    expect(priceLine({ ...none, read_in: 3, read_out: 15, own_in: 1, own_out: 2 }, false, fr)).toBe("1 $ lus, 2 $ écrits, le million de tokens");
    expect(priceLine({ ...none, varies: true }, false, fr)).toBe("prix selon le modèle choisi par le service");
    expect(priceLine(none, false, fr)).toBe("prix non indiqué");
    expect(priceLine({ ...none, read_in: 3 }, false, fr)).toBe("prix non indiqué");
  });
});

describe("who answers when an ai goes", () => {
  const first = ai({ id: "a", created_at: "2026-11-01T10:00:00Z" });
  const second = ai({ id: "b", created_at: "2026-11-02T10:00:00Z", is_default: true });
  const third = ai({ id: "c", created_at: "2026-11-03T10:00:00Z" });
  const all = [third, second, first];

  test("one that is not the default leaves its conversations to the default", () => {
    expect(successorOf(third, all)?.id).toBe("b");
  });

  test("the default hands on to the oldest of the others", () => {
    expect(successorOf(second, all)?.id).toBe("a");
  });

  test("the last one leaves nobody", () => {
    expect(successorOf(second, [second])).toBeNull();
  });
});
