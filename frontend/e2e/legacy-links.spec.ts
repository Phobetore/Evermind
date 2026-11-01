import { expect, test } from "@playwright/test";
import { makeConversation } from "./fixtures";

/**
 * Before the interface moved to hash routes a page was an address of its own,
 * and people bookmarked them, phones included. The server sends those old
 * addresses to the new ones.
 */
test("an old conversation bookmark still opens the conversation", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.goto(`/chat/${convo.id}`);

  await expect(page).toHaveURL(new RegExp(`#/chat/${convo.id}$`));
  await expect(page.getByText("The door was already open.")).toBeVisible();
});

test("an old new-card link still opens the form", async ({ page }) => {
  await page.goto("/characters/new");

  await expect(page).toHaveURL(/#\/characters\/new$/);
  await expect(page.getByRole("heading", { name: /new card/i })).toBeVisible();
});
