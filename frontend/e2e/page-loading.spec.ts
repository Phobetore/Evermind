import { expect, test, type Page } from "@playwright/test";

/** The code of the personas page, under whatever name the build gave it. */
const PERSONAS_CODE = /\/assets\/PersonasPage-[^/]*\.js$/;

/** Keeps the page's code from arriving until `release()` is called, as it
 *  would be on a bad connection, or until `fail()` is, when the connection
 *  then drops. `asked.at` is when the browser asked for it. */
async function holdBack(page: Page, code: RegExp) {
  let settle!: (outcome: "release" | "fail") => void;
  const settled = new Promise<"release" | "fail">((resolve) => { settle = resolve; });
  const asked = { at: 0 };
  await page.route(code, async (route) => {
    asked.at = Date.now();
    if ((await settled) === "release") await route.continue();
    else await route.fulfill({ status: 404 });
  });
  return { release: () => settle("release"), fail: () => settle("fail"), asked };
}

/** Answers for a page's code with a script of the test's own. */
async function serveInstead(page: Page, code: RegExp, script: string) {
  await page.route(code, (route) => route.fulfill({ contentType: "text/javascript", body: script }));
}

/** What went to the console as an error, from now on. */
function consoleErrors(page: Page) {
  const logged: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });
  return () => logged.join(" ");
}

const personasHeading = (page: Page) => page.getByRole("heading", { name: "Personas", level: 1 });
const pageAlert = (page: Page) => page.locator("main").getByRole("alert");

test("a page that arrives at once shows no loading line on the way, and is there at once", async ({ page }) => {
  // The home page, because it says nothing of its own while its data is on its
  // way (it draws empty cards): any "Loading…" is then the page's code being
  // waited for, which here arrives in a few milliseconds and has no business
  // being announced. Noted by the page itself, on its own clock, since a line
  // that came and went before this test looked would be missed, and a clock
  // kept here would be skewed by the test's own pace.
  await page.addInitScript(() => {
    const seen = window as unknown as { loadingSeen?: boolean; shellAt?: number; pageAt?: number };
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Loading…")) seen.loadingSeen = true;
      if (seen.shellAt === undefined && document.querySelector("main")) seen.shellAt = performance.now();
      if (seen.pageAt === undefined && document.querySelector("main h1")) seen.pageAt = performance.now();
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const seen = await page.evaluate(() => {
    const noted = window as unknown as { loadingSeen?: boolean; shellAt: number; pageAt: number };
    return { loadingSeen: noted.loadingSeen, shellAt: noted.shellAt, pageAt: noted.pageAt };
  });
  expect(seen.loadingSeen, "a loading line flashed up while the page was on its way").toBeUndefined();
  // From the navigation being drawn to the page being drawn: tens of
  // milliseconds here. A page held back to let a loading line be shown first
  // takes 300 ms or more from the first draw, however quick the file is.
  expect(seen.pageAt - seen.shellAt, "the page was kept waiting after the navigation was drawn")
    .toBeLessThan(250);
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

/** Notes, in the page, when the click lands and when the bar first shows. */
async function watchBar(page: Page) {
  await page.evaluate(() => {
    const seen = window as unknown as { clickedAt?: number; barAt?: number };
    document.addEventListener("click", () => { seen.clickedAt = Date.now(); }, { capture: true, once: true });
    new MutationObserver(() => {
      if (seen.barAt === undefined && document.querySelector('[role="progressbar"]')) {
        seen.barAt = Date.now();
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

test("going to a page whose code is slow keeps the current one, and shows progress after a moment", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const { release } = await holdBack(page, PERSONAS_CODE);

  // Both moments noted by the page: a clock kept here would include whatever
  // time the test spends getting ready to click.
  await watchBar(page);
  await page.getByRole("link", { name: "Personas", exact: true }).click();

  const bar = page.getByRole("progressbar");
  await expect(bar).toBeVisible();
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
  await expect(bar).toHaveCount(0);
});

test("a page whose code cannot be fetched says so and offers to reload", async ({ page }) => {
  // As in a tab left open through an update: the file the page asks for has
  // been renamed, and the old name is gone.
  await page.route(PERSONAS_CODE, (route) => route.fulfill({ status: 404 }));
  const logged = consoleErrors(page);

  await page.goto("/#/personas");
  const alert = pageAlert(page);
  await expect(alert).toContainText(/could not be loaded/i);
  // Not swallowed either: the browser's own words for it are in the console.
  expect(logged()).toMatch(/dynamically imported module/);
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
  const alert = pageAlert(page);
  await expect(alert).toContainText(/could not be loaded/i);
  await expect(alert.getByRole("button", { name: /reload/i })).toBeVisible();
  // The navigation is still around it.
  await expect(page.getByRole("link", { name: "Discover", exact: true })).toBeVisible();
});

test("a page whose code fails as it starts is not blamed on the download", async ({ page }) => {
  // The file arrives, and breaks as soon as it runs: a fault in the page, which
  // fetching it again would only repeat.
  await serveInstead(page, PERSONAS_CODE, 'throw new Error("a bug at the top of the page");');
  const logged = consoleErrors(page);

  await page.goto("/#/personas");
  const alert = pageAlert(page);
  await expect(alert).toHaveText(/something went wrong/i);
  await expect(alert.getByRole("button")).toHaveCount(0);
  expect(logged()).toMatch(/a bug at the top of the page/);
});

test("a page that breaks while it is drawn is not blamed on the download", async ({ page }) => {
  // The file is fine and the page fails when it is drawn.
  await serveInstead(
    page,
    PERSONAS_CODE,
    'export function PersonasPage() { throw new Error("a bug while drawing the page"); }',
  );
  const logged = consoleErrors(page);

  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  await page.getByRole("link", { name: "Personas", exact: true }).click();
  const alert = pageAlert(page);
  await expect(alert).toHaveText(/something went wrong/i);
  await expect(alert.getByRole("button")).toHaveCount(0);
  // And it is not swallowed: whoever has the console open can see what broke.
  expect(logged()).toMatch(/a bug while drawing the page/);

  // The rest of the app is untouched.
  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(alert).toHaveCount(0);
});
