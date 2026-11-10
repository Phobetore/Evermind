import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, makeConversation } from "./fixtures";

/** From a conversation, and from the list of them, the card it is played with is one tap away. */

/** A conversation played as a persona of its own, so that the default persona, which other specs
 *  may leave behind, does not decide what {{user}} reads. Deleted at the end, with its persona. */
async function withPersona(request: APIRequestContext, fields: Record<string, unknown>) {
  const persona = await (await request.post(`${API}/api/personas`, {
    data: { name: "Corvin", description: "Plays the cards in this spec." },
  })).json();
  const character = await makeCharacter(request, fields);
  const convo = await (await request.post(`${API}/api/conversations`, {
    data: { character_id: character.id, persona_id: persona.id },
  })).json();
  const done = async () => {
    await request.delete(`${API}/api/conversations/${convo.id}`);
    await request.delete(`${API}/api/personas/${persona.id}`);
  };
  return { convo: convo as { id: string; character_id: string }, done };
}

test("the avatar at the top of a conversation opens its card in short, and leads to the card and back", async ({ page, request }) => {
  const { convo, done } = await withPersona(request, {
    name: "Ilse",
    tagline: "{{char}} keeps the lighthouse",
    description: "She counts the ships that do not come back, and tells {{user}} their names.",
    tags: ["sea", "night"],
  });
  await page.goto(`/#/chat/${convo.id}`);

  const avatar = page.locator("header").getByRole("button", { name: "About Ilse" });
  await avatar.click();
  const summary = page.getByRole("dialog", { name: "Ilse" });
  await expect(summary.getByText("Character", { exact: true })).toBeVisible();
  // The macros read as they will in the story: {{user}} is the persona this conversation is played as.
  await expect(summary.getByText("Ilse keeps the lighthouse", { exact: true })).toBeVisible();
  await expect(summary.getByText("She counts the ships that do not come back, and tells Corvin their names.")).toBeVisible();
  await expect(summary.getByText("sea", { exact: true })).toBeVisible();
  await expect(summary.getByText("night", { exact: true })).toBeVisible();

  // Closed, it hands the focus back to what opened it.
  await page.keyboard.press("Escape");
  await expect(summary).toBeHidden();
  await expect(avatar).toBeFocused();

  await avatar.click();
  await summary.getByRole("link", { name: "Open the card" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${convo.character_id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Ilse" })).toBeVisible();
  // The tagline reads the same on the card as in the summary.
  await expect(page.getByText("Ilse keeps the lighthouse", { exact: true })).toBeVisible();

  // The way back: the card lists its conversations, this one alone.
  const back = page
    .locator("main section", { has: page.getByRole("heading", { name: "Your conversations" }) })
    .getByRole("button");
  await expect(back).toHaveCount(1);
  await back.click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${convo.id}$`));

  await done();
});

test("the list says which card each conversation is with, and its avatar opens that card in short", async ({ page, request }) => {
  const { convo: ballChat, done } = await withPersona(request, {
    name: "The Masked Ball of the Winter Court",
    kind: "scenario",
    description: "A ball where {{user}} wears a borrowed mask.",
  });
  const ottoChat = await makeConversation(request, { name: "Ottoline Featherstonehaugh-Wyndham" });
  await page.goto("/#/chat");

  const ball = page.locator(`a[href="#/chat/${ballChat.id}"]`);
  const otto = page.locator(`a[href="#/chat/${ottoChat.id}"]`);
  await expect(otto).toBeVisible();
  await expect(ball.getByText("Scenario", { exact: true })).toHaveCount(1);
  await expect(otto.getByText("Scenario", { exact: true })).toHaveCount(0);
  // On a phone the mark is an icon: both names are longer than their line, so the room each one gets is
  // its line's, and the scenario's gives up no more than the icon to it.
  const room = (row: Locator) => row.locator("h2").evaluate((h) => h.clientWidth);
  const [ballRoom, ottoRoom] = [await room(ball), await room(otto)];
  expect(ballRoom, `the scenario's name has ${ballRoom}px, a character's ${ottoRoom}px`).toBeGreaterThanOrEqual(ottoRoom - 36);
  expect(ballRoom).toBeGreaterThan(40);

  // The avatar opens the card in short, as in the conversation's header; the row does not open.
  await ball.getByRole("button", { name: "About The Masked Ball of the Winter Court" }).click();
  const summary = page.getByRole("dialog", { name: "The Masked Ball of the Winter Court" });
  await expect(summary.getByText("Scenario", { exact: true })).toBeVisible();
  await expect(summary.getByText("A ball where Corvin wears a borrowed mask.")).toBeVisible();
  await expect(page).toHaveURL(/#\/chat$/);
  await summary.getByRole("link", { name: "Open the card" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${ballChat.character_id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "The Masked Ball of the Winter Court" })).toBeVisible();

  // The rest of the row still opens the conversation.
  await page.goBack();
  await otto.locator("h2").click();
  await expect(page).toHaveURL(new RegExp(`#/chat/${ottoChat.id}$`));

  await done();
});

test("a one-word name breaks in the summary's title rather than pushing it off a narrow phone", async ({ page, request }) => {
  const convo = await makeConversation(request, { name: "Nachtigallenköniginnenthronsaalwächterin" });
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("header").getByRole("button", { name: /^About / }).click();

  const panel = page.getByRole("dialog").locator(".panel");
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth), "the summary scrolls sideways").toBe(0);
  const close = (await page.getByRole("dialog").getByRole("button", { name: "Close" }).boundingBox())!;
  expect(close.x + close.width, "Close is off the screen").toBeLessThanOrEqual(320);
});
