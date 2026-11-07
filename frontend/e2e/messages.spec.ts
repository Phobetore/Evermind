import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { conversation, conversationWithReply, makeConversation } from "./fixtures";

/** What a conversation shows of its messages, and what can be done to them. */

test("a message written on several lines is shown on as many", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: {
      conversation_id: convo.id, mode: "send", message_mode: "say",
      content: "First line\nsecond line.\nAfter a hard break:  \nthe last.",
    },
    timeout: 60_000,
  });
  await page.goto(`/#/chat/${convo.id}`);

  const text = page.locator("[data-message-id] .rp-prose", { hasText: "First line" });
  await expect(text).toBeVisible();
  // One line for each, and a hard break no blank line.
  expect(await text.innerText())
    .toBe("First line\nsecond line.\nAfter a hard break:\nthe last.");
});

test("what the server does not take of a change to a message is said, and a rewrite is kept", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const reply = page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(reply).toBeVisible();

  await page.route("**/api/messages/*", (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" }));
  await reply.getByTitle("Edit").click();
  const editor = reply.locator("textarea");
  await editor.fill("Rewritten, and not yet saved.");
  await reply.getByRole("button", { name: "Save" }).click();

  const said = page.getByRole("alert").filter({ hasText: "HTTP 500" });
  await expect(said).toBeVisible();
  await expect(editor, "the rewrite went").toHaveValue("Rewritten, and not yet saved.");
  // Not the reply's banner: its Retry would ask for another reply.
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

  await reply.getByRole("button", { name: "Cancel" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await reply.getByTitle("Delete from here").click();
  await expect(said).toBeVisible();
  await expect(reply).toBeVisible();

  await page.unroute("**/api/messages/*");
  await reply.getByTitle("Edit").click();
  await editor.fill("Rewritten.");
  await reply.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);
  await expect(reply).toContainText("Rewritten.");
  await expect(said).toHaveCount(0);
});

test("a message whose reply was deleted can be given another", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const [question, answer] = convo.messages.slice(-2);
  await page.goto(`/#/chat/${convo.id}`);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(`[data-message-id="${answer.id}"]`).getByTitle("Delete from here").click();
  await expect(page.locator(`[data-message-id="${answer.id}"]`)).toHaveCount(0);

  await page.locator(`[data-message-id="${question.id}"]`).getByTitle("Regenerate").click();
  await expect.poll(async () => (await conversation(request, convo.id)).messages.at(-1).role,
    { timeout: 30_000 }).toBe("assistant");
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length);
});
