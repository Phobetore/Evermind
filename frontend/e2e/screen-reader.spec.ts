import { expect, test, type APIRequestContext } from "@playwright/test";
import { API } from "../playwright.config";
import { conversationWithReply, replyEnds } from "./fixtures";

/** What a screen reader is told, which hears nothing of what is only drawn. */

test("a reply that comes in is told", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await page.getByPlaceholder(/^Write to Vane/).fill("And then?");

  const ends = replyEnds(page, convo.id);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await ends;
  await expect(page.getByRole("status")).toHaveText("Vane replied.");
});

test("a reply that fails is told at once", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { failing: true });
  await page.goto(`/#/chat/${convo.id}`);

  const ends = replyEnds(page, convo.id);
  await page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`).getByTitle("Regenerate").click();

  await ends;
  await expect(page.getByRole("alert")).toContainText("The mock was told to fail.");
});

/** As a stopped AI server looks: an address where nothing listens. */
async function noModel(request: APIRequestContext, id: string) {
  const off = await (await request.post(`${API}/api/connections`, {
    data: { name: "off", provider: "openai-compatible", base_url: "http://127.0.0.1:5999/v1", api_key: "x", model: "absent" },
  })).json();
  await request.patch(`${API}/api/conversations/${id}`, { data: { connection_id: off.id } });
}

test("a model that does not answer is told at once", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await noModel(request, convo.id);
  await page.goto(`/#/chat/${convo.id}`);

  const ends = replyEnds(page, convo.id);
  await page.locator(`[data-message-id="${convo.messages.at(-1).id}"]`).getByTitle("Regenerate").click();

  await ends;
  await expect(page.getByRole("alert")).toContainText(/no answer from the model/i);
});

test("the side panel's boxes are named by their titles, not by their examples", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  const opener = page.getByRole("button", { name: "Conversation memory and settings" });
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:has(textarea)");

  await expect(panel.getByRole("textbox", { name: "Scene directive", exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Story summary", exact: true })).toBeVisible();
});

test("what Check now finds is told", async ({ page, request }) => {
  const { current } = await (await request.get(`${API}/api/update`)).json();
  await page.route("https://api.github.com/repos/Phobetore/Evermind/releases/latest", (route) => route.fulfill({
    json: { tag_name: `v${current}`, html_url: "https://github.com/Phobetore/Evermind/releases" },
    headers: { "access-control-allow-origin": "*" },
  }));
  await page.goto("/#/settings");

  await page.getByRole("button", { name: "Check now" }).click();

  await expect(page.getByRole("status")).toHaveText("You are on the newest release.");
});
