import { expect, test, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, PNG } from "./fixtures";

/**
 * Everything here is done from the keyboard, as on a computer: wherever a key press sends the
 * focus, it lands on what the next press is meant for, in sight, and never on the page itself,
 * which a screen reader reads as nothing.
 */

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
