import { expect, test } from "vitest";
import { NAMED_COLORS, cleanDeclarations, cleanStyle, colorAlpha } from "./style";
import { expectWithin } from "./timedBudget";

test("the fixed corner picture of a real card keeps only what stays in its box", () => {
  // The overlay of https://chub.ai/characters/Alpacalotta/josephine-87e86c62.
  expect(
    cleanStyle(
      "position: fixed; bottom: 0px; right: 5px; width: auto; height: 35%; z-index: 99; pointer-events: none;",
    ),
  ).toBe("width: auto");
});

test("the colours and centring a rich-text editor writes are kept", () => {
  expect(cleanStyle("color: rgb(227, 0, 83)")).toBe("color: rgb(227, 0, 83)");
  expect(cleanStyle("width: 100%; height: auto; cursor: pointer; margin: 0px auto;")).toBe(
    "width: 100%; margin: 0px auto",
  );
});

test("a margin below zero, a transform, a position or a layer is dropped", () => {
  for (const style of [
    "margin: -10px",
    "margin-left: -1px",
    "padding: 4px -2px",
    "transform: translate(10px)",
    "position: absolute",
    "z-index: 10",
    "inset: 0",
    "top: 0",
  ])
    expect(cleanStyle(style)).toBe("");
});

test("a value that loads, escapes or computes is dropped", () => {
  for (const style of [
    "background: url(https://x.example/a.png)",
    "width: expression(alert(1))",
    "color: \\72 ed",
    "color: @import",
    "color: var(--x)",
    "margin: calc(0px - 50px)",
    "color: red !important",
    "color: red /* */",
    "width: env(safe-area-inset-left)",
    "color: <b>",
  ])
    expect(cleanStyle(style)).toBe("");
});

test("sizes and opacity stay within their bounds", () => {
  for (const style of [
    "font-size: 50px",
    "font-size: larger",
    "font-size: smaller",
    "opacity: 0.1",
    "width: 120%",
    "color: transparent",
    "line-height: 0.5",
    "margin: 5%",
    "padding: 10%",
    "border: 20px solid red",
  ])
    expect(cleanStyle(style)).toBe("");
  expect(cleanStyle("font-size: 1.5em")).toBe("font-size: 24px");
  expect(cleanStyle("font-size: 150%")).toBe("font-size: 24px");
  expect(cleanStyle("margin: 2em auto")).toBe("margin: 32px auto");
  expect(cleanStyle("margin: 5em")).toBe("");
  expect(cleanStyle("opacity: 0.5")).toBe("opacity: 0.5");
  expect(cleanStyle("width: 100%")).toBe("width: 100%");
  expect(cleanStyle("width: 2000px")).toBe("width: 2000px");
  expect(cleanStyle("border: 2px solid red")).toBe("border: 2px solid red");
});

test("a line height follows its own font size", () => {
  expect(cleanStyle("line-height: 1.4")).toBe("line-height: 1.4");
  expect(cleanStyle("line-height: normal")).toBe("line-height: normal");
  expect(cleanStyle("line-height: 16px")).toBe("");
  expect(cleanStyle("line-height: 100%")).toBe("");
  expect(cleanStyle("line-height: 1.5em")).toBe("");
});

test("a colour too faint to read is dropped", () => {
  const dropped: Array<[string, number]> = [
    ["#0000", 0],
    ["#fff0", 0],
    ["#ffffff00", 0],
    ["#ffffff4c", 0x4c / 255],
    ["rgba(0,0,0,0)", 0],
    ["RGBA(0,0,0,0)", 0],
    ["HSLA(0,0%,0%,0.02)", 0.02],
    ["rgba(0, 0, 0, 0.29)", 0.29],
    ["hsla(0,0%,0%,0.02)", 0.02],
    ["rgb(0 0 0 / 0)", 0],
    ["rgb(0 0 0 / 0.2)", 0.2],
  ];
  for (const [color, alpha] of dropped) {
    expect(cleanStyle("color: " + color)).toBe("");
    expect(colorAlpha(color.toLowerCase())).toBeCloseTo(alpha, 5);
  }
  const kept: Array<[string, string, number]> = [
    ["#ffffff4d", "#ffffff4d", 0x4d / 255],
    ["rgba(0,0,0,0.3)", "rgba(0,0,0,0.3)", 0.3],
    ["rgb(0 0 0 / 0.5)", "rgb(0 0 0 / 0.5)", 0.5],
    ["#fff", "#fff", 1],
    ["red", "red", 1],
    ["RED", "red", 1],
  ];
  for (const [color, written, alpha] of kept) {
    expect(cleanStyle("color: " + color)).toBe("color: " + written);
    expect(colorAlpha(written)).toBeCloseTo(alpha, 5);
  }
  expect(cleanStyle("background-color: rgba(0,0,0,0)")).toBe("background-color: rgba(0,0,0,0)");
});

test("a colour the browser would throw away is dropped", () => {
  for (const color of [
    "foo",
    "rgb(1,2)",
    "rgb(1 2 3 4)",
    "hsl(deg)",
    "rgb(255, 50%, 0)",
    "rgba(1, 2, 3, 4, 5)",
    "canvastext",
    "revert-layer",
    "rgb(10% 20 30)",
    "rgb(1 2 3 / 50%)",
    "hsl(120deg 50% 50%)",
  ])
    expect(cleanStyle("color: " + color)).toBe("");
  for (const [color, written] of [
    ["rebeccapurple", "rebeccapurple"],
    ["GreY", "grey"],
    ["#abcd", "#abcd"],
    ["rgba(1,2,3)", "rgba(1,2,3)"],
    ["rgb(1 2 3 / 0.5)", "rgb(1 2 3 / 0.5)"],
    ["rgb(10% 20% 30%)", "rgb(10% 20% 30%)"],
    ["hsl(120 50% 50%)", "hsl(120 50% 50%)"],
    ["hsla(120, 50%, 50%, 0.5)", "hsla(120, 50%, 50%, 0.5)"],
    ["inherit", "inherit"],
  ])
    expect(cleanStyle("color: " + color)).toBe("color: " + written);
  expect(cleanStyle("background-color: foo")).toBe("");
  expect(cleanStyle("color: red; color: blue")).toBe("color: blue");
  expect(cleanStyle("color: rgba(0,0,0,0.3); color: foo")).toBe("color: rgba(0,0,0,0.3)");
  expect(cleanStyle("max-width: auto")).toBe("");
  expect(cleanStyle("width: auto")).toBe("width: auto");
  // The 148 names of CSS Color 4, transparent and currentcolor.
  expect(NAMED_COLORS.size).toBe(150);
});

test("a shadow may lean up or left, within its bounds", () => {
  expect(cleanStyle("text-shadow: -2px -2px 0 #000")).toBe("text-shadow: -2px -2px 0px #000");
  expect(cleanStyle("text-shadow: -5px 0 0 #000")).toBe("");
  expect(cleanStyle("margin: -1px")).toBe("");
});

test("a style that cannot be read keeps nothing", () => {
  expect(() => cleanStyle("color: ; ;;: x")).not.toThrow();
  expect(cleanStyle("color: ; ;;: x")).toBe("");
  expect(cleanDeclarations("color: ; ;;: x")).toEqual([]);
});

test("a style is read in linear time, whatever its blanks and comments", () => {
  for (const blank of [" ", "\t", "\n"]) {
    const style = "color:red" + blank.repeat(99_900) + "x";
    style.charCodeAt(0);
    const start = performance.now();
    cleanDeclarations(style);
    expectWithin(performance.now() - start, 50, "count", JSON.stringify(blank));
  }
  const comments = "color:" + "/*a".repeat(30_000);
  comments.charCodeAt(0);
  const start = performance.now();
  expect(cleanDeclarations(comments)).toEqual([]);
  expectWithin(performance.now() - start, 50, "count", "comments");

  // Blanks inside a value are one blank, as CSS reads them; a comment closed stays a comment.
  expect(cleanStyle("margin:\n  4px\t\t 8px ;  color :  red")).toBe("margin: 4px 8px; color: red");
  expect(cleanStyle("color: red; /* note */ font-weight: bold")).toBe("color: red; font-weight: bold");
});
