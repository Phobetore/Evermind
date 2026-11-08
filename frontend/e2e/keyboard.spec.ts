import { expect, test, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, makeCharacter, makeConversation, PNG } from "./fixtures";

/** From the keyboard: each press leaves the focus on what the next is for, never on the page itself. */

const panelButton = (page: Page) => page.getByRole("button", { name: "Conversation memory and settings" });

const panelOf = (page: Page) => page.locator("aside:has(textarea)");

/** Where the focus is, for a message that says it. */
const focusIn = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "the page";
  return `${el.tagName.toLowerCase()} "${el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent?.trim().slice(0, 30)}"`;
});

async function pressOn(target: Locator, key = "Enter") {
  await target.focus();
  await target.press(key);
}

test("the backdrop's strength is reached at once from the button that shows it, and Done goes back there", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await request.post(`${API}/api/conversations/${convo.id}/wallpaper`, {
    multipart: { file: { name: "backdrop.png", mimeType: "image/png", buffer: PNG } },
  });
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  const opener = panelButton(page);
  const beside = !(await opener.isVisible());
  if (!beside) await opener.click();

  await pressOn(page.getByRole("button", { name: "Adjust strength" }));
  const slider = page.getByRole("slider", { name: "Strength" });
  await expect(slider, `the focus is on ${await focusIn(page)}`).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await conversation(request, convo.id)).wallpaper_opacity).toBeCloseTo(0.26);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Done" })).toBeFocused();
  await page.keyboard.press("Enter");

  // Beside the story, back to what opened it; over it, where the panel is opened from.
  const back = beside ? page.getByRole("button", { name: "Adjust strength" }) : opener;
  await expect(back, `the focus is on ${await focusIn(page)}`).toBeFocused();
});

test("a dialog takes the focus, keeps it, and gives it back to what opened it", { tag: "@desktop" }, async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/");
  const opener = page.getByTitle("Starter library");
  const dialog = page.getByRole("dialog");
  // Past its last control, Tab may leave for the browser's own, never for the page behind.
  const where = () => dialog.evaluate((box) => box.contains(document.activeElement) ? "dialog"
    : document.activeElement === document.body ? "browser" : "page");

  for (const close of ["the X", "Escape"]) {
    await pressOn(opener);
    await expect(dialog.locator("h3").first()).toBeVisible();
    expect(await where(), `opened, the focus is on ${await focusIn(page)}`).toBe("dialog");
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      seen.add(await where());
      expect(seen, `after ${i + 1} Tabs the focus is on ${await focusIn(page)}`).not.toContain("page");
    }
    expect(seen, "Tab never came back into the dialog").toContain("dialog");
    if (close === "the X") await pressOn(dialog.getByRole("button", { name: "Close" }));
    else await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener, `closed with ${close}, the focus is on ${await focusIn(page)}`).toBeFocused();
  }
});

test("the side panel opened from the keyboard takes the focus, and gives it back when it closes", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  const close = panelOf(page).getByRole("button", { name: "Close panel" });
  // Open beside the story on a computer: closed from its X, the focus goes to what opens it.
  if (await close.isVisible()) {
    await pressOn(close);
    await expect(panelOf(page)).toHaveCount(0);
    await expect(panelButton(page), `the focus is on ${await focusIn(page)}`).toBeFocused();
  }

  await pressOn(panelButton(page));
  await expect(close, `the focus is on ${await focusIn(page)}`).toBeFocused();
  await page.keyboard.press("Escape");

  await expect(panelOf(page)).toHaveCount(0);
  await expect(panelButton(page), `the focus is on ${await focusIn(page)}`).toBeFocused();
});

test("over the story, the side panel keeps Tab to itself", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto(`/#/chat/${convo.id}`);
  await pressOn(panelButton(page));
  await expect(panelOf(page).getByRole("button", { name: "Close panel" })).toBeFocused();

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const under = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el && el !== document.body && !el.closest("aside") && !el.matches('a[href="#main"]');
    });
    expect(under, `Tab ${i + 1} went under the panel, to ${await focusIn(page)}`).toBe(false);
  }
});

test("a card's Start button is seen when the keyboard reaches it", { tag: "@desktop" }, async ({ page, request, isMobile }) => {
  test.skip(isMobile, "a phone has no Start button on a card, which opens the card");
  const character = await makeCharacter(request, { name: "Reached By Keyboard" });
  await page.goto("/");
  const card = page.locator(`a[href$="/characters/${character.id}"]`);
  await card.focus();
  const start = card.getByRole("button", { name: "Start" });
  // The star comes first, then Start.
  for (let i = 0; i < 2; i++) await page.keyboard.press("Tab");

  await expect(start).toBeFocused();
  await expect.poll(() => start.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
});

test("the tag box shows when the keyboard is in it", { tag: "@desktop" }, async ({ page }) => {
  await page.goto("/#/characters/new");
  const box = page.getByPlaceholder("Add a tag, then Enter");
  const field = box.locator("xpath=..");
  const ring = () => field.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(await ring()).toBe("none");

  await box.focus();

  await expect.poll(ring, "nothing shows where the keyboard is").not.toBe("none");
});

test("Regenerate from the keyboard leaves the focus on Stop while the reply is written, then back on Regenerate", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request, { says: "again", slowly: true });
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);

  await pressOn(reply.getByTitle("Regenerate"));

  await expect(page.getByTitle("Stop generation"), `the focus is on ${await focusIn(page)}`).toBeFocused();
  await expect(reply).toContainText("endagain", { timeout: 30_000 });
  await expect(reply.getByTitle("Regenerate"), `the focus is on ${await focusIn(page)}`).toBeFocused();
});

test("an arrow that its swipe disables hands the focus to the other", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await makeConversation(request, { alternate_greetings: ["The lamp was still warm."] });
  const opening = page.locator(`[data-message-id="${convo.messages[0].id}"]`);
  await page.goto(`/#/chat/${convo.id}`);

  await pressOn(opening.getByRole("button", { name: "Next variant or regenerate" }));
  await expect(opening).toContainText("2/2");
  await expect(opening.getByRole("button", { name: "Previous variant" }), `the focus is on ${await focusIn(page)}`).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(opening).toContainText("1/2");
  await expect(opening.getByRole("button", { name: "Next variant or regenerate" }), `the focus is on ${await focusIn(page)}`).toBeFocused();
});

test("a message's rewrite is left with Escape or saved with Ctrl+Enter, and the focus goes back to Edit", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const said = convo.messages.at(-1);
  const reply = page.locator(`[data-message-id="${said.id}"]`);
  const editor = reply.locator("textarea");
  await page.goto(`/#/chat/${convo.id}`);

  await pressOn(reply.getByTitle("Edit"));
  await expect(editor).toBeFocused();
  await page.keyboard.type(" Not kept.");
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(reply.getByTitle("Edit"), `the focus is on ${await focusIn(page)}`).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(editor).toBeFocused();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Kept.");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveCount(0);
  await expect(reply.getByTitle("Edit"), `the focus is on ${await focusIn(page)}`).toBeFocused();
  expect((await conversation(request, convo.id)).messages.at(-1).content).toBe(`${said.content} Kept.`);
});

test("renaming the conversation from the keyboard leaves the focus on its title", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  const title = page.getByTitle("Rename conversation");

  await pressOn(title);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Renamed by keyboard");
  await page.keyboard.press("Enter");
  await expect(title).toHaveText("Renamed by keyboard");
  await expect(title, `the focus is on ${await focusIn(page)}`).toBeFocused();

  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(title, `the focus is on ${await focusIn(page)}`).toBeFocused();
});
