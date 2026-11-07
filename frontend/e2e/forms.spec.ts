import { expect, test, type APIRequestContext } from "@playwright/test";
import { API } from "../playwright.config";
import { PNG } from "./fixtures";

/** A save that does several things, one of which fails, is pressed again. What the
 *  first press made is not made a second time. */

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

test("a new card whose lore did not all go is made once, with its entries as they were left", async ({ page, request }) => {
  const name = `Once ${Date.now()}`;
  await page.goto("/#/characters/new");
  await page.getByLabel("Name", { exact: true }).fill(name);
  const lore = {
    harbour: "The harbour freezes in winter.", bell: "The bell rings at noon.", gate: "The gate shuts at dusk.",
  };
  for (const [key, content] of Object.entries(lore)) {
    await page.getByPlaceholder("Trigger keywords, then Enter").fill(key);
    await page.getByPlaceholder("Trigger keywords, then Enter").press("Enter");
    await page.getByPlaceholder("What the model should know when these words appear…").fill(content);
    await page.getByRole("button", { name: "Add entry" }).click();
  }
  let posted = 0;
  await page.route("**/api/characters/*/lore", (route) =>
    ++posted === 3 ? route.fulfill(badGateway) : route.continue());
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page.getByText("HTTP 500")).toBeVisible();

  // Two have gone already: one is rewritten and the other taken out before saving again.
  const entry = (key: string) => page.locator(".rounded-lg", { has: page.getByText(key, { exact: true }) });
  await entry("harbour").locator("textarea").fill("The harbour never freezes.");
  await entry("harbour").locator("textarea").blur();
  await entry("bell").getByRole("button", { name: "Delete entry" }).click();
  await page.unroute("**/api/characters/*/lore");
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page).toHaveURL(/#\/characters\/(?!new$)[^/]+$/);
  const made = (await (await request.get(`${API}/api/characters`)).json())
    .filter((c: { name: string }) => c.name === name);
  expect(made, "the card was made twice").toHaveLength(1);
  const entries = await (await request.get(`${API}/api/characters/${made[0].id}/lore`)).json();
  expect(entries.map((e: { content: string }) => e.content).sort())
    .toEqual(["The gate shuts at dusk.", "The harbour never freezes."]);
});
