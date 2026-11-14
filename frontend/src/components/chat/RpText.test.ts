import { LAYOUT_BOUND, layoutRefusal } from "@/lib/presentation/bounds";
import { COSTLIEST, largestLaidOut } from "@/lib/presentation/costliest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { afterEach, expect, test, vi } from "vitest";
import { rpMarkdown } from "./RpText";

afterEach(() => {
  vi.doUnmock("react-markdown");
  vi.resetModules();
});

// The elements a message was laid out with before it was measured.
const ALLOWED = ["p", "em", "strong", "code", "blockquote", "br", "ul", "ol", "li", "hr"];

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

function markup(element: ReactElement | null): string {
  if (element === null) throw new Error("not laid out");
  return renderToStaticMarkup(element);
}

/** Filled with words up to LAYOUT_BOUND characters: under the bound of the length, the cost alone
 *  can refuse it. */
function upToTheBound(text: string): string {
  let filled = text;
  while (filled.length < LAYOUT_BOUND) filled += "word ";
  return filled.slice(0, LAYOUT_BOUND);
}

test("a message is laid out as it was", () => {
  const messages = [
    "*She looks up from the lamp.* You came back.",
    "That is **not** what I said.",
    "> The sea keeps what it takes.\n> Always.",
    "- rope\n- lantern\n- bread",
    "1. Climb the stairs.\n2. Light the lamp.",
    "Write `ship` in the log.",
    "Before the storm.\n\n---\n\nAfter it.",
    "A hard  \nbreak, and a soft\none.",
    "Some <b>written</b> HTML stays <i>text</i>.",
    "A link [a](https://a.example) is unwrapped into its text.",
  ];
  for (const text of messages) {
    const before = renderToStaticMarkup(
      createElement(ReactMarkdown, { allowedElements: ALLOWED, unwrapDisallowed: true }, text),
    );
    expect(markup(rpMarkdown(text)), text).toBe(before);
  }
});

test("a message too costly to parse is shown plainly", () => {
  let runs = "x ";
  for (let n = 1; n <= 40; n++) runs += "`".repeat(n) + " ";
  const texts = [
    ">".repeat(5_000) + " x",
    "]".repeat(20_000),
    "a".repeat(LAYOUT_BOUND + 1),
    "x " + "<!-- ".repeat(2_000) + "word ".repeat(17_500),
    upToTheBound(runs),
    upToTheBound("x " + "[a](b (".repeat(400)),
  ];
  for (const text of texts) {
    const [laid, elapsed] = timed(() => rpMarkdown(text));
    expect(laid, text.slice(0, 40)).toBeNull();
    expect(elapsed, text.slice(0, 40)).toBeLessThan(50);
  }
});

test("the costliest message of each kind is laid out in time", () => {
  // The first call pays for loading the parser, which no visit pays twice.
  rpMarkdown("*warm*");
  const slow: string[] = [];
  for (const [name, kind] of Object.entries(COSTLIEST)) {
    const text = largestLaidOut(kind);
    expect(layoutRefusal(text), name).toBeNull();
    const [, elapsed] = timed(() => expect(() => rpMarkdown(text), name).not.toThrow());
    if (elapsed >= 250) slow.push(`${name}: ${Math.round(elapsed)} ms`);
  }
  expect(slow).toEqual([]);
}, 120_000);

test("deep nesting is flattened, never thrown", () => {
  const laid = markup(rpMarkdown(">".repeat(300) + " x"));
  expect(laid.split("<blockquote>").length - 1).toBeLessThanOrEqual(64);
  expect(laid).toContain("x");
});

test("a reference definition is text in a message too", () => {
  const text = "[r]: https://a.example/" + "a".repeat(16_384) + "\n\n" + "[a][r] ".repeat(200);
  const [laid, elapsed] = timed(() => markup(rpMarkdown(text)));
  expect(laid).toContain("[r]:");
  expect(laid).toContain("[a][r]");
  expect(elapsed).toBeLessThan(250);
});

test("a failure of the layout shows the text plainly", async () => {
  vi.resetModules();
  vi.doMock("react-markdown", () => ({
    default: () => {
      throw new RangeError("Maximum call stack size exceeded");
    },
  }));
  const again = await import("./RpText");
  expect(() => again.rpMarkdown("hi")).not.toThrow();
  expect(again.rpMarkdown("hi")).toBeNull();
});
