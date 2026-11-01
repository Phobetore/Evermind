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

/** Opens `route` once and comes back to the home page, loaded again: the files
 *  of the page are then in the browser's cache (the build names them by their
 *  content and the server marks them immutable), so that what follows is a page
 *  that arrives at once whatever else the machine is doing. Without it, "at
 *  once" would depend on how busy the server is, and the first minute of a run
 *  is when it is. */
async function warmCache(page: Page, route: string) {
  await page.goto(route);
  await expect(page.locator("main h1")).toBeVisible();
  await page.goto("/#/");
  await page.reload();
  await expect(page.locator("main h1")).toBeVisible();
}

/** What goes to the console as an error, from now on. `about(words)` is how
 *  many of those entries mention `words`: one per fault is the point, a fault
 *  reported twice buries the next one. */
function consoleErrors(page: Page) {
  const logged: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") logged.push(message.text()); });
  return {
    about: async (words: RegExp) => {
      // Entries reach the test in order and over the same connection as this
      // answer: once it is back, none that was already logged is still on its way.
      await page.evaluate(() => 0);
      return logged.filter((entry) => words.test(entry)).length;
    },
  };
}

const personasHeading = (page: Page) => page.getByRole("heading", { name: "Personas", level: 1 });
const pageAlert = (page: Page) => page.locator("main").getByRole("alert");

test("a page that arrives at once shows no loading line on the way, and is there at once", async ({ page }) => {
  // The home page, because it says nothing of its own while its data is on its
  // way (it draws empty cards): any "Loading…" is then the page's code being
  // waited for, which here arrives in a few milliseconds and has no business
  // being announced. Noted by the page itself, on its own clock, since a line
  // that came and went before this test looked would be missed, and a clock
  // kept here would be skewed by the test's own pace. The files come from the
  // cache, loaded a first time on the way in.
  await page.addInitScript(() => {
    const seen = window as unknown as { loadingSeen?: boolean; shellAt?: number; pageAt?: number };
    new MutationObserver(() => {
      if (document.body?.textContent?.includes("Loading…")) seen.loadingSeen = true;
      if (seen.shellAt === undefined && document.querySelector("main")) seen.shellAt = performance.now();
      if (seen.pageAt === undefined && document.querySelector("main h1")) seen.pageAt = performance.now();
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await warmCache(page, "/#/");
  const seen = await page.evaluate(() => {
    const noted = window as unknown as { loadingSeen?: boolean; shellAt: number; pageAt: number };
    return { loadingSeen: noted.loadingSeen, shellAt: noted.shellAt, pageAt: noted.pageAt };
  });
  expect(seen.loadingSeen, "a loading line flashed up while the page was on its way").toBeUndefined();
  // From the navigation being drawn to the page being drawn: a few tens of
  // milliseconds here. The bound is only a sanity limit, loose enough for a
  // busy machine: a page held back so that a loading line can be shown first
  // is what the assertion above catches, and that one cannot come from load.
  expect(seen.pageAt - seen.shellAt, "the page was kept waiting after the navigation was drawn")
    .toBeLessThan(1000);
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
  // Below the notch or the status bar of a phone, where the page reaches the
  // edges of the screen.
  await expect(bar).toHaveAttribute("style", /top:\s*env\(safe-area-inset-top\)/);
  // Said to those who cannot see it, politely, once the wait is a long one.
  await expect(page.getByRole("status")).toHaveText("Loading…");
  // Nothing was taken away while waiting: the page the person is on is still
  // there, and no second "loading" was put in its place.
  await expect(page.locator("main h1")).toBeVisible();
  await expect(personasHeading(page)).toHaveCount(0);
  await expect(page.locator("main").getByText("Loading…")).toHaveCount(0);

  release();
  await expect(personasHeading(page)).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("");
});

test("a quick change of page shows no bar and says nothing", async ({ page }) => {
  // The page's files are in the cache: the change takes a few milliseconds
  // however busy the server is, and anything shown for it is shown too soon.
  await warmCache(page, "/#/personas");
  await page.evaluate(() => {
    const seen = window as unknown as { shown?: boolean };
    new MutationObserver(() => {
      const said = document.querySelector('[role="status"]')?.textContent;
      if (document.querySelector('[role="progressbar"]') || said) seen.shown = true;
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.getByRole("link", { name: "Personas", exact: true }).click();
  await expect(personasHeading(page)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { shown?: boolean }).shown),
    "a bar or a message came up for a page that arrived at once").toBeUndefined();
});

test("the bar goes away when the page's code then fails to arrive", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const { fail } = await holdBack(page, PERSONAS_CODE);

  await page.getByRole("link", { name: "Personas", exact: true }).click();
  await expect(page.getByRole("progressbar")).toBeVisible();

  fail();
  await expect(pageAlert(page)).toContainText(/could not be loaded/i);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("");
});

test("with reduced motion the wait is still shown, and nothing moves", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  const { release } = await holdBack(page, PERSONAS_CODE);

  await page.getByRole("link", { name: "Personas", exact: true }).click();
  const bar = page.getByRole("progressbar");
  await expect(bar).toBeVisible();
  // A still bar the width of the screen, instead of a stretch of it sliding
  // along: what is waited for is still said, without anything to follow.
  const still = await bar.evaluate((el) => {
    const inner = el.firstElementChild as HTMLElement;
    return {
      animation: getComputedStyle(inner).animationName,
      full: inner.getBoundingClientRect().width >= el.getBoundingClientRect().width - 1,
    };
  });
  expect(still).toEqual({ animation: "none", full: true });

  release();
  await expect(personasHeading(page)).toBeVisible();
  // The page's own way in, which rises into place by default, is over at once.
  const rise = await page.locator("main header").evaluate((el) => getComputedStyle(el).animationDuration);
  expect(parseFloat(rise), "the page still animates its entry").toBeLessThan(0.001);
});

test("a page whose code cannot be fetched says so and offers to reload", async ({ page }) => {
  // As in a tab left open through an update: the file the page asks for has
  // been renamed, and the old name is gone.
  await page.route(PERSONAS_CODE, (route) => route.fulfill({ status: 404 }));
  const logged = consoleErrors(page);

  await page.goto("/#/personas");
  const alert = pageAlert(page);
  await expect(alert).toContainText(/could not be loaded/i);
  // Not swallowed either: the browser's own words for it are in the console,
  // once.
  expect(await logged.about(/dynamically imported module/)).toBe(1);
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
  // fetching it again may well repeat.
  await serveInstead(page, PERSONAS_CODE, 'throw new Error("a bug at the top of the page");');
  const logged = consoleErrors(page);

  await page.goto("/#/personas");
  const alert = pageAlert(page);
  await expect(alert).toContainText(/something went wrong/i);
  // Reloading may not help, and may: the person decides.
  await expect(alert.getByRole("button", { name: /reload/i })).toBeVisible();
  expect(await logged.about(/a bug at the top of the page/)).toBe(1);
});

test("a failure worded in a way nobody knows is not taken for a download either, but can be reloaded", async ({ page }) => {
  // What a browser we have not seen might say of a file it could not get. It
  // matches nothing known, so it is reported as a fault, and reloading is
  // still what the person is offered.
  await serveInstead(page, PERSONAS_CODE, 'throw new TypeError("Load failed");');
  const logged = consoleErrors(page);

  await page.goto("/#/personas");
  const alert = pageAlert(page);
  await expect(alert).toContainText(/something went wrong/i);
  await expect(alert.getByRole("button", { name: /reload/i })).toBeVisible();
  expect(await logged.about(/Load failed/)).toBe(1);
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
  await expect(alert).toContainText(/something went wrong/i);
  await expect(alert.getByRole("button", { name: /reload/i })).toBeVisible();
  // And it is not swallowed: whoever has the console open can see what broke,
  // once.
  expect(await logged.about(/a bug while drawing the page/)).toBe(1);

  // The rest of the app is untouched.
  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await expect(page.locator("main h1")).toBeVisible();
  await expect(alert).toHaveCount(0);
});
