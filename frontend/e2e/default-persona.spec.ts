import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/**
 * The persona a conversation is played as is the one ticked on the Personas page,
 * and the greeting of a new conversation names the player the way that page says.
 */

type Persona = { id: string; name: string; description: string; is_default: boolean };

async function makePersona(request: APIRequestContext, name: string): Promise<Persona> {
  return (await request.post(`${API}/api/personas`, { data: { name, description: "" } })).json();
}

async function personas(request: APIRequestContext): Promise<Persona[]> {
  return (await request.get(`${API}/api/personas`)).json();
}

/** The names of the personas that are marked, which is at most one. */
async function marked(request: APIRequestContext): Promise<string[]> {
  return (await personas(request)).filter((p) => p.is_default).map((p) => p.name);
}

// The servers are shared by the whole suite and the first persona made is marked,
// so each test starts with none and leaves none.
async function noPersonas(request: APIRequestContext) {
  for (const p of await personas(request)) await request.delete(`${API}/api/personas/${p.id}`);
}

test.beforeEach(async ({ request }) => noPersonas(request));
test.afterEach(async ({ request }) => noPersonas(request));

/** The card of a persona on the Personas page. */
const card = (page: Page, name: string) =>
  page.locator("main button", { has: page.getByRole("heading", { name }) });

test("a new conversation greets the persona ticked as the default, or User when none is", async ({
  page, request,
}) => {
  await makePersona(request, "Mara");
  const owen = await makePersona(request, "Owen");
  const character = await makeCharacter(request, { name: "Greeter", greeting: "Welcome, {{user}}." });

  async function tick(name: string, checked: boolean) {
    await page.goto("/#/personas");
    await card(page, name).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Use by default in new conversations").setChecked(checked);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
  }

  /** The window that starts a conversation, with the persona it offers. */
  async function startWindow() {
    await page.goto(`/#/characters/${character.id}`);
    await page.getByRole("button", { name: "Start a conversation" }).click();
    return page.getByLabel("You are playing as");
  }
  const opening = page.locator("[data-message-id]").first();

  await tick("Owen", true);
  await expect.poll(() => marked(request)).toEqual(["Owen"]);
  await expect(card(page, "Owen")).toContainText("Default");
  await expect(card(page, "Mara")).not.toContainText("Default");

  // Offered before anyone touches it, and named in the greeting. With a persona
  // marked, "No persona" is not offered: it would get that persona all the same.
  const withOwen = await startWindow();
  await expect(withOwen.locator("option")).toHaveText(["Owen", "Mara"]);
  await expect(withOwen).toHaveValue(owen.id);
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, Owen.");

  await tick("Owen", false);
  await expect.poll(() => marked(request)).toEqual([]);

  const withNone = await startWindow();
  await expect(withNone.locator("option")).toHaveText(["No persona", "Mara", "Owen"]);
  await expect(withNone).toHaveValue("");
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, User.");
});

test("when the personas cannot be had, the start window says so and cannot start until it can", async ({
  page, request,
}) => {
  const mara = await makePersona(request, "Mara");
  const character = await makeCharacter(request, { name: "Greeter" });
  let reachable = false;
  await page.route("**/api/personas", (route) => (reachable ? route.continue() : route.abort()));

  await page.goto(`/#/characters/${character.id}`);
  await page.getByRole("button", { name: "Start a conversation" }).click();

  // Not an empty list: a conversation started now would be played as Mara all the same.
  await expect(page.getByRole("alert")).toHaveText("Evermind is not answering. Is it still running?");
  await expect(page.getByRole("button", { name: "Enter the story" })).toBeDisabled();
  await expect(page.getByLabel("You are playing as")).toHaveCount(0);

  reachable = true;
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("You are playing as")).toHaveValue(mara.id);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter the story" })).toBeEnabled();
});
