import { expect, test } from "@playwright/test";
import { makeCharacter } from "./fixtures";

test("the skip link focuses the content without changing the route", async ({ page }) => {
  // Not the home page: an address the router cannot make sense of falls back
  // to the home page, which would hide the route having changed.
  await page.goto("/#/personas");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const before = page.url();

  // The skip link is the first stop of the page.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: /skip to content/i })).toBeFocused();
  await page.keyboard.press("Enter");

  // It points at "#main", which in a hash router would be a route of its own.
  await expect(page.locator("#main")).toBeFocused();
  expect(page.url()).toBe(before);
});

test("a new page starts at the top", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "a phone is where the list is long enough to scroll");

  // Enough cards, two to a row, for the page to scroll.
  for (let i = 0; i < 12; i++) await makeCharacter(request, { name: `Scroll ${i}` });

  await page.goto("/");
  const main = page.locator("main");
  await expect(main.locator("a:has(h2)").nth(11)).toBeVisible();

  // The page scrolls inside <main>, which stays where it is from one route to
  // the next, so it is <main> that has to be sent back to the top. Scrolled a
  // little, not to the bottom: the link to the next page is at the top of
  // this one, and the browser scrolls a link that is out of sight into view
  // before clicking it, which would do the resetting being tested.
  await main.evaluate((el) => el.scrollTo(0, 60));
  expect(await main.evaluate((el) => el.scrollTop), "the list did not scroll").toBeGreaterThan(0);
  const create = page.getByRole("link", { name: /^create$/i });
  await expect(create, "the link is not in sight, so clicking it would scroll").toBeInViewport({ ratio: 1 });

  // The new-card form, and not a character: a page that waits for data first
  // starts out as a short "loading" line, which makes the browser pull the
  // scroll position back to the top by itself. This page is as tall as it will
  // be from its first frame, so only the reset can explain landing at the top.
  await create.click();
  await expect(page.getByRole("heading", { name: /new card/i })).toBeVisible();
  await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await main.evaluate((el) => el.scrollHeight > el.clientHeight),
    "the form is not taller than the screen, so landing at the top proves nothing").toBe(true);
});

test("what cannot be read is said, and read again when asked", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/#/");
  await expect(page.locator("main h1")).toBeVisible();
  // The page is there already, and then the wifi goes.
  const unreachable = "**/api/**";
  for (const name of ["Conversations", "Personas", "Settings"]) {
    await page.route(unreachable, (route) => route.abort("internetdisconnected"));
    await page.getByRole("link", { name, exact: true }).click();
    const failure = page.locator("main").getByRole("alert");
    await expect(failure, `on ${name}`).toContainText("Evermind is not answering");
    await expect(page.locator("main").getByText("Loading…"), `on ${name}`).toHaveCount(0);
    await page.unroute(unreachable);
    await failure.getByRole("button", { name: "Reload" }).click();
    await expect(failure, `on ${name}`).toHaveCount(0);
  }

  await page.getByRole("link", { name: "Discover", exact: true }).click();
  await page.route("**/api/library", (route) => route.abort("internetdisconnected"));
  await page.getByTitle("Starter library").click();
  const library = page.getByRole("dialog");
  await expect(library.getByRole("alert")).toContainText("Evermind is not answering");
  await expect(library, "said to be empty").not.toContainText("The library is empty");
  await page.unroute("**/api/library");
  await library.getByRole("button", { name: "Reload" }).click();
  await expect(library.locator("h3").first()).toBeVisible();
  await expect(library.getByRole("alert")).toHaveCount(0);
});
