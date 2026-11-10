import { expect, test } from "@playwright/test";
import { makeConversation } from "./fixtures";

/** From a conversation, and from the list of them, the card it is played with is one tap away. */

test("the header of a conversation opens its card in short, and leads to the whole card", async ({ page, request }) => {
  const conversation = await makeConversation(request, {
    name: "Ilse",
    tagline: "{{char}} keeps the lighthouse",
    description: "She counts the ships that do not come back.",
    tags: ["sea", "night"],
  });
  await page.goto(`/#/chat/${conversation.id}`);

  // The avatar in the header, as in a messaging app.
  const avatar = page.getByRole("button", { name: "About Ilse" });
  await avatar.click();
  const summary = page.getByRole("dialog", { name: "Ilse" });
  await expect(summary).toBeVisible();
  await expect(summary.getByText("Character", { exact: true })).toBeVisible();
  // The macros are shown as they read, not as typed.
  await expect(summary.getByText("Ilse keeps the lighthouse")).toBeVisible();
  await expect(summary.getByText("She counts the ships that do not come back.")).toBeVisible();
  await expect(summary.getByText("night")).toBeVisible();

  // Closed, it hands the focus back to what opened it.
  await page.keyboard.press("Escape");
  await expect(summary).toBeHidden();
  await expect(avatar).toBeFocused();

  await avatar.click();
  await summary.getByRole("link", { name: "Open the card" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${conversation.character_id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Ilse" })).toBeVisible();
  // The way back: the card lists its conversations.
  await expect(page.getByRole("heading", { name: "Your conversations" })).toBeVisible();
});

test("the list of conversations says which card each one is with, and leads to it", async ({ page, request }) => {
  const scenario = await makeConversation(request, { name: "The Masked Ball", kind: "scenario" });
  const character = await makeConversation(request, { name: "Ottoline" });
  await page.goto("/#/chat");

  const ball = page.locator(`a[href="#/chat/${scenario.id}"]`);
  const otto = page.locator(`a[href="#/chat/${character.id}"]`);
  await expect(ball.getByText("Scenario", { exact: true })).toBeVisible();
  await expect(otto.getByText("Scenario", { exact: true })).toHaveCount(0);

  // The avatar opens the card in short, as in the conversation's header; the rest of the row still
  // opens the conversation.
  await ball.getByRole("button", { name: "About The Masked Ball" }).click();
  const summary = page.getByRole("dialog", { name: "The Masked Ball" });
  await expect(summary.getByText("Scenario", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/chat$/);
  await summary.getByRole("link", { name: "Open the card" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${scenario.character_id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "The Masked Ball" })).toBeVisible();

  await page.goBack();
  await otto.click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${character.id}$`));
});
