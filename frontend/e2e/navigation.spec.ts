import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inLocale, makeCharacter, rootAt } from "./fixtures";

test("the skip link focuses the content without changing the route", async ({ page }) => {
  // Not the home page: an address the router cannot make sense of falls back
  // to the home page, which would hide the route having changed.
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const before = page.url();

  // The skip link is the first stop of the page.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip to content/i })).toBeFocused();
  await page.keyboard.press("Enter");

  // It points at "#main", which in a hash router would be a route of its own.
  await expect(page.locator("#main")).toBeFocused();
  expect(page.url()).toBe(before);
});

test("a new page starts at the top", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "a phone is where the list is long enough to scroll");

  // Enough cards, two to a row, for the page to scroll.
  for (let i = 0; i < 12; i++) await makeCharacter(request, { name: `Scroll ${i}` });

  await page.goto("/");
  const main = page.locator("main");
  await expect(main.locator("a:has(h2)").nth(11)).toBeVisible();

  // Scrolled a little, not to the bottom: the link to the next page is at the top of this one, and
  // a click scrolls a link that is out of sight into view, which would do the reset being tested.
  await main.evaluate((el) => el.scrollTo(0, 60));
  expect(await main.evaluate((el) => el.scrollTop), "the list did not scroll").toBeGreaterThan(0);
  const create = page.getByRole("link", { name: /^create$/i });
  await expect(create, "the link is not in sight, so clicking it would scroll").toBeInViewport({ ratio: 1 });

  // The new-card form, and not a character: a page that waits for data first
  // starts out as a short "loading" line, which makes the browser pull the
  // scroll position back to the top by itself. This page is as tall as it will
  // be from its first frame, so only the reset can explain landing at the top.
  await create.click();
  await expect(page.getByRole("heading", { name: /new card/i })).toBeVisible();
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await main.evaluate((el) => el.scrollHeight > el.clientHeight),
    "the form is not taller than the screen, so landing at the top proves nothing").toBe(true);
});

test("what cannot be read is said, and read again when asked", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  // The page is there already, and then the wifi goes.
  const unreachable = "**/api/**";
  for (const name of ["Conversations", "Personas", "Settings"]) {
    await page.route(unreachable, (route) => route.abort("internetdisconnected"));
    await page.getByRole("link", { name, exact: true }).click();
    const failure = page.locator("main").getByRole("alert");
    await expect(failure, `on ${name}`).toContainText("Evermind is not answering");
    await expect(page.locator("main").getByText("Loading…"), `on ${name}`).toHaveCount(0);
    await page.unroute(unreachable);
    await failure.getByRole("button", { name: "Reload" }).click();
    await expect(failure, `on ${name}`).toHaveCount(0);
  }

  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page.route("**/api/library", (route) => route.abort("internetdisconnected"));
  await page.getByTitle("Starter library").click();
  const library = page.getByRole("dialog");
  await expect(library.getByRole("alert")).toContainText("Evermind is not answering");
  await expect(library, "said to be empty").not.toContainText("The library is empty");
  await page.unroute("**/api/library");
  await library.getByRole("button", { name: "Reload" }).click();
  await expect(library.locator("h3").first()).toBeVisible();
  await expect(library.getByRole("alert")).toHaveCount(0);
});

test("a page that breaks says so in its place, and the other pages still open", async ({ page }) => {
  // A name that is not text breaks the page as it is drawn.
  await page.route("**/api/personas", (route) => route.fulfill({ json: [{ id: "p", name: {} }] }));
  await page.goto("/#/personas");
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText("Something went wrong.");
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Personas", level: 1 }), "the page is still there").toHaveCount(0);

  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("the language is chosen in the sidebar, or in the settings where there is none", { tag: "@desktop" }, async ({ page, isMobile }) => {
  await page.goto("/#/settings");
  const inSettings = page.locator("main").getByLabel("Language");
  const inSidebar = page.locator("aside").getByLabel("Language");
  const [shown, other] = isMobile ? [inSettings, inSidebar] : [inSidebar, inSettings];
  await expect(other, "two of them on one screen").toBeHidden();
  // Not under 16px on a phone: iOS zooms into a box that is.
  if (isMobile) expect(parseFloat(await shown.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await shown.selectOption({ label: "Français" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Paramètres");
});

// The bar at the foot of a phone, its text at its own size and at the largest (a root of 32px, as
// Safari and Firefox set it): a label shows whole in its own tab, or the bar shows its icons alone,
// each tab still named by its label. At the text's own size the labels show, as they always have.
for (const locale of ["en", "fr", "de", "es"]) {
  test(`the bottom navigation's labels show whole or not at all, in ${locale}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "the bar is a phone's");
    await inLocale(page, locale);
    const words = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`), "utf8"));
    const names = [words.nav.discover, words.nav.conversations, words.nav.personas, words.nav.settings];
    for (const root of ["16px", "32px"]) {
      if (root === "32px") await page.addInitScript(rootAt, root);
      for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
        const at = `at ${size.width}px, a root of ${root}`;
        await page.setViewportSize(size);
        await page.goto("about:blank");
        await page.goto("/#/settings");
        const bar = page.getByRole("navigation").filter({ has: page.getByRole("link", { name: names[3] }) }).last();
        await expect(bar).toBeVisible();
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(root);
        await page.evaluate(() => document.fonts.ready);
        for (const name of names) await expect(bar.getByRole("link", { name, exact: true }), at).toBeVisible();
        const tabs = await bar.getByRole("link").evaluateAll((links) => links.map((link) => {
          const label = link.querySelector("span")!;
          const range = document.createRange();
          range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          const box = link.getBoundingClientRect();
          const row = link.parentElement!.getBoundingClientRect();
          return {
            // Each tab its share: tabs grown to their words run them together.
            even: Math.abs(box.width - row.width / links.length) < 1,
            shown: getComputedStyle(label).position !== "absolute",
            whole: text.left >= box.left - 0.5 && text.right <= box.right + 0.5,
            inside: box.left >= -0.5 && box.right <= innerWidth + 0.5,
            tall: box.height >= 44,
          };
        }));
        const shown = tabs.filter((tab) => tab.shown).length;
        // All or none: a bar half in words would read as two kinds of tabs.
        expect([0, tabs.length], at).toContain(shown);
        if (shown) expect(tabs.every((tab) => tab.whole && tab.inside && tab.even), `a label cut or over the next ${at}`).toBe(true);
        else expect(tabs.every((tab) => tab.tall && tab.inside && tab.even), `an icon's tab under a finger's height ${at}`).toBe(true);
        if (root === "16px") expect(shown, `the labels at the text's own size ${at}`).toBe(tabs.length);
      }
    }
  });
}
