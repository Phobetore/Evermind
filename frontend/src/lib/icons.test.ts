import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));

// Without a declared icon every browser asks for /favicon.ico and gets a 404, and a phone's
// home-screen bookmark has no picture: so each icon the page names must be a file that ships.
test("every icon index.html declares is a file in public/", () => {
  const page = readFileSync(`${root}/index.html`, "utf8");
  const icons = [...page.matchAll(/<link\s[^>]*rel="[^"]*icon[^"]*"[^>]*>/g)].map((tag) => {
    const href = /href="([^"]+)"/.exec(tag[0]);
    return href ? href[1] : "";
  });
  expect(icons.length).toBeGreaterThanOrEqual(2);
  for (const href of icons) {
    expect(href.startsWith("/"), `${href} is an absolute path`).toBe(true);
    expect(existsSync(`${root}/public${href}`), `public${href} exists`).toBe(true);
  }
});
