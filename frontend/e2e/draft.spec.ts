import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { retryButton } from "./connection";
import { conversation, conversationWithReply, makeConversation } from "./fixtures";

/** A half-written message is kept in the browser, per conversation, and comes
 *  back when the page does: the phone's browser reloads a tab it had to free
 *  memory from, and what was typed must not go with it. */
test("an unsent message is still there when the page comes back", async ({ page, request }) => {
  const first = await makeConversation(request);
  const second = await makeConversation(request);
  await page.goto(`/#/chat/${first.id}`);

  // Kept as it is typed: the page can be gone the moment after.
  await page.locator("textarea").first().fill("I was about to say");

  await page.reload();
  await expect(page.locator("textarea").first()).toHaveValue("I was about to say");
  await expect(page.getByText("Draft restored")).toBeVisible();

  // The draft belongs to its conversation.
  await page.goto(`/#/chat/${second.id}`);
  await expect(page.locator("textarea").first()).toHaveValue("");
  await page.goto(`/#/chat/${first.id}`);
  await expect(page.locator("textarea").first()).toHaveValue("I was about to say");
});

test("the notice about a restored draft goes away by itself", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Hold on");

  await page.reload();
  await expect(page.getByText("Draft restored")).toBeVisible();
  await expect(page.getByText("Draft restored")).toBeHidden({ timeout: 8000 });
  await expect(page.locator("textarea").first()).toHaveValue("Hold on");
});

test("the pen writes under what the box holds, and a message given back to it still goes", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const { text: suggestion } = await (await request.post(`${API}/api/conversations/${convo.id}/impersonate`)).json();
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }));
  await page.goto(`/#/chat/${convo.id}`);
  const box = page.locator("textarea").first();
  await box.fill("Passe donc.");
  await page.locator('button[title="Send"]').click();
  await expect(box, "the refused message did not come back").toHaveValue("Passe donc.", { timeout: 20_000 });
  await page.unroute("**/api/chat");

  const pen = page.getByTitle("Write my reply for me (editable before sending)");
  for (let press = 1; press <= 2; press++) {
    const answered = page.waitForResponse((r) => r.url().endsWith("/impersonate"));
    await pen.click();
    await (await answered).finished();
    await expect(pen).toBeEnabled();
    // A second press replaces the suggestion it made, and nothing else.
    await expect(box, `after press ${press}`).toHaveValue(`Passe donc.\n${suggestion}`);
  }

  await retryButton(page).click();
  await expect.poll(async () => (await conversation(request, convo.id)).messages.length,
    { timeout: 30_000 }).toBe(convo.messages.length + 2);
  expect((await conversation(request, convo.id)).messages.at(-2).content).toBe("Passe donc.");
  await expect(box).toHaveValue(suggestion);
});
