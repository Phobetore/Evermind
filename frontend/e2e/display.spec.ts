import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversation, conversationWithReply, makeConversation, PNG, stopTurn } from "./fixtures";

/** What this device shows: the size of a conversation's text and how strongly a picture sits behind
 *  it, set from the Aa sheet over the conversation or from Settings, the one display for both. */

const aa = (page: Page) => page.getByRole("button", { name: "Display: text size and backdrop" });
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Display" });
const textSize = (page: Page) => page.getByRole("slider", { name: "Conversation text size" });
const strength = (page: Page) => page.getByRole("slider", { name: "Picture strength" });

/** The size the first message of the story is drawn at, in pixels. */
const proseSize = (page: Page) =>
  page.locator("[data-message-id] .rp-prose").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

async function openConversation(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}

async function withPortrait(request: APIRequestContext, characterId: string) {
  const sent = await request.post(`${API}/api/characters/${characterId}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok(), "the portrait was not taken").toBe(true);
}

async function withWallpaper(request: APIRequestContext, id: string) {
  const sent = await request.post(`${API}/api/conversations/${id}/wallpaper`, {
    multipart: { file: { name: "backdrop.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok(), "the backdrop was not taken").toBe(true);
}

const ownStrength = async (request: APIRequestContext, id: string) =>
  (await conversation(request, id)).backdrop_strength;

test("the Aa sheet changes the conversation as the slider moves", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const other = await conversationWithReply(request);
  await openConversation(page, convo.id);
  const before = await proseSize(page);

  await aa(page).click();
  await textSize(page).fill("150");
  await expect(sheetOf(page), "the sheet closed as the slider moved").toBeVisible();
  await expect.poll(() => proseSize(page)).toBeCloseTo(before * 1.5, 1);

  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await expect(sheetOf(page)).toHaveCount(0);
  await aa(page).click();
  await expect(textSize(page)).toHaveValue("150");
  await expect(sheetOf(page).getByText("150%", { exact: true })).toBeVisible();

  await openConversation(page, other.id);
  await expect.poll(() => proseSize(page)).toBeCloseTo(before * 1.5, 1);
  await aa(page).click();
  await expect(textSize(page)).toHaveValue("150");
});

test("the step buttons move by five percent", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await aa(page).click();
  const sheet = sheetOf(page);
  await expect(sheet.getByText("100% · original", { exact: true })).toBeVisible();

  await sheet.getByRole("button", { name: "Larger" }).click();
  await expect(textSize(page)).toHaveValue("105");
  await expect(sheet.getByText("105%", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Smaller" }).click();
  await sheet.getByRole("button", { name: "Smaller" }).click();
  await expect(textSize(page)).toHaveValue("95");
  await expect(sheet.getByText("95%", { exact: true })).toBeVisible();
});

test("80 and 200 are the ends", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await aa(page).click();
  const sheet = sheetOf(page);

  await textSize(page).fill("200");
  await sheet.getByRole("button", { name: "Larger" }).click();
  await expect(textSize(page)).toHaveValue("200");
  await expect(sheet.getByText("200%", { exact: true })).toBeVisible();

  await textSize(page).fill("80");
  await sheet.getByRole("button", { name: "Smaller" }).click();
  await expect(textSize(page)).toHaveValue("80");
  await expect(sheet.getByText("80%", { exact: true })).toBeVisible();
});

test("settings and the sheet share one display", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto("/#/settings");
  const block = page.getByRole("region", { name: "Display · on this device" });
  const sample = block.locator(".rp-prose");
  await expect(sample).toContainText("Three winters");
  const before = await sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  await block.getByRole("slider", { name: "Conversation text size" }).fill("130");
  await expect(block.getByText("130%", { exact: true })).toBeVisible();
  await expect.poll(() => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)))
    .toBeCloseTo(before * 1.3, 1);

  await openConversation(page, convo.id);
  await aa(page).click();
  await expect(sheetOf(page).getByText("130%", { exact: true })).toBeVisible();
});

test("the strength slider edits the strength in effect", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withPortrait(request, convo.character_id);
  await openConversation(page, convo.id);
  await aa(page).click();
  const sheet = sheetOf(page);

  await expect(sheet.getByText("20% · this device", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Set for this conversation only" }).click();
  await expect(sheet.getByText("20% · this conversation", { exact: true })).toBeVisible();

  await strength(page).fill("35");
  await expect(sheet.getByText("35% · this conversation", { exact: true })).toBeVisible();
  await expect.poll(() => ownStrength(request, convo.id)).toBe(0.35);

  await sheet.getByRole("button", { name: "Use this device's strength (20%)" }).click();
  await expect(sheet.getByText("20% · this device", { exact: true })).toBeVisible();
  await expect.poll(() => ownStrength(request, convo.id)).toBeNull();
});

test("the panel's adjust button opens the same sheet", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withWallpaper(request, convo.id);
  await openConversation(page, convo.id);
  await page.getByRole("button", { name: "Conversation memory and settings" }).click();
  await page.getByRole("button", { name: "Adjust strength" }).click();

  await expect(sheetOf(page)).toBeVisible();
  await expect(strength(page)).toBeFocused();
  await expect(sheetOf(page).getByText("25% · this conversation", { exact: true })).toBeVisible();
});

test("the sheet holds the focus and gives it back", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await aa(page).focus();
  await page.keyboard.press("Enter");
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((box) => box.contains(document.activeElement) || document.activeElement === document.body),
      "the focus left the sheet for the page behind").toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(aa(page)).toBeFocused();
});

test("the sheet closes by touch", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await aa(page).tap();
  await sheetOf(page).getByRole("button", { name: "Close" }).tap();
  await expect(sheetOf(page)).toHaveCount(0);

  await aa(page).tap();
  const box = (await sheetOf(page).locator("[data-sheet]").boundingBox())!;
  expect(box.y, "the sheet leaves nothing above it to touch").toBeGreaterThan(60);
  await page.touchscreen.tap(box.x + box.width / 2, box.y / 2);
  await expect(sheetOf(page)).toHaveCount(0);
});

test("a strength moved just before leaving is kept", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withPortrait(request, convo.character_id);
  await page.clock.install();
  await openConversation(page, convo.id);
  await aa(page).click();
  await sheetOf(page).getByRole("button", { name: "Set for this conversation only" }).click();
  await expect.poll(() => ownStrength(request, convo.id)).toBe(0.2);
  // The page's time stands still from here: what is waiting can only go out because the
  // conversation leaves, never because its 350 ms ran out. A second ahead, so the moment is
  // not already past when the call reaches the page; nothing is waiting to fire meanwhile.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().endsWith(`/api/conversations/${convo.id}`)) sent.push(r.postData() ?? "");
  });
  await strength(page).fill("45");
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  expect(sent, "written before the conversation was left").toEqual([]);
  await page.getByRole("link", { name: "Back to conversations" }).click();
  await expect(page).toHaveURL(/#\/chat$/);
  // The conversation has left the page, not only the address.
  await expect(page.locator("[data-message-id]")).toHaveCount(0);
  await expect.poll(() => sent, "nothing sent as the conversation left").toHaveLength(1);
  // Landed before it is read again: a read sent alongside the write may reach the server first.
  await expect.poll(() => ownStrength(request, convo.id)).toBe(0.45);
  await page.clock.resume();

  await openConversation(page, convo.id);
  await aa(page).click();
  await expect(sheetOf(page).getByText("45% · this conversation", { exact: true })).toBeVisible();
  expect(await ownStrength(request, convo.id)).toBe(0.45);

  await strength(page).fill("55");
  await page.reload();
  await expect.poll(() => ownStrength(request, convo.id)).toBe(0.55);
});

test("the sheet shows only its own failures", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withWallpaper(request, convo.id);
  await openConversation(page, convo.id);
  await page.route(`**/api/conversations/${convo.id}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("internetdisconnected") : route.continue());
  await page.getByTitle("Rename conversation").click();
  await page.keyboard.type(" again");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Evermind is not answering");

  await aa(page).click();
  await expect(sheetOf(page)).toBeVisible();
  await expect(sheetOf(page).getByRole("alert")).toHaveCount(0);

  // A failure of its own is said while it is open, and not again once it has been closed.
  await strength(page).fill("60");
  await expect(sheetOf(page).getByRole("alert")).toContainText("Evermind is not answering");
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await expect(sheetOf(page)).toHaveCount(0);
  await aa(page).click();
  await expect(sheetOf(page)).toBeVisible();
  await expect(sheetOf(page).getByRole("alert")).toHaveCount(0);
});

test("the drawn backdrop follows the sheet's slider", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withWallpaper(request, convo.id);
  await openConversation(page, convo.id);
  const drawn = page.locator("[data-backdrop]");
  await expect(drawn).toHaveCSS("opacity", "0.25");

  await aa(page).click();
  await strength(page).fill("60");
  await expect(drawn).toHaveCSS("opacity", "0.6");
});

test("a card with no picture says so in the sheet", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  await aa(page).click();
  const sheet = sheetOf(page);
  await expect(sheet.getByText("this card has no picture", { exact: true })).toBeVisible();
  await expect(strength(page)).toBeDisabled();
  await expect(sheet.getByRole("button", { name: /^(Set for this conversation only|Use this device's strength)/ }))
    .toHaveCount(0);
});

test("the picture switch in settings hides the picture and holds the strength still", async ({ page }) => {
  await page.goto("/#/settings");
  const block = page.getByRole("region", { name: "Display · on this device" });
  const portrait = block.getByRole("switch", { name: "Character's picture as backdrop" });
  const slider = block.getByRole("slider", { name: "Picture strength" });
  await expect(portrait).toHaveAttribute("aria-checked", "true");
  await expect(block.getByText("20%", { exact: true })).toBeVisible();
  await expect(slider).toBeEnabled();

  await portrait.click();
  await expect(portrait).toHaveAttribute("aria-checked", "false");
  await expect(block.getByText("picture hidden", { exact: true })).toBeVisible();
  await expect(slider).toBeDisabled();

  await portrait.click();
  await expect(portrait).toHaveAttribute("aria-checked", "true");
  await expect(slider).toBeEnabled();
});

test("the picture switch in the sheet hides the character's picture", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withPortrait(request, convo.character_id);
  await openConversation(page, convo.id);
  await aa(page).click();
  const sheet = sheetOf(page);
  const portrait = sheet.getByRole("switch", { name: "Character's picture as backdrop" });
  await expect(sheet.getByText("20% · this device", { exact: true })).toBeVisible();

  await portrait.click();
  await expect(portrait).toHaveAttribute("aria-checked", "false");
  await expect(sheet.getByText("picture hidden", { exact: true })).toBeVisible();
  await expect(strength(page)).toBeDisabled();
});

test("a conversation with no backdrop says so in the sheet", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await withPortrait(request, convo.character_id);
  const set = await request.patch(`${API}/api/conversations/${convo.id}`, { data: { backdrop: "none" } });
  expect(set.ok(), "the backdrop was not set").toBe(true);
  await openConversation(page, convo.id);
  await aa(page).click();
  const sheet = sheetOf(page);
  await expect(sheet.getByText("no backdrop here", { exact: true })).toBeVisible();
  await expect(strength(page)).toBeDisabled();
});

test("the display block is there when the server's settings cannot be read", async ({ page }) => {
  await page.route("**/api/settings", (route) => route.abort("internetdisconnected"));
  await page.goto("/#/settings");
  const block = page.getByRole("region", { name: "Display · on this device" });
  await expect(block.getByRole("slider", { name: "Conversation text size" })).toBeVisible();
});

/* The size of the text in a conversation: what follows it, the input that stops at 130 %, a phone
   set to very large text, and the place being read kept while the size or the width changes. */

const story = (page: Page) => page.locator("[data-story]");
/** The box a message is typed in, the only one while no message is being rewritten. */
const inputBox = (page: Page) => page.locator("textarea").last();
const more = (page: Page) => page.getByRole("button", { name: "Say, narrate, out of character, or write mine for me" });
const fontOf = (target: Locator) => target.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
const sizeOf = async (target: Locator) => {
  const box = (await target.boundingBox())!;
  return { width: box.width, height: box.height };
};
/** The page's root size, which every size in rem is a multiple of. */
const rootOf = (page: Page) => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

/** A root size of the page's own, as Safari and Firefox set it for very large system text. */
function rootAt(size: string) {
  const set = () => document.documentElement.style.setProperty("font-size", size);
  if (document.documentElement) set();
  else document.addEventListener("DOMContentLoaded", set);
}

/** Sets the size from the Aa sheet, and closes it. */
async function textAt(page: Page, percent: number) {
  await aa(page).click();
  await textSize(page).fill(String(percent));
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await expect(sheetOf(page)).toHaveCount(0);
}

const LONG_NAME = "Ottoline Wilhelmina Fairweather-Montrose";
/** As long, with no space to break at. */
const UNBROKEN_NAME = "OttolineWilhelminaFairweatherMontroseXYZ";
const LONG_WORD = "anticonstitutionnellement";
const ADDRESS = `https://example.com/${"a".repeat(60)}`;

test("what grows and what does not", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await chat(request, { conversation_id: convo.id, mode: "send", content: "The rain comes down.", message_mode: "narrate" });
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Keep it short.", message_mode: "ooc" });
  await openConversation(page, convo.id);
  const first = page.locator("[data-message-id]").first();
  const grows = {
    prose: first.locator(".rp-prose"),
    narration: page.getByText("The rain comes down.", { exact: true }),
    ooc: page.getByText("Keep it short.", { exact: true }),
    name: first.getByText("Vane", { exact: true }),
  };
  const title = page.locator("header h1");
  const copy = first.getByTitle("Copy", { exact: true });
  const portrait = first.locator("> :first-child");
  const panelName = page.locator("aside h3");

  async function measure() {
    const sizes: Record<string, number> = {};
    for (const [what, target] of Object.entries(grows)) sizes[what] = await fontOf(target);
    await first.getByTitle("Edit", { exact: true }).click();
    const editor = first.locator("textarea");
    const editorSize = await fontOf(editor);
    await editor.press("Escape");
    await page.getByRole("button", { name: "Conversation memory and settings" }).click();
    const panelSize = await fontOf(panelName);
    await page.getByRole("button", { name: "Close panel" }).click();
    return {
      sizes, editorSize, panelSize,
      title: await fontOf(title), copy: await sizeOf(copy), portrait: await sizeOf(portrait),
    };
  }

  const before = await measure();
  expect(before.editorSize, "the editor drops under the sixteen pixels iOS zooms at").toBeCloseTo(16, 1);
  await textAt(page, 200);
  const after = await measure();
  for (const what of Object.keys(grows)) {
    expect(after.sizes[what], `${what} did not double`).toBeCloseTo(before.sizes[what] * 2, 1);
  }
  expect(after.editorSize, "twice 0.98rem").toBeCloseTo(0.98 * (await rootOf(page)) * 2, 1);
  expect(after.title, "the header's title grew").toBe(before.title);
  expect(after.copy, "a message's button grew").toEqual(before.copy);
  expect(after.portrait, "a message's portrait grew").toEqual(before.portrait);
  expect(after.panelSize, "the panel grew").toBe(before.panelSize);
});

test("the input grows to one hundred and thirty percent and stops", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await textAt(page, 120);
  expect(await fontOf(inputBox(page))).toBeCloseTo(19.2, 1);
  await textAt(page, 200);
  expect(await fontOf(inputBox(page))).toBeCloseTo(20.8, 1);
});

test("the input never drops under sixteen pixels", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  await textAt(page, 80);
  expect(await fontOf(inputBox(page))).toBeCloseTo(16, 1);
});

test("the input grows with its text and scrolls past six lines", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  const box = inputBox(page);
  await box.fill(Array.from({ length: 7 }, (_, i) => `Line ${i + 1}`).join("\n"));
  await expect.poll(() => box.evaluate((el) => {
    const style = getComputedStyle(el);
    const around = ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const;
    const sixLines = 6 * parseFloat(style.lineHeight) + around.reduce((sum, side) => sum + parseFloat(style[side]), 0);
    return Math.abs(el.getBoundingClientRect().height - sixLines);
  }), "not six lines high").toBeLessThan(1);
  expect(await box.evaluate((el) => el.scrollHeight > el.clientHeight), "the seventh line has no room to scroll to").toBe(true);
});

test("the input stops at forty percent of what the screen shows", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.addInitScript(rootAt, "32px");
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  const box = inputBox(page);
  await box.fill(Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join("\n"));
  // Six lines of 32px text would be twice as high: the share of the screen is what stops it.
  const fit = () => box.evaluate((el) => {
    const visible = window.visualViewport?.height ?? window.innerHeight;
    return { off: Math.abs(el.getBoundingClientRect().height - 0.4 * visible), scrolls: el.scrollHeight > el.clientHeight };
  });
  await expect.poll(async () => (await fit()).off, "not forty percent of the screen high").toBeLessThanOrEqual(1);
  expect((await fit()).scrolls, "the lines past it have no room to scroll to").toBe(true);

  // The keyboard opening shrinks what the screen shows: the box follows.
  await page.setViewportSize({ width: 390, height: 320 });
  await expect.poll(async () => (await fit()).off, "the box kept its height as the screen shrank").toBeLessThanOrEqual(1);
});

/* The kept size is read as the conversation's page mounts, while it waits for its opening scene, so it
   is settled long before a message is drawn: that the first read gives it is held in display.test.ts.
   What this holds is the column's own --chat-scale, in place in every frame of the first message. */
test("the first message drawn already has the chosen size", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.addInitScript(() => {
    localStorage.setItem("evermind:display", JSON.stringify({ text: 1.5 }));
    const sizes: number[] = [];
    (window as unknown as { __sizes: number[] }).__sizes = sizes;
    // Read in the frames that follow its insertion, after layout and before paint: a size read at
    // the insertion itself would be worked out there and then, and prove nothing.
    const watch = new MutationObserver(() => {
      const prose = document.querySelector(".rp-prose");
      if (!prose) return;
      watch.disconnect();
      const read = () => {
        sizes.push(parseFloat(getComputedStyle(prose).fontSize));
        if (sizes.length < 6) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    });
    watch.observe(document, { childList: true, subtree: true });
  });
  await openConversation(page, convo.id);
  const sizes = () => page.evaluate(() => (window as unknown as { __sizes: number[] }).__sizes);
  await expect.poll(async () => (await sizes()).length).toBe(6);
  const chosen = 1.05 * (await rootOf(page)) * 1.5;
  for (const size of await sizes()) expect(size, "a frame drawn at another size").toBeCloseTo(chosen, 1);
});

test("with no storage the conversation still draws and the slider still works", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("The site may not keep anything", "SecurityError");
      },
    });
  });
  await openConversation(page, convo.id);
  const original = 1.05 * (await rootOf(page));
  expect(await proseSize(page)).toBeCloseTo(original, 1);
  await aa(page).click();
  await textSize(page).fill("150");
  await expect.poll(() => proseSize(page)).toBeCloseTo(original * 1.5, 1);
});

test.describe("a phone set to very large text keeps every button and no sideways scroll", () => {
  for (const screen of [
    { name: "a root of 32 pixels on 390", width: 390, height: 844, root: 32 },
    // What a page sees under Chrome for Android's zoom of 200 %: half the width, the root unchanged.
    { name: "a page zoomed to 200 percent", width: 195, height: 400, root: 16 },
  ]) {
    test(screen.name, async ({ page, request }) => {
      expect([UNBROKEN_NAME.length, LONG_WORD.length, ADDRESS.length]).toEqual([40, 25, 80]);
      await page.setViewportSize({ width: screen.width, height: screen.height });
      if (screen.root !== 16) await page.addInitScript(rootAt, `${screen.root}px`);
      const unbroken = `${LONG_WORD} ${ADDRESS}`;
      const convo = await makeConversation(request, { name: UNBROKEN_NAME, greeting: unbroken });
      await chat(request, { conversation_id: convo.id, mode: "send", content: unbroken });
      await chat(request, { conversation_id: convo.id, mode: "send", content: unbroken, message_mode: "narrate" });
      await chat(request, { conversation_id: convo.id, mode: "send", content: unbroken, message_mode: "ooc" });
      await openConversation(page, convo.id);
      expect(await rootOf(page)).toBe(screen.root);

      for (const scroller of [page.locator("#main"), story(page)]) {
        expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth), "it scrolls sideways").toBeLessThanOrEqual(0);
      }
      // Each text in its own box: the prose clips, so a word that would not break is cut, not scrolled to.
      for (const kind of [".rp-prose", ".chat-narration", ".chat-ooc", ".chat-name"]) {
        const texts = story(page).locator(kind);
        expect(await texts.count(), `no ${kind} to measure`).toBeGreaterThan(0);
        const wider = await texts.evaluateAll((all) => {
          const right = document.querySelector("[data-story]")!.getBoundingClientRect().right;
          return all.filter((el) => el.scrollWidth > el.clientWidth || el.getBoundingClientRect().right > right + 0.5).length;
        });
        expect(wider, `a ${kind} wider than its box`).toBe(0);
      }
      const buttons = [
        page.getByRole("link", { name: "Back to conversations" }),
        aa(page),
        page.getByRole("button", { name: "Conversation memory and settings" }),
        more(page),
        page.getByTitle("Send", { exact: true }),
      ];
      for (const button of buttons) {
        const box = (await button.boundingBox())!;
        expect([Math.round(box.width), Math.round(box.height)]).toEqual([44, 44]);
        expect(box.x + box.width, "out of the screen").toBeLessThanOrEqual(screen.width);
      }
      // Empty, it rests at one line, and its placeholder does not wrap into a second one it would cut.
      const resting = await inputBox(page).evaluate((el) => {
        const font = parseFloat(getComputedStyle(el).fontSize);
        return { off: Math.abs(el.getBoundingClientRect().height - (2.6 * font + 2)), cut: el.scrollHeight - el.clientHeight };
      });
      expect(resting.off, "the empty input is not one line high").toBeLessThanOrEqual(1);
      expect(resting.cut, "the placeholder wraps under the line").toBeLessThanOrEqual(0);

      // The input folds its two buttons into one.
      await expect(more(page)).toBeVisible();
      await expect(page.locator('button[title^="Say"]')).toBeHidden();
      await expect(page.getByTitle("Write my reply for me (editable before sending)")).toBeHidden();
      await more(page).click();
      await expect(more(page)).toHaveAttribute("aria-expanded", "true");
      const mode = page.getByRole("button", { name: "Say", exact: true });
      await expect(mode).toBeFocused();
      expect(await mode.getAttribute("title")).toBeNull();
      await page.keyboard.press("Escape");
      await expect(mode).toHaveCount(0);
      await expect(more(page)).toBeFocused();
      await more(page).click();
      const pen = page.getByRole("button", { name: "Write mine for me", exact: true });
      await pen.click();
      await expect(pen).toHaveCount(0);
      await expect(inputBox(page)).toBeFocused();

      const portrait = page.getByRole("button", { name: `About ${UNBROKEN_NAME}` });
      const box = inputBox(page);
      const line = box.locator("xpath=..");
      const panel = page.getByRole("button", { name: "Conversation memory and settings" });
      const cardInShort = page.getByRole("button", { name: "The card in short" });
      if (screen.width === 390) {
        await expect(portrait).toBeVisible();
        const size = await sizeOf(portrait);
        expect([Math.round(size.width), Math.round(size.height)]).toEqual([44, 44]);
        expect((await sizeOf(page.locator("header h1"))).width, "the name has no room").toBeGreaterThanOrEqual(120);
        expect((await sizeOf(box)).width / (await sizeOf(line)).width, "the input has no room").toBeGreaterThanOrEqual(0.6);
        await panel.click();
        await expect(page.getByRole("button", { name: "Close panel" })).toBeVisible();
        await expect(cardInShort).toBeHidden();
      } else {
        await expect(portrait).toBeHidden();
        const typed = (await box.boundingBox())!;
        expect(Math.abs(typed.width - (await sizeOf(line)).width), "the input does not have its own line").toBeLessThanOrEqual(1);
        for (const below of [more(page), page.getByTitle("Send", { exact: true })]) {
          expect((await below.boundingBox())!.y, "not under the input").toBeGreaterThanOrEqual(typed.y + typed.height);
        }

        // A touch on the story closes the row, and gives the focus to nothing in particular.
        await more(page).click();
        await expect(mode).toBeFocused();
        await story(page).click({ position: { x: 4, y: 4 } });
        await expect(mode).toHaveCount(0);
        await expect(more(page)).not.toBeFocused();
        // Sending closes it too: sent from the keyboard, so that no touch elsewhere does it instead.
        await more(page).click();
        await expect(mode).toBeVisible();
        await box.fill("Go on.");
        await expect(mode, "typing closed the row").toBeVisible();
        await page.getByTitle("Send", { exact: true }).focus();
        await page.keyboard.press("Enter");
        await expect(mode, "the row stayed open once the message was sent").toHaveCount(0);
        // On the server by then, so the stop has a turn to stop.
        await expect(story(page).getByText("Go on.", { exact: true })).toBeVisible();
        await stopTurn(request, convo.id);

        await panel.click();
        await cardInShort.click();
        await expect(page.getByRole("button", { name: "Close panel" })).toHaveCount(0);
        await expect(page.getByRole("dialog", { name: UNBROKEN_NAME })).toBeVisible();
      }
    });
  }
});

test("a long name takes its own line at two hundred percent", async ({ page, request }) => {
  const convo = await makeConversation(request, { name: LONG_NAME });
  await page.addInitScript(() => localStorage.setItem("evermind:display", JSON.stringify({ text: 2 })));
  await openConversation(page, convo.id);
  const message = page.locator("[data-message-id]").first();
  const name = (await message.getByText(LONG_NAME, { exact: true }).boundingBox())!;
  const edit = (await message.getByTitle("Edit", { exact: true }).boundingBox())!;
  expect(edit.y + edit.height / 2, "the buttons sit beside the name").toBeGreaterThan(name.y + name.height);
});

test("the empty input rests at one line", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await openConversation(page, convo.id);
  const height = async () => (await sizeOf(inputBox(page))).height;
  expect(Math.abs((await height()) - (2.6 * 16 + 2))).toBeLessThanOrEqual(1);
  await textAt(page, 130);
  await expect.poll(async () => Math.abs((await height()) - (2.6 * 20.8 + 2))).toBeLessThanOrEqual(1);
});

/** Forty messages, the page's own (the server's conversation has its one exchange). */
async function fortyMessages(page: Page, request: APIRequestContext, slowly = false) {
  const convo = await conversationWithReply(request, { slowly });
  const words = "A line of the story that runs on for a while. ".repeat(4);
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...convo.messages[0], id: `m${i}`, role: i % 2 ? "assistant" : "user", meta: {},
    // Before the server's own, so that a message sent comes after them.
    position: i - 1000, variants: [`Message ${i}. ${words}`], content: `Message ${i}. ${words}`, active_index: 0,
  }));
  await page.route(`**/api/conversations/${convo.id}`, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { ...convo, messages: many } }) : route.continue());
  await openConversation(page, convo.id);
  return convo;
}

const fromBottom = (page: Page) => story(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

/** Scrolled as a finger would leave it, the message's top at the top of the story: set on the element,
 *  never with the wheel, which acts under a pointer that rests elsewhere on the machine of the CI. */
async function readFrom(page: Page, id: string) {
  await story(page).evaluate((el, id) => {
    const message = el.querySelector(`[data-message-id="${id}"]`)!;
    el.scrollTop += message.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.dispatchEvent(new Event("scroll"));
  }, id);
}

/** The first message seen in the story, and whether its top is near the story's. */
const firstSeen = (page: Page) => story(page).evaluate((el) => {
  const top = el.getBoundingClientRect().top;
  const seen = [...el.querySelectorAll("[data-message-id]")].find((m) => m.getBoundingClientRect().bottom > top + 1)!;
  return { id: seen.getAttribute("data-message-id"), near: Math.abs(seen.getBoundingClientRect().top - top) < 8 };
});

test("changing the size keeps the place being read", async ({ page, request }) => {
  const convo = await fortyMessages(page, request, true);
  // (a) At the bottom, it stays there, and a reply written next keeps it there.
  await expect.poll(() => fromBottom(page)).toBeLessThan(2);
  await aa(page).click();
  await textSize(page).fill("200");
  await expect.poll(() => fromBottom(page), "the bottom was lost").toBeLessThan(2);
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await inputBox(page).fill("Go on.");
  await page.getByTitle("Send", { exact: true }).click();
  await expect(page.locator(".stream-caret")).toContainText(/\w+ \w+/);
  await expect.poll(() => fromBottom(page), "the reply being written left the bottom").toBeLessThan(2);
  await stopTurn(request, convo.id);

  // (b) Read from further up, the message being read stays at the top.
  await readFrom(page, "m9");
  expect(await firstSeen(page)).toEqual({ id: "m9", near: true });
  await aa(page).click();
  await textSize(page).fill("150");
  await expect.poll(() => firstSeen(page), "the place being read was lost").toEqual({ id: "m9", near: true });
});

test("changing the width keeps the place being read", { tag: "@desktop" }, async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the panel sits beside the conversation only on a wide screen");
  await fortyMessages(page, request);
  // Wide enough here for the panel to open with the conversation.
  const close = page.getByRole("button", { name: "Close panel" });
  if (await close.isVisible()) await close.click();
  await readFrom(page, "m9");
  expect(await firstSeen(page)).toEqual({ id: "m9", near: true });

  await page.getByRole("button", { name: "Conversation memory and settings" }).click();
  await expect(close).toBeVisible();
  await expect.poll(() => firstSeen(page), "lost as the panel opened").toEqual({ id: "m9", near: true });
  await close.click();
  await expect(close).toHaveCount(0);
  await expect.poll(() => firstSeen(page), "lost as the panel closed").toEqual({ id: "m9", near: true });
});
