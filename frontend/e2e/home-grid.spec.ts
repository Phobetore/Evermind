import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

/** The home page's cards on a phone: what a card is about in a few words, all its first tags in a
 *  row that slides, a grid of two columns, and a page that loads only the pictures near the screen.
 *  The computer keeps its tile, with the excerpt for a card that has no tagline. */

// The cards each test sows, deleted after it: the home page of every later test would draw them.
const made: string[] = [];
test.afterEach(async ({ request }) => {
  const ids = made.splice(0);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => request.delete(`${API}/api/characters/${id}`)));
  }
});

type Made = { id: string; name: string; avatar_url: string | null; avatar_thumb_url: string | null };

async function card(request: APIRequestContext, fields: Record<string, unknown>): Promise<Made> {
  const character = await makeCharacter(request, fields);
  made.push(character.id);
  return character;
}

async function withPortrait(request: APIRequestContext, id: string): Promise<Made> {
  const sent = await request.post(`${API}/api/characters/${id}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok(), "the portrait was not taken").toBe(true);
  return sent.json();
}

const cardOf = async (request: APIRequestContext, id: string): Promise<Made> =>
  (await request.get(`${API}/api/characters/${id}`)).json();

const fileName = (url: string | null) => url?.slice(url.lastIndexOf("/") + 1) ?? "";
const tileOf = (page: Page, id: string) => page.locator(`main a[href$="/characters/${id}"]`);
const searchOf = (page: Page) => page.getByPlaceholder("Search by name, mood…");
const chipsOf = (tile: Locator) => tile.locator(".card-tags > span");
const isSearch = (url: URL) => url.pathname.endsWith("/api/characters/search");

/** The home page with only the cards this text finds. */
async function homeWith(page: Page, text: string) {
  await page.goto("/#/");
  await searchOf(page).fill(text);
}

/** A root size of the page's own, as Safari and Firefox set it for very large system text. */
function rootAt(size: string) {
  const set = () => document.documentElement.style.setProperty("font-size", size);
  if (document.documentElement) set();
  else document.addEventListener("DOMContentLoaded", set);
}

const linesOf = (target: Locator) => target.evaluate((el) => ({
  height: el.getBoundingClientRect().height,
  line: parseFloat(getComputedStyle(el).lineHeight),
}));

// Under the description of Sélène in tests/cases/card_excerpt.json: markup, a heading, a W++ block and
// a sheet of fields come before the first sentence, and {{char}} names her.
const SELENE = "<div align=\"center\"><img src=\"selene.png\"></div>\n# Sélène\n"
  + "[Character(\"Sélène\") Age(\"312\") Personality(\"calme\" + \"têtue\")]\nNom : Sélène\nÂge : 312 ans\n\n"
  + "*Elle garde le gué depuis trois siècles.* {{char}} ne laisse passer que ceux qui lui racontent une histoire vraie.";
const WPP_ONLY = "[character(\"Orin\")\n{\nSpecies(\"elfe\")\nMind(\"calme\")\n}]";

test("a card shows its name, its text and its first eight tags", async ({ page, request }) => {
  const stamp = Date.now();
  const eight = await card(request, {
    name: `Eight ${stamp}`, tagline: "Keeps the lamp lit", tags: Array.from({ length: 8 }, (_, i) => `t${i + 1}`),
  });
  const twelve = await card(request, {
    name: `Twelve ${stamp}`, tags: Array.from({ length: 12 }, (_, i) => `u${i + 1}`),
  });
  const listed = page.waitForResponse((r) => r.url().includes("/api/characters?fields=card"));
  await homeWith(page, String(stamp));
  const light: { id: string; tags: string[] }[] = await (await listed).json();
  expect(light.find((c) => c.id === twelve.id)?.tags, "the light list lost tags").toHaveLength(12);

  const tile = tileOf(page, eight.id);
  await expect(tile.getByRole("heading", { name: eight.name })).toBeVisible();
  await expect(tile.locator(".card-text")).toHaveText("Keeps the lamp lit");
  await expect(tile.locator(".card-text")).toBeVisible();
  await expect(chipsOf(tile)).toHaveText(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  const tops = await chipsOf(tile).evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().top));
  expect(new Set(tops).size, "the tags are not on one row").toBe(1);
  const { height, line } = await linesOf(tile.locator(".card-text"));
  expect(height, "the text runs past two lines beside tags").toBeLessThanOrEqual(line * 2.5);

  await expect(chipsOf(tileOf(page, twelve.id)))
    .toHaveText(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "+4"]);
});

test("a card with no tagline shows the first real sentence", async ({ page, request }) => {
  const stamp = Date.now();
  const selene = await card(request, { name: `Sélène ${stamp}`, tagline: "", description: SELENE });
  await homeWith(page, String(stamp));
  const text = tileOf(page, selene.id).locator(".card-text");
  await expect(text).toBeVisible();
  await expect(text).toHaveText(/^Elle garde le gué/);
  await expect(text).toContainText(`${selene.name} ne laisse passer`);
});

test("the four layouts", async ({ page, request }) => {
  const stamp = Date.now();
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const untagged = await card(request, { name: `Untagged ${stamp}`, tagline: words, tags: [] });
  const textless = await card(request, { name: `Textless ${stamp}`, tagline: "", description: WPP_ONLY, tags: ["a", "b"] });
  const bare = await card(request, { name: `Bare ${stamp}`, tagline: "", description: WPP_ONLY, tags: [] });
  await homeWith(page, String(stamp));

  const loose = tileOf(page, untagged.id).locator(".card-text");
  await expect(loose).toBeVisible();
  const { height, line } = await linesOf(loose);
  expect(height, "the text runs past three lines with no tags").toBeLessThanOrEqual(line * 3.5);
  expect(height, "the text keeps to two lines with no tags").toBeGreaterThan(line * 2.5);
  await expect(tileOf(page, untagged.id).locator(".card-tags")).toHaveCount(0);

  await expect(tileOf(page, textless.id).getByRole("heading", { name: textless.name })).toBeVisible();
  await expect(tileOf(page, textless.id).locator(".card-text")).toHaveCount(0);
  await expect(chipsOf(tileOf(page, textless.id))).toHaveText(["a", "b"]);

  await expect(tileOf(page, bare.id).getByRole("heading", { name: bare.name })).toBeVisible();
  await expect(tileOf(page, bare.id).locator(".card-text, .card-tags")).toHaveCount(0);
  // No picture: the coloured initial.
  await expect(tileOf(page, bare.id).locator("img")).toHaveCount(0);
  await expect(tileOf(page, bare.id).getByText("B", { exact: true })).toBeVisible();
});

test("a swipe across the tags scrolls them and opens nothing", async ({ page, request }) => {
  const stamp = Date.now();
  const tags = Array.from({ length: 8 }, (_, i) => `a rather long tag ${i + 1}`);
  const wide = await card(request, { name: `Swiped ${stamp}`, tags });
  await homeWith(page, String(stamp));
  const tile = tileOf(page, wide.id);
  const row = tile.locator(".card-tags");
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth), "the row does not overflow").toBe(true);

  const box = (await row.boundingBox())!;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x, y }],
  });
  await touch("touchStart", box.x + box.width - 10);
  for (let step = 1; step <= 10; step++) {
    await touch("touchMove", box.x + box.width - 10 - step * ((box.width - 20) / 10));
    await page.waitForTimeout(16);
  }
  // Held still before it is lifted: a finger lifted while moving flings the row, and the browser
  // takes the next touch as the one that stops the fling, not as a tap.
  await page.waitForTimeout(200);
  await touch("touchEnd", box.x + 10);
  await expect.poll(() => row.evaluate((el) => el.scrollLeft), { message: "the row did not scroll" }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  expect(new URL(page.url()).hash, "the swipe opened the card").toBe("#/");

  // On the tag the row shows most of, out of its fade.
  const shown = (await Promise.all((await chipsOf(tile).all()).map((chip) => chip.boundingBox())))
    .map((b) => ({ y: b!.y + b!.height / 2, from: Math.max(b!.x, box.x), to: Math.min(b!.x + b!.width, box.x + box.width - 28) }))
    .sort((a, b) => (b.to - b.from) - (a.to - a.from))[0];
  expect(shown.to - shown.from, "no tag is in sight").toBeGreaterThan(10);
  await page.touchscreen.tap((shown.from + shown.to) / 2, shown.y);
  await expect(page).toHaveURL(new RegExp(`#/characters/${wide.id}$`));
});

test("the keyboard never stops on a row of tags", async ({ page, request }) => {
  const stamp = Date.now();
  const tags = Array.from({ length: 6 }, (_, i) => `a rather long tag ${i + 1}`);
  const wide = await card(request, { name: `Keyed ${stamp}`, tags });
  await homeWith(page, String(stamp));
  const tile = tileOf(page, wide.id);
  await expect(tile).toBeVisible();

  let seen = false;
  for (let press = 0; press < 20; press++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("card-tags")), "a row of tags took the focus")
      .toBe(false);
    if (await tile.evaluate((el) => el === document.activeElement)) {
      seen = true;
      const frame = (await tile.boundingBox())!;
      for (const chip of await chipsOf(tile).all()) {
        const drawn = (await chip.boundingBox())!;
        expect(drawn.x + drawn.width, "a tag is hidden past the card's edge").toBeLessThanOrEqual(frame.x + frame.width + 0.5);
        expect(drawn.y, "a tag is above the card").toBeGreaterThanOrEqual(frame.y);
      }
      // Out of sight but still said: the text is in the link's description.
      await expect(tile.locator(".card-text")).toBeHidden();
    }
  }
  expect(seen, "the card never took the focus").toBe(true);
});

test("a screen reader hears the name, the text and the tags", async ({ page, request }) => {
  const stamp = Date.now();
  const heard = await card(request, { name: `Heard ${stamp}`, tagline: "Keeps the lamp lit", tags: ["sea", "night"] });
  await withPortrait(request, heard.id);
  await homeWith(page, String(stamp));
  const tile = tileOf(page, heard.id);
  await expect(tile).toHaveAccessibleName(heard.name);
  await expect(tile.locator("img")).toHaveAttribute("alt", "");
  await expect(tile).toHaveAccessibleDescription(/Keeps the lamp lit.*Tags: sea, night/);
});

test("three hundred cards load only the pictures near the screen", async ({ page, request }) => {
  test.slow();
  const stamp = Date.now();
  for (let i = 0; i < 300; i += 25) {
    await Promise.all(Array.from({ length: Math.min(25, 300 - i) }, async (_, j) => {
      const sown = await (await request.post(`${API}/api/characters`, {
        data: { name: `Crowd ${stamp} ${i + j}`, kind: "character", tagline: "One of many" },
      })).json();
      made.push(sown.id);
      await withPortrait(request, sown.id);
    }));
  }
  const images: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "image") images.push(r.url());
  });
  const listed = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/api/characters"));
  await page.goto("/#/");
  expect(new URL((await listed).url()).searchParams.get("fields"), "the home page read the whole list").toBe("card");
  await expect(page.locator("main a[href*='/characters/'] img").first()).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(images.length, "pictures far from the screen were loaded").toBeLessThan(40);
});

test("a word found only in a description still finds its card", async ({ page, request }) => {
  const stamp = Date.now();
  const word = `brumelune${stamp}`;
  const hidden = await card(request, {
    name: `Hidden ${stamp}`, kind: "character", tagline: "Nothing to see", description: `She walks the ${word} shore.`,
    tags: [`mist${stamp}`],
  });
  await homeWith(page, word);
  const tile = tileOf(page, hidden.id);
  await expect(tile).toBeVisible();

  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await expect(tile).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(tile).toBeVisible();

  const chip = page.getByRole("button", { name: `mist${stamp}` });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(tile).toBeVisible();

  await page.route(isSearch, (route) => route.fulfill({ status: 500, json: { detail: "Broken." } }));
  await homeWith(page, `Hidden ${stamp}`);
  await expect(page.getByText("The descriptions could not be searched: only names and taglines were.")).toBeVisible();
  await expect(tile).toBeVisible();
});

test("very large text leaves one column", async ({ page, request }) => {
  await card(request, { name: `Large ${Date.now()}` });
  await card(request, { name: `Larger ${Date.now()}` });
  // The zoomed page first: the root of 32 pixels, once set for the tab, stays for every load after it.
  for (const screen of [{ width: 195, height: 400, root: 16 }, { width: 390, height: 844, root: 32 }]) {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    if (screen.root !== 16) await page.addInitScript(rootAt, `${screen.root}px`);
    for (const locale of ["en", "fr", "de", "es"]) {
      await page.goto("/#/");
      await page.evaluate((chosen) => localStorage.setItem("evermind:locale", chosen), locale);
      await page.reload();
      const where = `${locale} at ${screen.width}px, root ${screen.root}px`;
      expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), where)
        .toBe(screen.root);
      const grid = page.locator("main .card-grid");
      await expect(grid.locator("a").first()).toBeVisible();
      expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length), `${where}: columns`)
        .toBe(1);
      expect(await page.locator("#main").evaluate((el) => el.scrollWidth - el.clientWidth), `${where}: sideways`)
        .toBeLessThanOrEqual(0);
      const outside = await page.evaluate(() => [
        ...document.querySelectorAll("main h1, main input.field, main header + div :is(button, a)"),
      ].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.left < 0 || box.right > innerWidth + 0.5;
      }).map((el) => el.textContent || el.outerHTML.slice(0, 60)));
      expect(outside, `${where}: out of the screen`).toEqual([]);
    }
  }
});

test("a search waiting on descriptions shows no empty page", async ({ page, request }) => {
  const stamp = Date.now();
  const word = `brumelune${stamp}`;
  const waited = await card(request, { name: `Waited ${stamp}`, tagline: "Nothing to see", description: `The ${word} path.` });
  let release: (() => void) | undefined;
  const asked = new Promise<Route>((resolve) => {
    void page.route(isSearch, (route) => {
      resolve(route);
      return new Promise<void>((done) => { release = done; });
    });
  });
  await homeWith(page, word);
  const held = await asked;
  await expect(page.getByText("Also searching the descriptions…")).toBeVisible();
  await expect(page.getByText("The stage is empty")).toHaveCount(0);
  await held.continue();
  release?.();
  await expect(tileOf(page, waited.id)).toBeVisible();
  await expect(page.getByText("Also searching the descriptions…")).toHaveCount(0);
});

test("an old card gets its copies once its tile is shown", async ({ page, request }) => {
  const stamp = Date.now();
  const old = await card(request, { name: `Old ${stamp}` });
  const portrait = await withPortrait(request, old.id);
  expect(portrait.avatar_thumb_url).toBeNull();
  await homeWith(page, String(stamp));
  const picture = tileOf(page, old.id).locator("img");
  await expect.poll(() => picture.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect.poll(async () => (await cardOf(request, old.id)).avatar_thumb_url, { timeout: 30_000 }).toBeTruthy();
  const kept = await cardOf(request, old.id);

  let sent = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/avatar/sizes")) sent += 1;
  });
  await page.reload();
  await searchOf(page).fill(String(stamp));
  await expect.poll(() => picture.evaluate((el: HTMLImageElement) => el.currentSrc)).toMatch(new RegExp(`${fileName(kept.avatar_thumb_url)}$`));
  await page.waitForTimeout(1_000);
  expect(sent, "copies were sent again").toBe(0);
});

test("the computer's home page keeps its tile @desktop", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "a phone has no computer's tile: its own tests are above");
  const stamp = Date.now();
  const tagged = await card(request, { name: `Desk ${stamp}`, tagline: "Keeps the lamp lit", tags: ["a", "b", "c", "d", "e"] });
  await withPortrait(request, tagged.id);
  const selene = await card(request, { name: `Sélène ${stamp}`, tagline: "", description: SELENE });
  await homeWith(page, String(stamp));
  // Its copies first, made from this tile, then the tile drawn again.
  await expect.poll(async () => (await cardOf(request, tagged.id)).avatar_thumb_url, { timeout: 30_000 }).toBeTruthy();
  await page.reload();
  await searchOf(page).fill(String(stamp));

  const grid = page.locator("main .card-grid");
  expect(await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBeGreaterThanOrEqual(3);
  const tile = tileOf(page, tagged.id);
  await expect(tile.locator(".card-text")).toHaveText("Keeps the lamp lit");
  await expect(chipsOf(tile).filter({ visible: true })).toHaveText(["a", "b", "c"]);
  const start = tile.getByRole("button", { name: "Start", exact: true });
  await page.mouse.move(2, 2);
  await expect(start).toHaveCSS("opacity", "0");
  await tile.hover();
  await expect(start).toHaveCSS("opacity", "1");
  const avatar = (await cardOf(request, tagged.id)).avatar_url;
  await expect.poll(() => tile.locator("img").evaluate((el: HTMLImageElement) => el.currentSrc))
    .toMatch(new RegExp(`${fileName(avatar)}$`));

  const excerpt = tileOf(page, selene.id).locator(".card-text");
  await expect(excerpt).toBeVisible();
  await expect(excerpt).toHaveText(/^Elle garde le gué/);
  const { height, line } = await linesOf(excerpt);
  expect(height, "the excerpt runs past two lines").toBeLessThanOrEqual(line * 2.5);
});

test("a search with no answer ends in its failure line @desktop", async ({ page, request }) => {
  const stamp = Date.now();
  const named = await card(request, { name: `Unanswered ${stamp}` });
  await page.clock.install();
  // Held for good: no answer ever begins.
  await page.route(isSearch, () => new Promise<void>(() => {}));
  await page.goto("/#/");
  await expect(tileOf(page, named.id)).toBeVisible();
  const asked = page.waitForRequest((r) => isSearch(new URL(r.url())));
  await searchOf(page).fill(`Unanswered ${stamp}`);
  await page.clock.runFor(300);
  await asked;
  await page.clock.runFor(10_000);
  await expect(page.getByText("The descriptions could not be searched: only names and taglines were.")).toBeVisible();
  await expect(tileOf(page, named.id)).toBeVisible();
});
