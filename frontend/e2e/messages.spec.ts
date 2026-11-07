import { expect, test } from "@playwright/test";
import { API } from "../playwright.config";
import { makeConversation } from "./fixtures";

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
