import { expect, test } from "@playwright/test";
import { answer as confirmBox, chat, conversation, conversationWithReply, makeConversation } from "./fixtures";

/** What a conversation shows of its messages, and what can be done to them. */

test("a message written on several lines is shown on as many", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await chat(request, {
    conversation_id: convo.id, mode: "send",
    content: "First line\nsecond line.\nAfter a hard break:  \nthe last.",
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
  await reply.getByTitle("Delete from here").click();
  await confirmBox(page, true);
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

test("the arrows of a greeting go through the others and stop at the last, and nothing regenerates it", async ({ page, request }) => {
  const convo = await makeConversation(request, { alternate_greetings: ["The lamp was still warm."] });
  const opening = page.locator(`[data-message-id="${convo.messages[0].id}"]`);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(opening).toContainText("The door was already open.");

  const next = opening.getByRole("button", { name: "Next variant or regenerate" });
  await next.click();
  await expect(opening).toContainText("The lamp was still warm.");
  await expect(opening).toContainText("2/2");
  // A greeting answers nothing: there is no reply to write again.
  await expect(next).toBeDisabled();
  await expect(opening.getByTitle("Regenerate")).toHaveCount(0);
  await expect.poll(async () => (await conversation(request, convo.id)).messages[0].active_index).toBe(1);
});

test("a message whose reply was deleted can be given another", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const [question, answer] = convo.messages.slice(-2);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator(`[data-message-id="${answer.id}"]`).getByTitle("Delete from here").click();
  await confirmBox(page, true);
  await expect(page.locator(`[data-message-id="${answer.id}"]`)).toHaveCount(0);

  await page.locator(`[data-message-id="${question.id}"]`).getByTitle("Regenerate").click();
  await expect.poll(async () => (await conversation(request, convo.id)).messages.at(-1).role,
    { timeout: 30_000 }).toBe("assistant");
  await expect(page.locator("[data-message-id]")).toHaveCount(convo.messages.length);
});

test("only the last hundred messages are drawn, and earlier ones come in above the place being read", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  const many = Array.from({ length: 150 }, (_, i) => ({
    ...convo.messages[0], id: `m${i}`, role: i % 2 ? "assistant" : "user", position: i, meta: {},
    variants: [`Message ${i}`], content: `Message ${i}`, active_index: 0,
  }));
  await page.route(`**/api/conversations/${convo.id}`, (route) => route.fulfill({ json: { ...convo, messages: many } }));
  await page.goto(`/#/chat/${convo.id}`);

  await expect(page.locator("[data-message-id]")).toHaveCount(100);
  await expect(page.locator('[data-message-id="m149"]')).toBeInViewport();
  const earlier = page.getByRole("button", { name: "Show earlier messages" });
  await earlier.scrollIntoViewIfNeeded();
  const place = page.locator('[data-message-id="m50"]');
  const before = (await place.boundingBox())!.y;

  await earlier.click();

  await expect(page.locator("[data-message-id]")).toHaveCount(150);
  await expect(earlier).toHaveCount(0);
  expect(Math.abs((await place.boundingBox())!.y - before), "the place being read was lost").toBeLessThan(2);
});
