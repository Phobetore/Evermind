import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
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

test("the pen writes under a message whose answer was lost, which alone leaves the box once it is known to have arrived", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const { text: suggestion } = await (await request.post(`${API}/api/conversations/${convo.id}/impersonate`)).json();
  await page.goto(`/#/chat/${convo.id}`);
  const box = page.locator("textarea").first();
  await expect(box).toBeVisible();
  // The message gets there and its answer does not, and the page hears nothing of how things
  // stand until the test says so.
  await page.route("**/api/chat", async (route) => {
    await route.fetch();
    await route.abort("connectionreset");
  });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/turn", async (route) => {
    await released;
    await route.continue();
  });
  await box.fill("Passe donc.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator("p.text-blood").first()).toBeVisible({ timeout: 20_000 });
  await expect(box, "there is no telling yet, so it is kept").toHaveValue("Passe donc.");

  const pen = page.getByTitle("Write my reply for me (editable before sending)");
  for (let press = 1; press <= 2; press++) {
    const answered = page.waitForResponse((r) => r.url().endsWith("/impersonate"));
    await pen.click();
    await (await answered).finished();
    await expect(pen).toBeEnabled();
    // A second press replaces the suggestion it made, and nothing else.
    await expect(box, `after press ${press}`).toHaveValue(`Passe donc.
${suggestion}`);
  }

  release();
  await expect(box, "the message stayed to be sent twice, or took the suggestion with it")
    .toHaveValue(suggestion, { timeout: 15_000 });
  const said = (await conversation(request, convo.id)).messages.filter((m: { content: string }) => m.content === "Passe donc.");
  expect(said).toHaveLength(1);
});

test("a suggestion sent as it was and refused is the person's message, which the pen keeps", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const { text: suggestion } = await (await request.post(`${API}/api/conversations/${convo.id}/impersonate`)).json();
  await page.goto(`/#/chat/${convo.id}`);
  const box = page.locator("textarea").first();
  const pen = page.getByTitle("Write my reply for me (editable before sending)");
  await pen.click();
  await expect(box).toHaveValue(suggestion);
  await page.route("**/api/chat", (route) =>
    route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" }));
  await page.locator('button[title="Send"]').click();
  await expect(page.locator("p.text-blood").first()).toBeVisible({ timeout: 20_000 });
  await expect(box, "the refused message went").toHaveValue(suggestion);

  await page.route("**/impersonate", (route) => route.fulfill({ json: { text: "Another line." } }));
  await pen.click();
  await expect(box, "the refused message was written over").toHaveValue(`${suggestion}
Another line.`);
});
