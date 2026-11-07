import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

/** What a press of Save writes: all of the form, and once, even pressed again after
 *  part of it failed. */

const badGateway = { status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" };

const personas = async (request: APIRequestContext) =>
  (await request.get(`${API}/api/personas`)).json() as Promise<{ id: string; name: string; is_default: boolean }[]>;

test("a new persona whose portrait did not go is made once, and stays the default it was made", async ({ page, request }) => {
  // The first one there is is made the default: saving it again must not undo that.
  for (const p of await personas(request)) await request.delete(`${API}/api/personas/${p.id}`);
  await page.goto("/#/personas");
  await page.getByRole("button", { name: "New persona" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Once");
  await dialog.locator('input[type="file"]').setInputFiles({ name: "me.png", mimeType: "image/png", buffer: PNG });
  await page.route("**/api/personas/*/avatar", (route) => route.fulfill(badGateway));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByText("HTTP 500")).toBeVisible();

  await page.unroute("**/api/personas/*/avatar");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);
  const made = await personas(request);
  expect(made.map((p) => p.name), "the persona was made twice").toEqual(["Once"]);
  expect(made[0].is_default).toBe(true);
  await expect(page.getByRole("heading", { name: "Once" })).toBeVisible();
  await request.delete(`${API}/api/personas/${made[0].id}`);
});

const lore = {
  harbour: "The harbour freezes in winter.", bell: "The bell rings at noon.", gate: "The gate shuts at dusk.",
};

/** An entry of the lorebook, by its keyword. */
const entry = (page: Page, key: string) =>
  page.locator(".rounded-lg", { has: page.getByText(key, { exact: true }) });

async function loreOf(request: APIRequestContext, id: string): Promise<string[]> {
  const card = await (await request.get(`${API}/api/characters/${id}`)).json();
  return card.lore_entries.map((e: { content: string }) => e.content);
}

test("a new card whose portrait did not go is made once, with its lorebook as it was left", async ({ page, request }) => {
  const name = `Once ${Date.now()}`;
  await page.goto("/#/characters/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.locator('input[type="file"]').setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  for (const [key, content] of Object.entries(lore)) {
    await page.getByPlaceholder("Trigger keywords, then Enter").fill(key);
    await page.getByPlaceholder("Trigger keywords, then Enter").press("Enter");
    await page.getByPlaceholder("What the model should know when these words appear…").fill(content);
    await page.getByRole("button", { name: "Add entry" }).click();
  }
  await page.route("**/api/characters/*/avatar", (route) => route.fulfill(badGateway));
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page.getByText("HTTP 500")).toBeVisible();

  // One is rewritten, and one emptied, which takes it out, before saving again.
  await entry(page, "harbour").locator("textarea").fill("The harbour never freezes.");
  await entry(page, "bell").locator("textarea").fill("");
  await page.unroute("**/api/characters/*/avatar");
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page).toHaveURL(/#\/characters\/(?!new$)[^/]+$/);
  const made = (await (await request.get(`${API}/api/characters`)).json())
    .filter((c: { name: string }) => c.name === name);
  expect(made, "the card was made twice").toHaveLength(1);
  expect(made[0].avatar_url).toBeTruthy();
  expect(await loreOf(request, made[0].id)).toEqual(["The harbour never freezes.", "The gate shuts at dusk."]);
});

test("a card's lorebook changes when the card is saved, and not when it is left", async ({ page, request }) => {
  const card = await makeCharacter(request, {
    lore_entries: Object.entries(lore).map(([key, content]) => ({ keys: [key], content })),
  });
  await page.goto(`/#/characters/${card.id}`);
  await page.getByRole("link", { name: "Edit" }).click();
  await entry(page, "gate").getByRole("button", { name: "Delete entry" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${card.id}$`));
  expect(await loreOf(request, card.id)).toEqual(Object.values(lore));

  await page.getByRole("link", { name: "Edit" }).click();
  await entry(page, "harbour").locator("textarea").fill("The harbour never freezes.");
  await entry(page, "bell").locator("textarea").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/characters/${card.id}$`));
  expect(await loreOf(request, card.id)).toEqual(["The harbour never freezes.", "The gate shuts at dusk."]);
});
