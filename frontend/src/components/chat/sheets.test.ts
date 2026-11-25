import { createElement } from "react";
import { describe, expect, test } from "vitest";
import { AiSheet } from "./AiSheet";
import { aiOf, conversationOf, drawn, outlookOf, words } from "./sheets.fixture";
import { WaySheet } from "./WaySheet";

const none = () => {};

function aiSheet(props: Partial<Parameters<typeof AiSheet>[0]> & { ais: Parameters<typeof AiSheet>[0]["ais"] }) {
  return drawn(createElement(AiSheet, {
    conversation: conversationOf(), outlook: outlookOf(props.ais),
    onPick: none, onGone: none, onAddOther: none, onClose: none, onCapLifted: none, ...props,
  }));
}

function waySheet(props: Partial<Parameters<typeof WaySheet>[0]> & { ais: Parameters<typeof WaySheet>[0]["ais"] }) {
  return drawn(createElement(WaySheet, {
    conversation: conversationOf(), outlook: outlookOf(props.ais ?? []),
    onPicked: none, onClose: none, onLetEvermind: none, ...props,
  }));
}

const count = (html: string, said: string) => words(html).split(said).length - 1;

describe("per 100 messages, in a conversation's two sheets", () => {
  test("is said to be of a long story once, under the list, where a row shows an estimate", () => {
    const priced = [aiOf(), aiOf({ id: "m2", name: "Aube" })];
    const ais = aiSheet({ ais: priced });
    expect(count(ais, "On a long story.")).toBe(1);
    // Under the rows: after the last row's estimate.
    const text = words(ais);
    expect(text.indexOf("On a long story.")).toBeGreaterThan(text.lastIndexOf("per 100 messages"));
    const ways = waySheet({ ais: priced });
    expect(count(ways, "On a long story.")).toBe(1);
    expect(words(ways).indexOf("On a long story.")).toBeGreaterThan(words(ways).lastIndexOf("per 100 messages"));
  });

  test("is not said where no row shows one", () => {
    const free = [aiOf({ free: true, price: { read_in: 0, read_out: 0, own_in: null, own_out: null, varies: false } })];
    expect(count(aiSheet({ ais: free }), "On a long story.")).toBe(0);
    expect(count(waySheet({ ais: free }), "On a long story.")).toBe(0);
    // Before the figures come, the AIs' rows show none.
    expect(count(aiSheet({ ais: [aiOf()], outlook: null }), "On a long story.")).toBe(0);
    // An edition with no AIs of its own prices nothing.
    expect(count(waySheet({ ais: null }), "On a long story.")).toBe(0);
  });
});

describe("the AIs' sheet while its figures are on their way", () => {
  const ais = [aiOf(), aiOf({ id: "m2", name: "Aube" })];
  /** The rows drawn: one button for each AI, named first by it. */
  const rows = (html: string) => ais.filter((ai) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${ai.name}`, "s").test(html)).length;

  test("draws no row, the spinner in their place, as the ways' sheet does", () => {
    const html = aiSheet({ ais, outlook: null, waiting: true });
    expect(rows(html)).toBe(0);
    expect(html).toMatch(/aria-busy="true"[^>]*>\s*<svg[^>]*animate-spin/);
    // What leads elsewhere stays in reach.
    expect(words(html)).toContain("Other model…");
  });

  test("draws its rows once, with their figures when they came, without when they could not be read", () => {
    const came = aiSheet({ ais, waiting: false });
    expect(rows(came)).toBe(2);
    expect(words(came)).toContain("per 100 messages");
    const failed = aiSheet({ ais, outlook: null, waiting: false });
    expect(rows(failed)).toBe(2);
    expect(words(failed)).not.toContain("per 100 messages");
  });

  test("not told it waits, it draws its rows at once, as before", () => {
    expect(rows(aiSheet({ ais, outlook: null }))).toBe(2);
  });
});
