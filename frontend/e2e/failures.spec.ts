import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { makeCharacter } from "./fixtures";

/** What does not go through is said where it was asked for, and what is shown is what
 *  the server holds. */

const offline = (route: Route) => route.abort("internetdisconnected");
const badGateway = { status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" };
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
