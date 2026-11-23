import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, makeConversation, PNG } from "./fixtures";

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
  // conversation leaves, never because its 350 ms ran out.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
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
