import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, makeConversation, PNG, replyEnds, stopTurn } from "./fixtures";

/** The picture behind a conversation: the character's portrait by default, a picture of the
 *  conversation's own, or nothing; and the plate of the page's colour under the text, which keeps
 *  the picture under 12 % behind every word whatever its strength. */

const story = (page: Page) => page.locator("[data-story]");
const drawn = (page: Page) => page.locator("[data-backdrop] img");
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Display" });
const aa = (page: Page) => page.getByRole("button", { name: "Display: text size and backdrop" });
const portraitSwitch = (page: Page) => sheetOf(page).getByRole("switch", { name: "Character's picture as backdrop" });
const choice = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });
const PORTRAIT = "The character's picture";
const OTHER = "Another picture";
const NONE = "No backdrop";

async function withPortrait(request: APIRequestContext, characterId: string) {
  const sent = await request.post(`${API}/api/characters/${characterId}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok(), "the portrait was not taken").toBe(true);
}

/** A conversation with a reply, whose character has a portrait; as the server then holds it. */
async function withAPortrait(request: APIRequestContext, options: Parameters<typeof conversationWithReply>[1] = {}) {
  const made = await conversationWithReply(request, options);
  await withPortrait(request, made.character_id);
  return conversation(request, made.id);
}

async function openConversation(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
}

/** The side panel, opened if it is not already beside the conversation. */
async function openPanel(page: Page) {
  const opener = page.getByRole("button", { name: "Conversation memory and settings" });
  const close = page.getByRole("button", { name: "Close panel" });
  await expect(opener.or(close).first()).toBeVisible();
  if (await opener.isVisible()) await opener.click();
  await expect(close).toBeVisible();
}

/** Closed where it covers the conversation, a phone's; beside it, on a wide screen, it stays. */
async function leavePanel(page: Page) {
  const close = page.getByRole("button", { name: "Close panel" });
  if (await close.isVisible() && (page.viewportSize()?.width ?? 0) < 768) await close.click();
}

async function setSwitch(page: Page, on: boolean) {
  await aa(page).click();
  const toggle = portraitSwitch(page);
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await expect(sheetOf(page)).toHaveCount(0);
}

/** Sends a picture of the conversation's own from the panel. */
async function chooseAnother(page: Page) {
  const chooser = page.waitForEvent("filechooser");
  await choice(page, OTHER).click();
  await (await chooser).setFiles({ name: "backdrop.png", mimeType: "image/png", buffer: PNG });
}

const opacityOf = (page: Page) => drawn(page).evaluate((img) => Number(getComputedStyle(img).opacity));

/** The alpha of a computed colour: 1 for rgb(), the fourth number of rgba(). */
const alphaOf = (colour: string) => {
  const parts = colour.match(/[\d.]+/g)!.map(Number);
  return parts.length > 3 ? parts[3] : 1;
};

test("a conversation shows the character's picture at twenty percent", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  await expect(drawn(page)).toHaveAttribute("src", convo.character.avatar_url);
  expect(await opacityOf(page)).toBeCloseTo(0.2, 5);
  await expect(story(page)).toHaveClass(/\bover-backdrop\b/);
});

test("the device switch hides it, the conversation's choice wins", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  await expect(drawn(page)).toBeAttached();

  await setSwitch(page, false);
  await expect(drawn(page)).toHaveCount(0);
  await expect(story(page)).not.toHaveClass(/\bover-backdrop\b/);

  await openPanel(page);
  await chooseAnother(page);
  await expect(choice(page, OTHER)).toBeChecked();
  const held = await conversation(request, convo.id);
  expect(held.backdrop).toBe("image");
  await expect(drawn(page)).toHaveAttribute("src", held.wallpaper_url);
  await expect.poll(() => opacityOf(page)).toBeCloseTo(0.25, 5);

  await choice(page, NONE).click();
  await expect(choice(page, NONE)).toBeChecked();
  await expect(drawn(page)).toHaveCount(0);
  await leavePanel(page);
  await setSwitch(page, true);
  await expect(drawn(page)).toHaveCount(0);
  expect((await conversation(request, convo.id)).backdrop).toBe("none");
});

test("removing the chosen picture brings the character back", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  await openPanel(page);
  await chooseAnother(page);
  await expect(choice(page, OTHER)).toBeChecked();
  await expect(drawn(page)).not.toHaveAttribute("src", convo.character.avatar_url);

  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(choice(page, PORTRAIT)).toBeChecked();
  await expect(drawn(page)).toHaveAttribute("src", convo.character.avatar_url);
  await leavePanel(page);
  await aa(page).click();
  await expect(sheetOf(page).getByText("20% · this device", { exact: true })).toBeVisible();
});

test("a device that hides pictures never draws one, not even for a frame", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await page.addInitScript(() => {
    localStorage.setItem("evermind:display", JSON.stringify({ portrait: false }));
    const noted: string[] = [];
    (window as unknown as { __noted: string[] }).__noted = noted;
    // Called before the browser paints what the change inserted.
    new MutationObserver(() => {
      const img = document.querySelector<HTMLImageElement>("[data-backdrop] img");
      if (img) noted.push(img.src);
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  await openConversation(page, convo.id);
  await expect(page.locator("[data-backdrop]")).toBeAttached();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as unknown as { __noted: string[] }).__noted)).toEqual([]);
});

test("a card with no picture draws no backdrop", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await openConversation(page, convo.id);
  await expect(drawn(page)).toHaveCount(0);
  await expect(story(page)).not.toHaveClass(/\bover-backdrop\b/);

  const ends = replyEnds(page, convo.id);
  await page.locator("[data-message-id]").last().getByTitle("Regenerate").click();
  await ends;
  const banner = page.locator(".chat-banner");
  await expect(banner).toContainText("The mock was told to fail.");
  await expect(banner, "the banner lost the tint it has with no backdrop").toHaveCSS("background-color", "rgba(217, 106, 95, 0.1)");
});

test("at full strength the picture weighs 12 % under every kind of message", async ({ page, request }) => {
  const convo = await withAPortrait(request, { slowly: true });
  await page.addInitScript(() => localStorage.setItem("evermind:display", JSON.stringify({ strength: 1 })));
  const base = convo.messages[0];
  const said = (id: string, role: string, content: string, meta: Record<string, unknown> = {}, at = 0) =>
    ({ ...base, id, role, content, variants: [content], active_index: 0, meta, position: at - 1000 });
  // Before the server's own, so that a message sent comes after them.
  const kinds = [
    said("said", "user", "I say a thing.", {}, 0),
    said("narrated", "user", "The rain comes down.", { mode: "narrate" }, 1),
    said("aside", "user", "Keep it short.", { mode: "ooc" }, 2),
    said("cut", "assistant", "She began to", { interrupted: [0] }, 3),
  ];
  // Ahead of what the server holds, read as it is: the page follows a reply by the messages it reads.
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, messages: [...kinds, ...(body.messages ?? [])] } });
  });
  await openConversation(page, convo.id);
  await expect(drawn(page)).toBeAttached();
  expect(await opacityOf(page)).toBe(1);
  await expect(page.locator('[data-message-id="cut"]')).toContainText("interrupted");

  // One message being rewritten, and a reply being written.
  await page.locator('[data-message-id="said"]').getByTitle("Edit", { exact: true }).click();
  await expect(page.locator('[data-message-id="said"] textarea')).toBeVisible();
  await page.locator("textarea").last().fill("Go on.");
  await page.getByTitle("Send", { exact: true }).click();
  await expect(page.locator(".stream-caret")).toBeVisible();

  const plates = () => page.locator(".msg-body").evaluateAll((all) => all.map((el) => getComputedStyle(el).backgroundColor));
  const bodies = await plates();
  expect(bodies.length, "a message without its plate").toBe(await page.locator("[data-message-id]").count() + 1);
  for (const colour of bodies) expect(colour).toBe("rgba(15, 13, 18, 0.88)");
  expect(alphaOf(await page.locator(".chat-ooc").evaluate((el) => getComputedStyle(el).backgroundColor)), "the aside is not opaque").toBe(1);
  // On a phone, where nothing hovers, the buttons are not dimmed.
  for (const opacity of await page.locator(".msg-actions").evaluateAll((all) => all.map((el) => getComputedStyle(el).opacity))) {
    expect(opacity).toBe(page.viewportSize()!.width < 768 ? "1" : "0");
  }
  await stopTurn(request, convo.id);
  await expect(page.locator(".stream-caret")).toHaveCount(0);

  // A banner, from a reply the server refuses.
  await page.route("**/api/chat", (route: Route) => route.fulfill({ status: 500, json: { error: "Broken for the test." } }));
  await page.locator("[data-message-id]").last().getByTitle("Regenerate").click();
  const banner = page.locator(".chat-banner");
  await expect(banner).toBeVisible();
  expect(alphaOf(await banner.evaluate((el) => getComputedStyle(el).backgroundColor)), "the banner is not opaque").toBe(1);
  for (const colour of await plates()) expect(colour).toBe("rgba(15, 13, 18, 0.88)");
});

test("an existing wallpaper keeps its strength and gains the veil", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const sent = await request.post(`${API}/api/conversations/${convo.id}/wallpaper`, {
    multipart: { file: { name: "backdrop.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok(), "the backdrop was not taken").toBe(true);
  // As a page from before the update sets it.
  const set = await request.patch(`${API}/api/conversations/${convo.id}`, { data: { wallpaper_opacity: 0.6 } });
  expect(set.ok(), "the strength was not taken").toBe(true);
  await openConversation(page, convo.id);
  await expect(drawn(page)).toBeAttached();
  expect(await opacityOf(page)).toBeCloseTo(0.6, 5);
  const plate = await story(page).evaluate((el) => Number(getComputedStyle(el).getPropertyValue("--plate")));
  expect(plate).toBeCloseTo(0.8, 5);
});

test("a missing copy falls back to the portrait", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  const copy = `api/media/missing-copy-${convo.id}.webp`;
  let asked = 0;
  await page.route(`**/${copy}`, (route) => {
    asked += 1;
    return route.fulfill({ status: 404, body: "" });
  });
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, character: { ...body.character, avatar_backdrop_url: copy } } });
  });
  await openConversation(page, convo.id);
  await expect(drawn(page)).toHaveAttribute("src", convo.character.avatar_url);
  expect(asked, "the copy was never asked for").toBeGreaterThan(0);
});

test("the picture stays put while the story scrolls", async ({ page, request }) => {
  const opening = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long opening.`).join("\n\n");
  const convo = await makeConversation(request, { greeting: opening });
  await withPortrait(request, convo.character_id);
  await openConversation(page, convo.id);
  await expect(drawn(page)).toBeAttached();
  const before = await drawn(page).boundingBox();
  const moved = await story(page).evaluate((el) => {
    const was = el.scrollTop;
    el.scrollTop = was > 0 ? 0 : el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
    return Math.abs(el.scrollTop - was);
  });
  expect(moved, "the story did not scroll").toBeGreaterThan(200);
  expect(await drawn(page).boundingBox()).toEqual(before);
});

test("a choice the server refuses says so in the panel", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  await page.route(`**/api/conversations/${convo.id}`, (route) =>
    route.request().method() === "PATCH" ? route.abort("internetdisconnected") : route.continue());
  await openPanel(page);
  await choice(page, NONE).click();
  const said = page.locator("aside").getByText(/Evermind is not answering/);
  await expect(said).toBeVisible();
  await expect(said).toBeInViewport();
  await expect(choice(page, PORTRAIT)).toBeChecked();
  await expect(drawn(page)).toHaveAttribute("src", convo.character.avatar_url);
});

test("a choice waiting on the server cannot be sent twice", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  const sent: string[] = [];
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    sent.push(route.request().postData() ?? "");
    await released;
    await route.continue();
  });
  await openPanel(page);
  await choice(page, NONE).click();
  const group = page.getByRole("radiogroup");
  await expect(group).toHaveAttribute("aria-busy", "true");
  for (const name of [PORTRAIT, OTHER, NONE]) await expect(choice(page, name)).toBeDisabled();
  await choice(page, NONE).click({ force: true });
  await page.waitForTimeout(300);
  expect(sent, "a second choice was sent").toHaveLength(1);

  release();
  await expect(choice(page, NONE)).toBeChecked();
  await expect(group).not.toHaveAttribute("aria-busy", "true");
  for (const name of [PORTRAIT, OTHER, NONE]) await expect(choice(page, name)).toBeEnabled();
  expect(sent).toHaveLength(1);
});

test("the panel says when this device hides the picture", async ({ page, request }) => {
  const convo = await withAPortrait(request);
  await page.addInitScript(() => localStorage.setItem("evermind:display", JSON.stringify({ portrait: false })));
  await openConversation(page, convo.id);
  await openPanel(page);
  await expect(choice(page, PORTRAIT)).toBeChecked();
  await expect(page.locator("aside").getByText("Hidden on this device.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change it in Display" }).click();
  await expect(sheetOf(page)).toBeVisible();
  await expect(portraitSwitch(page)).toHaveAttribute("aria-checked", "false");
});

test("the message buttons still light up under the mouse @desktop", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a phone has no mouse to hover with");
  const convo = await withAPortrait(request);
  await openConversation(page, convo.id);
  await expect(story(page)).toHaveClass(/\bover-backdrop\b/);
  const message = page.locator("[data-message-id]").last();
  const remove = message.getByTitle("Delete from here", { exact: true });
  await remove.hover();
  await expect(remove).toHaveCSS("color", "rgb(217, 106, 95)");
  const copy = message.getByTitle("Copy", { exact: true });
  await copy.hover();
  await expect(copy).toHaveCSS("color", "rgb(236, 229, 218)");
});
