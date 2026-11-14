import { expect, test, type Page } from "@playwright/test";
import { GATED } from "../playwright.config";
import { makeCharacter, makeConversation } from "./fixtures";

/**
 * Evermind's mark: the tab shows it, it winks when the pointer or the keyboard comes to it, and its
 * spark turns while Evermind waits on itself. The motion is CSS alone, so what is read here is what
 * the browser plays: the animations it lists and the events it fires.
 */

/** Every start and end of the mark's animations on this page, counted from the first script on. */
async function countMotion(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { markMotion: string[] }).markMotion = seen;
    for (const kind of ["animationstart", "animationend"]) {
      document.addEventListener(kind, (e) => {
        const { animationName } = e as AnimationEvent;
        if (animationName.startsWith("mark-")) seen.push(`${kind.slice(9)} ${animationName}`);
      }, true);
    }
  });
}

const motion = (page: Page) => page.evaluate(() => (window as unknown as { markMotion: string[] }).markMotion.slice());

/** The animations running on the spark of the marks `scope` selects, by name. */
const sparkAnimations = (page: Page, scope: string) => page.evaluate((scope) =>
  document.getAnimations()
    .filter((a) => a.effect instanceof KeyframeEffect && (a.effect.target as Element | null)?.matches(`${scope} .mark-spark`))
    .map((a) => (a as CSSAnimation).animationName), scope);

const BRAND = "aside a .mark";

/** A phone has no sidebar, and so no name to come over: the mark beside it is a wide screen's. */
const besideTheName = (project: string) => test.skip(project !== "desktop", "the sidebar is drawn from tablet width up");

test("the tab's icon is Evermind's own mark", async ({ request }) => {
  const icon = await request.get("/favicon.svg");
  expect(icon.ok()).toBe(true);
  const drawing = await icon.text();
  // Its spark: a four-pointed star cut in the mask, which no stock icon draws here.
  expect(drawing).toContain("M45 20.5C48.3 26.7 48.3 26.7 54 30");
  expect(drawing).not.toMatch(/lucide|venetian/i);
});

test("the mark beside the name winks once when the pointer comes over the name", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await countMotion(page);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const brand = page.getByRole("link", { name: "Evermind", exact: true });
  expect(await sparkAnimations(page, BRAND)).toEqual([]);

  // Over the word, not the drawing: the link is what winks it.
  await brand.getByText("Evermind").hover();
  expect(await sparkAnimations(page, BRAND)).toEqual(["mark-blink"]);
  // It closes and opens again once, and does not go on while the pointer stays.
  await expect.poll(() => sparkAnimations(page, BRAND)).toEqual([]);
  expect(await motion(page)).toEqual(["start mark-blink", "end mark-blink"]);
});

test("the wink is a slow eyelid of about 560 ms, not a flick", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Evermind", exact: true }).hover();
  const duration = await page.evaluate(() =>
    document.getAnimations()
      .filter((a) => (a as CSSAnimation).animationName === "mark-blink")
      .map((a) => a.effect!.getTiming().duration));
  expect(duration).toEqual([560]);
});

test("a pointer that leaves half-way lets the wink finish", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await countMotion(page);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const header = page.getByRole("link", { name: "Evermind", exact: true });
  const mark = page.locator(BRAND);

  await header.hover();
  await page.waitForTimeout(100);
  // Away to the middle of the page, far from the header.
  await page.mouse.move(800, 500);
  await page.waitForTimeout(200);
  // At about 300 ms the eyelid is still on its way: it did not snap open when the pointer left.
  expect(await sparkAnimations(page, BRAND)).toEqual(["mark-blink"]);
  await expect(mark).toHaveAttribute("data-wink", "true");

  await expect.poll(() => motion(page)).toEqual(["start mark-blink", "end mark-blink"]);
  await expect(mark).not.toHaveAttribute("data-wink");
  expect(await sparkAnimations(page, BRAND)).toEqual([]);
});

test("coming over the name twice winks twice, and never more", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await countMotion(page);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const header = page.getByRole("link", { name: "Evermind", exact: true });

  await header.hover();
  await expect.poll(() => motion(page)).toEqual(["start mark-blink", "end mark-blink"]);
  await page.mouse.move(800, 500);
  await header.hover();
  // The second time the pointer stays over the name, more than two winks long: one wink, no loop.
  await page.waitForTimeout(1300);
  expect(await motion(page)).toEqual(["start mark-blink", "end mark-blink", "start mark-blink", "end mark-blink"]);
  await expect(page.locator(BRAND)).not.toHaveAttribute("data-wink");
});

test("the mark beside the name winks when the keyboard reaches its link", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await countMotion(page);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const brand = page.getByRole("link", { name: "Evermind", exact: true });

  for (let i = 0; i < 5 && !(await brand.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(brand).toBeFocused();
  await expect.poll(() => motion(page)).toEqual(["start mark-blink", "end mark-blink"]);
  expect(await sparkAnimations(page, BRAND)).toEqual([]);
});

test("asked for less motion, the mark does not wink", { tag: "@desktop" }, async ({ page }, testInfo) => {
  besideTheName(testInfo.project.name);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await countMotion(page);
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const brand = page.getByRole("link", { name: "Evermind", exact: true });
  await brand.hover();
  // Not a wink cut to an instant by the page-wide rule for less motion, which would still flick: none.
  expect(await page.locator(`${BRAND} .mark-spark`).evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(700);
  expect(await motion(page)).toEqual([]);
  // Nothing that would wink it later either.
  await expect(page.locator(BRAND)).not.toHaveAttribute("data-wink");
});

test.describe("on the server with a password", () => {
  test.use({ baseURL: GATED });

  // The login's mark is not a link: nothing happens by coming over it, so it does not wink at rest.
  test("the login's mark does not wink under the pointer: it is not a link", { tag: "@desktop" }, async ({ page }) => {
    await countMotion(page);
    await page.goto("/#/login");
    const mark = page.locator("svg:has(+ h1) .mark");
    await expect(mark).toHaveCount(1);
    await mark.locator("xpath=..").hover();
    await page.waitForTimeout(350);
    expect(await sparkAnimations(page, "svg:has(+ h1)")).toEqual([]);
    expect(await motion(page)).toEqual([]);
  });

  test("the login's mark turns while the password is checked, and stops when it is answered", { tag: "@desktop" }, async ({ page }) => {
    await countMotion(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/gate", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.continue();
    });

    await page.goto("/#/login");
    const mark = page.locator("svg:has(+ h1) .mark");
    await expect(mark).toHaveCount(1);
    await expect(mark).not.toHaveAttribute("data-busy");

    // A wrong password: answered, the login stays, and its mark with it.
    await page.getByLabel(/password/i).fill("not-the-password");
    await page.getByRole("button", { name: /enter/i }).click();
    await expect(mark).toHaveAttribute("data-busy", "true");
    expect(await sparkAnimations(page, "svg:has(+ h1)")).toEqual(["mark-busy"]);

    // Busy, it does not wink: the pointer over it leaves the turning alone.
    await mark.locator("xpath=..").hover();
    await page.waitForTimeout(350);
    expect(await sparkAnimations(page, "svg:has(+ h1)")).toEqual(["mark-busy"]);
    expect(await motion(page)).not.toContain("start mark-blink");

    release();
    await expect(page.getByText(/access denied/i)).toBeVisible();
    await expect(mark).not.toHaveAttribute("data-busy");
    await expect.poll(() => sparkAnimations(page, "svg:has(+ h1)")).toEqual([]);
  });

  test("asked for less motion, the login's mark only dims its spark while it waits, for as long as it waits", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/gate", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.continue();
    });

    await page.goto("/#/login");
    await page.getByLabel(/password/i).fill("not-the-password");
    await page.getByRole("button", { name: /enter/i }).click();
    await expect(page.locator("svg:has(+ h1) .mark")).toHaveAttribute("data-busy", "true");
    // Not the turn, and not cut to an instant by the page-wide rule for less motion: a slow breath that goes on.
    await page.waitForTimeout(600);
    expect(await sparkAnimations(page, "svg:has(+ h1)")).toEqual(["mark-busy-calm"]);
    release();
    await expect(page.getByText(/access denied/i)).toBeVisible();
  });
});

/** Holds the first GET of `path` until `release` is called. */
async function holdFirst(page: Page, path: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route((url) => url.pathname === path, async (route) => {
    if (first && route.request().method() === "GET") {
      first = false;
      await held;
    }
    await route.continue();
  });
  return () => release();
}

for (const place of [
  { name: "a conversation", words: "Opening the scene…" },
  { name: "a character", words: "Loading…" },
  { name: "a character's form", words: "Loading…" },
]) {
  test(`while ${place.name} is read, a turning mark says so above the words, and the page replaces it`, { tag: "@desktop" }, async ({ page, request }) => {
    let address: string;
    let path: string;
    let arrived: RegExp;
    if (place.name === "a conversation") {
      const convo = await makeConversation(request, { name: "Wren" });
      address = `/#/chat/${convo.id}`;
      path = `/api/conversations/${convo.id}`;
      arrived = /The door was already open/;
    } else {
      const character = await makeCharacter(request, { name: "Wren" });
      const edit = place.name === "a character's form";
      address = `/#/characters/${character.id}${edit ? "/edit" : ""}`;
      path = `/api/characters/${character.id}`;
      arrived = edit ? /Made for a test/ : /Terse\. Does not repeat herself\./;
    }
    const release = await holdFirst(page, path);

    await page.goto(address);
    const words = page.getByText(place.words, { exact: true });
    await expect(words).toBeVisible();
    // The mark, turning, just above the words, and hidden from a screen reader, which reads the words.
    const wait = words.locator("xpath=..");
    const mark = wait.locator(".mark");
    await expect(mark).toHaveAttribute("data-busy", "true");
    await expect(wait.locator("svg")).toHaveAttribute("aria-hidden", "true");
    const [above, line] = [await wait.locator("svg").boundingBox(), await words.boundingBox()];
    expect(above!.y + above!.height).toBeLessThanOrEqual(line!.y + 1);
    expect(above!.height).toBeCloseTo(32, 0);

    release();
    if (place.name === "a character's form") await expect(page.getByRole("textbox", { name: /tagline/i })).toHaveValue(arrived);
    else await expect(page.getByText(arrived).first()).toBeVisible();
    await expect(words).toHaveCount(0);
    await expect(page.locator("main .mark")).toHaveCount(0);
  });
}
