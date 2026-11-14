import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Mark, maskId, SPARK, sparkPath } from "./Mark";

const frontend = fileURLToPath(new URL("../../..", import.meta.url));

function draw(...marks: Parameters<typeof Mark>[0][]) {
  return renderToStaticMarkup(createElement(Fragment, null, ...marks.map((props, i) => createElement(Mark, { key: i, ...props }))));
}

// The openings are cut by a <mask> found by its id: two marks on one page sharing an id would cut
// both with the first one's mask, and whichever of them turns would turn the other's spark too.
test("two marks on a page each cut their openings with a mask of their own", () => {
  const page = draw({}, { busy: true });
  const ids = [...page.matchAll(/<mask id="([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(page).toContain(`mask="url(#${id})"`);
  // An id the url() reference can carry unquoted.
  for (const id of ids) expect(id).toMatch(/^[A-Za-z][\w-]*$/);
});

test("busy is said on the mark the motion rules read, and only while busy", () => {
  expect(draw({ busy: true })).toMatch(/<g class="mark mark--perce" data-busy="true">/);
  expect(draw({ busy: false })).not.toContain("data-busy");
  expect(draw({})).not.toContain("data-busy");
});

test("beside the word Evermind the mark is hidden from a screen reader; alone it is named", () => {
  const beside = draw({ decorative: true });
  expect(beside).toContain('aria-hidden="true"');
  expect(beside).not.toContain("role=");
  const alone = draw({});
  expect(alone).toContain('role="img"');
  expect(alone).toContain('aria-label="Evermind"');
  expect(alone).not.toContain("aria-hidden");
});

test("the mark takes its size from its classes and its colour from the text", () => {
  const svg = draw({ className: "h-7 w-7 text-ember-400" });
  expect(svg).toMatch(/^<svg[^>]* class="h-7 w-7 text-ember-400"/);
  expect(svg).toContain('fill="currentColor"');
  expect(svg).toContain('viewBox="0 -4.2 64 64"');
});

// React 19 gives ids like `_r_1_`; React 18 gave `:r0:` and a canary `«r0»`. A colon or a guillemet
// in the id would break the unquoted url(#…) that cuts the openings, and the mark would lose its eyes.
test("the mask's id keeps only what url() reads unquoted, whatever form React gives its ids", () => {
  expect(maskId(":r0:")).toBe("mark-maskr0");
  expect(maskId("«r0»")).toBe("mark-maskr0");
  expect(maskId("_r_1_")).toBe("mark-mask_r_1_");
  expect(maskId(":r0:")).not.toBe(maskId(":r1:"));
});

// The spark is drawn from its arm and its waist alone, so that another size is one edit.
test("the spark is a four-pointed star of the arm and waist it is given, drawn around 0,0", () => {
  expect(sparkPath(8.2, 2.7)).toBe("M0 -8.2C2.7 -2.7 2.7 -2.7 8.2 0C2.7 2.7 2.7 2.7 0 8.2C-2.7 2.7 -2.7 2.7 -8.2 0C-2.7 -2.7 -2.7 -2.7 0 -8.2Z");
  expect(sparkPath(9, 3)).toBe("M0 -9C3 -3 3 -3 9 0C3 3 3 3 0 9C-3 3 -3 3 -9 0C-3 -3 -3 -3 0 -9Z");
  expect(draw({})).toContain(`class="mark-spark" d="${sparkPath(SPARK.arm, SPARK.waist)}"`);
});

// The browser's tab and a phone's home screen show the same drawing as the page.
test("the tab icon is the mark, with its spark", () => {
  const favicon = readFileSync(`${frontend}/public/favicon.svg`, "utf8");
  // The spark's outline, which only this drawing has: a little fuller than the page's, so it holds at 16 px.
  expect(favicon).toContain("M45 20.5C48.3 26.7 48.3 26.7 54 30");
  expect(favicon).toContain("Evermind");
});
