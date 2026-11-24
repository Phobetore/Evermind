import { describe, expect, test } from "vitest";
import { SHOWN_TEXT_BOUND, cardText, firstCodePoints, namesFit, previewMacros } from "./utils";

describe("a card's text for people", () => {
  test("a card's own text is shown as its rules have it", () => {
    const text = "{{// x}}<USER> {{random:a,b}} {{char}}";
    // The old rules put in the two names and nothing else, as the engine does.
    expect(cardText(text, 1, "Ilse", "Tom")).toBe("{{// x}}<USER> {{random:a,b}} Ilse");
    expect(cardText(text, 2, "Ilse", "Tom")).toBe("Tom a / b Ilse");
  });

  test("names are not put in where they would make the text too long", () => {
    const name = "n".repeat(200);
    const timed = (run: () => void) => {
      const start = performance.now();
      run();
      expect(performance.now() - start).toBeLessThan(50);
    };

    // 400 000 characters and a name of 200 for each of 80 000 markers: 16.4 million.
    const tags = "<BOT>".repeat(80_000);
    timed(() => expect(previewMacros(tags, name, "Tom")).toBe(tags));
    timed(() => expect(cardText(tags, 2, name, "Tom")).toBe(tags));

    const markers = "{{char}}".repeat(80_000);
    timed(() => expect(cardText(markers, 1, name, "Tom")).toBe(markers));
    timed(() => expect(cardText(markers, 2, name, "Tom")).toBe(markers));

    // Each comma of a choice is shown as " / ": 6 million characters and 12 million more.
    const commas = "{{random:" + ",".repeat(6_000_000) + "}}";
    timed(() => expect(namesFit(commas, "", "")).toBe(false));
    timed(() => expect(previewMacros(commas, "", "")).toBe(commas));
    // A long run is counted to its last separator: a third of the bound in commas fits, one more not.
    const third = ",".repeat(SHOWN_TEXT_BOUND / 3);
    expect(namesFit(third, "", "")).toBe(true);
    expect(namesFit(third + ":", "", "")).toBe(false);
    // And the markers around a run still count: 62 characters, two names and sixty separators.
    const around = "<" + ",".repeat(20) + ":".repeat(20) + "<" + ",:".repeat(10);
    expect(around.length).toBe(62);
    const exact = "n".repeat((SHOWN_TEXT_BOUND - 62 - 120) / 2);
    expect(namesFit(around, exact, "Tom")).toBe(true);
    expect(namesFit(around, exact + "n", "Tom")).toBe(false);

    // An ordinary text stays far below the bound: a hundred thousand characters, ten thousand "<"
    // and ten thousand commas among them.
    const ordinary = ("<," + "x".repeat(8)).repeat(10_000);
    expect(ordinary.length).toBe(100_000);
    expect(namesFit(ordinary, name, "Tom")).toBe(true);

    // A name that holds markers is put in, and its markers after it: each marker counts for more.
    const nickname = "{{user}}".repeat(25);
    expect(nickname.length).toBe(200);
    const many = "<BOT>".repeat(70_000);
    expect(namesFit(many, nickname, name)).toBe(false);
    expect(previewMacros(many, nickname, name)).toBe(many);
    expect(cardText(many, 2, nickname, name)).toBe(many);

    expect(namesFit("<BOT> waits", "{{user}} the keeper", "Tom")).toBe(true);
    expect(previewMacros("<BOT> waits", "{{user}} the keeper", "Tom")).toBe("Tom the keeper waits");
  });

  test("the start of a text is cut between characters", () => {
    const text = "a".repeat(1_999) + "😀" + "b";
    expect(firstCodePoints(text, 2_000)).toBe("a".repeat(1_999) + "😀");

    const long = "x".repeat(15 * 1024 * 1024);
    // repeat() builds the string in pieces, which the first read joins: that is not the cut's time.
    expect(long.indexOf("y")).toBe(-1);
    const start = performance.now();
    const cut = firstCodePoints(long, 2_000);
    expect(performance.now() - start).toBeLessThan(5);
    expect([...cut]).toHaveLength(2_000);

    expect(firstCodePoints("short 😀", 2_000)).toBe("short 😀");
  });
});
