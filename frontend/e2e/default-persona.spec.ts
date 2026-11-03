import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/**
 * The persona a conversation is played as is the one marked on the Personas page.
 * The list in Settings is another way of marking it, and "None" takes the mark
 * away. A choice has to hold after a reload, "None" included, and the greeting
 * of a new conversation has to name the player the way the Personas page says.
 */

type Persona = { id: string; name: string; is_default: boolean };

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

const defaultPersona = (page: Page) => page.getByLabel("Default persona");

/** The card of a persona on the Personas page. */
const card = (page: Page, name: string) =>
  page.locator("main button", { has: page.getByRole("heading", { name }) });

test("the default persona chosen in Settings holds after a reload, and None takes it back", async ({
  page, request,
}) => {
  const mara = await makePersona(request, "Mara");
  const owen = await makePersona(request, "Owen");
  expect(await marked(request), "the first persona made was not marked").toEqual(["Mara"]);

  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toHaveValue(mara.id);

  await defaultPersona(page).selectOption({ label: "Owen" });
  await expect.poll(() => marked(request)).toEqual(["Owen"]);
  await page.reload();
  await expect(defaultPersona(page)).toHaveValue(owen.id);

  // The Personas page says the same.
  await page.goto("/#/personas");
  await expect(card(page, "Owen")).toContainText("Default");
  await expect(card(page, "Mara")).not.toContainText("Default");

  await page.goto("/#/settings");
  await defaultPersona(page).selectOption({ label: "None" });
  await expect.poll(() => marked(request)).toEqual([]);
  await page.reload();
  await expect(defaultPersona(page)).toHaveValue("");

  await page.goto("/#/personas");
  await expect(card(page, "Owen")).toBeVisible();
  await expect(page.locator("main").getByText("Default", { exact: true })).toHaveCount(0);
});

test("a new conversation greets the persona that is the default, or User when there is none", async ({
  page, request,
}) => {
  await makePersona(request, "Mara");
  const owen = await makePersona(request, "Owen");
  const character = await makeCharacter(request, { name: "Greeter", greeting: "Welcome, {{user}}." });

  /** The window that starts a conversation, with the persona it offers. */
  async function startWindow() {
    await page.goto(`/#/characters/${character.id}`);
    await page.getByRole("button", { name: "Start a conversation" }).click();
    return page.getByLabel("You are playing as");
  }
  const opening = page.locator("[data-message-id]").first();

  await page.goto("/#/settings");
  await defaultPersona(page).selectOption({ label: "Owen" });
  await expect.poll(() => marked(request)).toEqual(["Owen"]);

  // Offered before anyone touches it, and named in the greeting.
  await expect(await startWindow()).toHaveValue(owen.id);
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, Owen.");

  await page.goto("/#/settings");
  await defaultPersona(page).selectOption({ label: "None" });
  await expect.poll(() => marked(request)).toEqual([]);

  await expect(await startWindow()).toHaveValue("");
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, User.");
});

test("Default connection can be put back to First available, and stays there after a reload", async ({
  page, request,
}) => {
  // Makes the connection of the suite, and the default of it.
  await makeCharacter(request);
  const settings = async () => (await request.get(`${API}/api/settings`)).json();
  const chosen = (await settings()).default_connection_id;
  expect(chosen, "the suite has no default connection to take back").toBeTruthy();

  try {
    await page.goto("/#/settings");
    const connection = page.getByLabel("Default connection");
    await expect(connection).toHaveValue(chosen);

    await connection.selectOption({ label: "First available" });
    await expect.poll(async () => (await settings()).default_connection_id).toBeNull();
    await page.reload();
    await expect(connection).toHaveValue("");
  } finally {
    // The other tests are written for a suite that has one.
    await request.put(`${API}/api/settings`, { data: { default_connection_id: chosen } });
  }
});
