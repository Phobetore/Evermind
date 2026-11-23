import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, conversation, makeConversation } from "./fixtures";

/** A memory that stopped growing is told on the conversation's header, where a person on a phone
 *  looks, and not only in the panel that says why, which they rarely open. */

const MARK = "This conversation's memory could not be updated";
const OPENER = "Conversation memory and settings";

/** A conversation whose automatic memory pass has failed: the first message holds the words that make
 *  the fake model refuse every memory pass that reads them, and the pass comes after eight replies. */
async function forgetting(request: APIRequestContext) {
  const convo = await makeConversation(request);
  for (let n = 1; n <= 8; n++) {
    const content = n === 1 ? "Tell me. MOCK_FORGETS" : `Question ${n}.`;
    expect((await chat(request, { conversation_id: convo.id, mode: "send", content })).ok()).toBe(true);
  }
  await expect.poll(async () => (await conversation(request, convo.id)).memory_error?.error ?? null, {
    message: "the automatic memory pass did not fail",
    timeout: 20_000,
  }).toBe("The mock was told to forget.");
  return convo.id as string;
}

/** The words that fail the pass, taken out of the first message: the next pass reads it and works. */
async function remembering(request: APIRequestContext, id: string) {
  const { messages } = await conversation(request, id);
  const first = messages.find((m: { variants: string[] }) => m.variants.some((v) => v.includes("MOCK_FORGETS")));
  const edited = await request.patch(`${API}/api/messages/${first.id}`, { data: { content: "Tell me." } });
  expect(edited.ok()).toBe(true);
}

/** The conversation, with its side panel closed: on a wide screen it opens by itself. */
async function openClosed(page: Page, id: string) {
  await page.goto(`/#/chat/${id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const close = page.getByRole("button", { name: "Close panel" });
  if (await close.isVisible()) await close.click();
  return page.getByRole("button", { name: OPENER });
}

test("a memory pass that failed marks the header's button, the panel says why and tries again, and the mark goes", { tag: "@desktop" }, async ({ page, request }) => {
  const id = await forgetting(request);
  const opener = await openClosed(page, id);
  await expect(page.getByRole("img", { name: MARK })).toBeVisible();
  // What a screen reader says of the button it reaches.
  await expect(opener).toHaveAccessibleDescription(MARK);

  await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel.locator("p.text-blood")).toHaveText("The model reported an error: The mock was told to forget.");
  const again = panel.getByRole("button", { name: "Try again", exact: true });
  await expect(again).toBeVisible();

  await remembering(request, id);
  const passed = page.waitForResponse((r) => r.url().endsWith("/memories/extract"));
  await again.click();
  expect((await passed).ok()).toBe(true);
  await expect(panel.locator("p.text-blood")).toHaveCount(0);
  await expect(again).toHaveCount(0);

  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(opener).toBeVisible();
  await expect(page.getByRole("img", { name: MARK })).toHaveCount(0);
  await expect(opener).toHaveAccessibleDescription("");
  expect((await conversation(request, id)).memory_error).toBeNull();

  // Opened again, the page finds nothing to mark.
  await page.reload();
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.getByRole("img", { name: MARK })).toHaveCount(0);
});

test("at 320px the mark neither grows nor wraps the header", { tag: "@desktop" }, async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const id = await forgetting(request);
  await openClosed(page, id);
  const mark = page.getByRole("img", { name: MARK });
  await expect(mark).toBeVisible();
  const header = page.locator("main header");
  const marked = (await header.boundingBox())!;
  const button = (await page.getByRole("button", { name: OPENER }).boundingBox())!;
  const dot = (await mark.boundingBox())!;
  expect(button.x + button.width).toBeLessThanOrEqual(320);
  // On the button, not beside it.
  expect(dot.x).toBeGreaterThanOrEqual(button.x);
  expect(dot.x + dot.width).toBeLessThanOrEqual(button.x + button.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);

  // The same header without it.
  await page.route(`**/api/conversations/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), memory_error: null } });
  });
  await page.reload();
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(mark).toHaveCount(0);
  const bare = (await header.boundingBox())!;
  expect(marked.height).toBe(bare.height);
});
