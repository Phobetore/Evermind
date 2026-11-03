import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/**
 * The persona a conversation is played as is the one marked on the Personas page.
 * The list in Settings is another way of marking it, and "None" takes the mark
 * away. A choice has to hold after a reload, "None" included, and the greeting
 * of a new conversation has to name the player the way the Personas page says.
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

const defaultPersona = (page: Page) => page.getByLabel("Default persona");

/** What a list shows as chosen, in words. While the personas are still coming it
 *  says "Loading…", so this is also what tells that they have come. */
const shownAs = (select: ReturnType<typeof defaultPersona>) => select.locator("option:checked");

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

  // Not before the list has come: until then "None" is not what is stored.
  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toHaveValue(owen.id);
  await defaultPersona(page).selectOption({ label: "None" });
  await expect.poll(() => marked(request)).toEqual([]);
  await page.reload();
  await expect(shownAs(defaultPersona(page))).toHaveText("None");

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

  // Offered before anyone touches it, and named in the greeting. With a persona
  // marked, "No persona" is not offered: it would get that persona all the same.
  const withOwen = await startWindow();
  await expect(withOwen.locator("option")).toHaveText(["Owen", "Mara"]);
  await expect(withOwen).toHaveValue(owen.id);
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, Owen.");

  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toHaveValue(owen.id);
  await defaultPersona(page).selectOption({ label: "None" });
  await expect.poll(() => marked(request)).toEqual([]);

  const withNone = await startWindow();
  await expect(withNone.locator("option")).toHaveText(["No persona", "Mara", "Owen"]);
  await expect(withNone).toHaveValue("");
  await page.getByRole("button", { name: "Enter the story" }).click();
  await expect(opening).toContainText("Welcome, User.");
});

// A phone on a slow connection: the list of personas is the last to arrive.
async function slowPersonaList(page: Page) {
  await page.route("**/api/personas", async (route) => {
    if (route.request().method() === "GET") await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
}

test("Settings does not offer None before it knows which persona is marked", async ({
  page, request,
}) => {
  const mara = await makePersona(request, "Mara");
  await makePersona(request, "Owen");
  await slowPersonaList(page);

  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toBeVisible();
  await expect(defaultPersona(page)).toBeDisabled();
  await expect(shownAs(defaultPersona(page))).toHaveText("Loading…");

  await expect(defaultPersona(page)).toBeEnabled();
  await expect(defaultPersona(page)).toHaveValue(mara.id);
  expect(await marked(request)).toEqual(["Mara"]);
});

test("None chosen as soon as Settings opens still takes the mark away", async ({
  page, request,
}) => {
  await makePersona(request, "Mara");
  await slowPersonaList(page);

  await page.goto("/#/settings");
  // Before the list has come: what was chosen must not be lost to a list that
  // already shows "None" for a persona that is marked.
  await defaultPersona(page).selectOption({ label: "None" });

  await expect.poll(() => marked(request)).toEqual([]);
});

test("choosing the default persona leaves a name and description changed elsewhere as they are", async ({
  page, request,
}) => {
  const mara = await makePersona(request, "Mara");
  await makePersona(request, "Owen");
  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toHaveValue(mara.id);

  // From the computer, while this page stays open on the phone.
  await request.put(`${API}/api/personas/${mara.id}`, {
    data: { name: "Mara Renamed", description: "Written elsewhere." },
  });
  await defaultPersona(page).selectOption({ label: "None" });
  await expect.poll(() => marked(request)).toEqual([]);

  const kept = (await personas(request)).find((p) => p.id === mara.id);
  expect(kept).toMatchObject({ name: "Mara Renamed", description: "Written elsewhere." });
});

test("a choice the server refuses is said, and the list goes back to what is stored", async ({
  page, request,
}) => {
  const mara = await makePersona(request, "Mara");
  await makePersona(request, "Owen");
  await page.route("**/api/personas/*", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    return route.fulfill({
      status: 404, json: { error: "Persona not found.", kind: "not_found", resource: "persona" },
    });
  });
  await page.goto("/#/settings");
  await expect(defaultPersona(page)).toHaveValue(mara.id);

  await defaultPersona(page).selectOption({ label: "Owen" });

  await expect(page.locator("main").getByRole("alert")).toHaveText("This persona no longer exists.");
  await expect(defaultPersona(page)).toBeEnabled();
  await expect(defaultPersona(page)).toHaveValue(mara.id);
  expect(await marked(request)).toEqual(["Mara"]);
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
    // Once the connections are in the list, which is not the case at first: until
    // then the list holds "First available" whatever is stored.
    await expect(connection.locator("option", { hasText: "e2e" })).toHaveCount(1);
    await expect(connection).toHaveValue("");
  } finally {
    // The other tests are written for a suite that has one.
    await request.put(`${API}/api/settings`, { data: { default_connection_id: chosen } });
  }
});
