import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

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

  // The page scrolls inside <main>, which stays where it is from one route to
  // the next, so it is <main> that has to be sent back to the top. Scrolled a
  // little, not to the bottom: the link to the next page is at the top of
  // this one, and the browser scrolls a link that is out of sight into view
  // before clicking it, which would do the resetting being tested.
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

test("a page whose code is slow to arrive says so, but not at once", async ({ page }) => {
  // Held back until the test lets it go, as it would be on a bad connection.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let askedAt = 0;
  await page.route(/\/assets\/PersonasPage-[^/]*\.js$/, async (route) => {
    askedAt = Date.now();
    await held;
    await route.continue();
  });

  // When the line first appears, noted by the page itself: looking for it from
  // here would be a race against this test's own pace, and could not tell a
  // line that came late from one that came and went before anyone looked.
  await page.addInitScript(() => {
    const seen = window as unknown as { loadingAt?: number };
    new MutationObserver(() => {
      if (seen.loadingAt === undefined && document.body?.textContent?.includes("Loading…")) {
        seen.loadingAt = Date.now();
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.goto("/#/personas");
  // In <main>: the navigation around it is already up, and only the page is
  // missing.
  await expect(page.locator("main").getByText("Loading…")).toBeVisible();
  const loadingAt = await page.evaluate(() => (window as unknown as { loadingAt: number }).loadingAt);
  expect(askedAt, "the page's code was never asked for").toBeGreaterThan(0);
  expect(loadingAt - askedAt, "the line came up at once, and would flash on a page that loads quickly")
    .toBeGreaterThanOrEqual(150);

  release();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("a page whose code cannot be fetched says so and offers to reload", async ({ page }) => {
  // As in a tab left open through an update: the file the page asks for has
  // been renamed, and the old name is gone.
  const personas = /\/assets\/PersonasPage-[^/]*\.js$/;
  await page.route(personas, (route) => route.fulfill({ status: 404 }));

  await page.goto("/#/personas");
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText(/could not be loaded/i);
  // Failed once, a page stays failed for as long as the document lives: only
  // loading it again helps.
  await page.unroute(personas);
  await alert.getByRole("button", { name: /reload/i }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(alert).toHaveCount(0);
});
