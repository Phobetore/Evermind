import { expect, test, type Page } from "@playwright/test";

/** The code of the personas page, under whatever name the build gave it. */
const PERSONAS_CODE = /\/assets\/PersonasPage-[^/]*\.js$/;

/** Keeps the page's code from arriving until `release()` is called, as it
 *  would be on a bad connection. `askedAt` is when the browser asked for it. */
async function holdBack(page: Page, code: RegExp) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const asked = { at: 0 };
  await page.route(code, async (route) => {
    asked.at = Date.now();
    await held;
    await route.continue();
  });
  return { release, asked };
}

const personasHeading = (page: Page) => page.getByRole("heading", { name: "Personas", level: 1 });

test("a page that arrives at once shows no loading line on the way", async ({ page }) => {
  // The home page, because it says nothing of its own while its data is on its
  // way (it draws empty cards): any "Loading…" is then the page's code being
  // waited for, which here arrives in a few milliseconds and has no business
  // being announced. Noted by the page itself, since a line that came and went
  // before this test looked would be missed.
  await page.addInitScript(() => {
    const seen = window as unknown as { loadingSeen?: boolean };
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Loading…")) seen.loadingSeen = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { loadingSeen?: boolean }).loadingSeen),
    "a loading line flashed up while the page was on its way").toBeUndefined();
});

test("a page whose code is slow to arrive says so, but not at once", async ({ page }) => {
  const { release, asked } = await holdBack(page, PERSONAS_CODE);

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
  expect(asked.at, "the page's code was never asked for").toBeGreaterThan(0);
  expect(loadingAt - asked.at, "the line came up at once, and would flash on a page that loads quickly")
    .toBeGreaterThanOrEqual(150);

  release();
  await expect(personasHeading(page)).toBeVisible();
});

test("going to a page whose code is slow keeps the current one, and shows progress after a moment", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const { release } = await holdBack(page, PERSONAS_CODE);

  // Both moments noted by the page: a clock kept here would include whatever
  // time the test spends getting ready to click.
  await page.evaluate(() => {
    const seen = window as unknown as { clickedAt?: number; barAt?: number };
    document.addEventListener("click", () => { seen.clickedAt = Date.now(); }, { capture: true, once: true });
    new MutationObserver(() => {
      if (seen.barAt === undefined && document.querySelector('[role="progressbar"]')) {
        seen.barAt = Date.now();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.getByRole("link", { name: "Personas", exact: true }).click();

  await expect(page.getByRole("progressbar")).toBeVisible();
  const { clickedAt, barAt } = await page.evaluate(() => {
    const seen = window as unknown as { clickedAt: number; barAt: number };
    return { clickedAt: seen.clickedAt, barAt: seen.barAt };
  });
  expect(barAt - clickedAt, "the bar came up at once, and would flicker on a quick change of page")
    .toBeGreaterThanOrEqual(150);
  // Nothing was taken away while waiting: the page the person is on is still
  // there, and no second "loading" was put in its place.
  await expect(page.locator("main h1")).toBeVisible();
  await expect(personasHeading(page)).toHaveCount(0);
  await expect(page.locator("main").getByText("Loading…")).toHaveCount(0);

  release();
  await expect(personasHeading(page)).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("a page whose code cannot be fetched says so and offers to reload", async ({ page }) => {
  // As in a tab left open through an update: the file the page asks for has
  // been renamed, and the old name is gone.
  await page.route(PERSONAS_CODE, (route) => route.fulfill({ status: 404 }));
  const logged: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });

  await page.goto("/#/personas");
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText(/could not be loaded/i);
  // Not swallowed either: the browser's own words for it are in the console.
  expect(logged.join(" ")).toMatch(/dynamically imported module/);
  // The same address, loaded again, is what helps.
  await page.unroute(PERSONAS_CODE);
  await alert.getByRole("button", { name: /reload/i }).click();
  await expect(personasHeading(page)).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("the same goes for a page opened from another one", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  await page.route(PERSONAS_CODE, (route) => route.fulfill({ status: 404 }));

  await page.getByRole("link", { name: "Personas", exact: true }).click();
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toContainText(/could not be loaded/i);
  await expect(alert.getByRole("button", { name: /reload/i })).toBeVisible();
  // The navigation is still around it.
  await expect(page.getByRole("link", { name: "Discover", exact: true })).toBeVisible();
});

test("a page that breaks while it is drawn is not blamed on the download", async ({ page }) => {
  // A card with no tags is something the home page cannot draw: a fault in the
  // page, which loading it again would only repeat.
  await page.route(/\/api\/characters(\?.*)?$/, (route) =>
    route.fulfill({ json: [{ id: "c1", name: "Vane" }] }));
  const logged: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });

  await page.goto("/#/");
  const alert = page.locator("main").getByRole("alert");
  await expect(alert).toHaveText(/something went wrong/i);
  await expect(alert.getByRole("button")).toHaveCount(0);
  // And it is not swallowed: whoever has the console open can see what broke.
  expect(logged.join(" ")).toMatch(/Cannot read properties of undefined/);

  // The rest of the app is untouched.
  await page.getByRole("link", { name: "Personas", exact: true }).click();
  await expect(personasHeading(page)).toBeVisible();
  await expect(alert).toHaveCount(0);
});
