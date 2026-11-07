import { expect, test, type APIRequestContext, type Page, type Request, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter, makeConversation } from "./fixtures";

/** What does not go through is said where it was asked for, and what is shown is what
 *  the server holds. */

const offline = (route: Route) => route.abort("internetdisconnected");
const badGateway = { status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" };
const refused = (route: Route) => route.fulfill(badGateway);
/** The server does it, and an error is what comes back. */
const doneButFailed = async (route: Route) => {
  await route.fetch();
  await route.fulfill(badGateway);
};

/** Only what is sent with `method` to `path` fails: reading it again still works. */
function failing(page: Page, method: string, path: string, how: (route: Route) => Promise<void>) {
  return page.route(`**${path}`, (route) =>
    route.request().method() === method ? how(route) : route.continue());
}

const favourite = async (request: APIRequestContext, id: string): Promise<boolean> =>
  (await (await request.get(`${API}/api/characters/${id}`)).json()).is_favorite;

test("the home page that cannot read its cards says so, and reads them again when asked", async ({ page, request }) => {
  const card = await makeCharacter(request, { name: `Read ${Date.now()}` });
  await page.route("**/api/characters", offline);
  await page.goto("/#/");
  await expect(page.locator("main").getByText("Evermind is not answering")).toBeVisible();
  await expect(page.locator("main .animate-pulse-soft"), "cards pulsing for ever").toHaveCount(0);

  await page.unroute("**/api/characters", offline);
  const failure = page.locator("main").getByRole("alert");
  await failure.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("main").getByRole("heading", { name: card.name })).toBeVisible();
  await expect(failure).toHaveCount(0);
});

test("a favourite that is not saved says so on its card, whose star is what the server holds", { tag: "@desktop" }, async ({ page, request }) => {
  const card = await makeCharacter(request, { name: `Star ${Date.now()}` });
  await page.goto("/#/");
  const shown = page.locator("main a", { has: page.getByRole("heading", { name: card.name }) });
  const said = shown.getByRole("alert");
  const star = (name: string) => shown.getByRole("button", { name });

  await failing(page, "PUT", `/api/characters/${card.id}`, offline);
  await star("Add to favorites").click();
  await expect(said).toContainText("Evermind is not answering");
  await expect(said).toBeInViewport();
  await expect(star("Add to favorites")).toBeVisible();
  expect(await favourite(request, card.id)).toBe(false);

  await page.unrouteAll();
  await failing(page, "PUT", `/api/characters/${card.id}`, doneButFailed);
  await star("Add to favorites").click();
  await expect(star("Remove from favorites"), "the star is not what the server holds").toBeVisible();
  await expect(said).toContainText("HTTP 500");
  expect(await favourite(request, card.id)).toBe(true);

  await page.unrouteAll();
  await star("Remove from favorites").click();
  await expect(star("Add to favorites")).toBeVisible();
  await expect(said).toHaveCount(0);
  expect(await favourite(request, card.id)).toBe(false);
});

/** A conversation of its own in the list, under a title of its own. */
async function listed(page: Page, request: APIRequestContext) {
  const convo = await makeConversation(request);
  const title = `Before ${Date.now()}`;
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { title } });
  await page.goto("/#/chat");
  const row = page.locator(`main a[href$="/chat/${convo.id}"]`);
  await expect(row).toContainText(title);
  return { id: convo.id as string, title, row, said: row.getByRole("alert") };
}

const stored = async (request: APIRequestContext, id: string) => request.get(`${API}/api/conversations/${id}`);
const readingTheList = (r: Request) => r.method() === "GET" && r.url().endsWith("/api/conversations");

test("a rename that does not go through says so on its row, which shows the title the server holds", { tag: "@desktop" }, async ({ page, request }) => {
  const { id, title, row, said } = await listed(page, request);
  async function rename(to: string) {
    await row.getByRole("button", { name: "Rename" }).click();
    await row.locator("input").fill(to);
    await row.locator("input").press("Enter");
  }

  // Nothing reaches the server, not even reading the list again.
  await page.route("**/api/**", offline);
  const readAgain = page.waitForEvent("requestfailed", { predicate: readingTheList, timeout: 10_000 });
  await rename("Never sent");
  await expect(said).toContainText("Evermind is not answering");
  await expect(said).toBeInViewport();
  await readAgain;
  await expect(row, "the list went with the failure").toContainText(title);
  expect((await (await stored(request, id)).json()).title).toBe(title);

  // Renamed, and the answer was an error.
  await page.unrouteAll();
  await failing(page, "PATCH", `/api/conversations/${id}`, doneButFailed);
  await rename("After");
  await expect(row, "the title is not what the server holds").toContainText("After");
  await expect(said).toContainText("HTTP 500");
});

test("a removal that does not go through says so on its row, which goes only if the server removed it", { tag: "@desktop" }, async ({ page, request }) => {
  const { id, row, said } = await listed(page, request);
  const remove = async () => {
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Delete" }).click();
  };

  await page.route("**/api/**", offline);
  const readAgain = page.waitForEvent("requestfailed", { predicate: readingTheList, timeout: 10_000 });
  await remove();
  await expect(said).toContainText("Evermind is not answering");
  await expect(said).toBeInViewport();
  await readAgain;
  await expect(row, "the conversation went with the failure").toBeVisible();

  await page.unrouteAll();
  await failing(page, "DELETE", `/api/conversations/${id}`, refused);
  await remove();
  await expect(said).toContainText("HTTP 500");
  await expect(row).toBeVisible();
  expect((await stored(request, id)).ok()).toBe(true);

  await page.unrouteAll();
  await failing(page, "DELETE", `/api/conversations/${id}`, doneButFailed);
  await remove();
  await expect(row, "removed by the server and still listed").toHaveCount(0);
  expect((await stored(request, id)).status()).toBe(404);
});
