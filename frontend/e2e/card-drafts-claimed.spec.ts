import { expect, test, type Page, type Request } from "@playwright/test";
import { API } from "../playwright.config";
import { cardEnds, makeCharacter, PNG } from "./fixtures";

/**
 * What the card assistant costs counts under the card it wrote. The claim itself is proven by the
 * server's tests (no screen shows the rows yet); here, what the page sends: the jobs a new card's
 * first save claims, and the id of a card being edited with its brief.
 */

const brief = (page: Page) => page.getByPlaceholder(/^Describe the character you want/);
const generate = (page: Page) => page.getByRole("button", { name: "Generate the card" });
const stop = (page: Page) => page.getByRole("button", { name: "Stop", exact: true });
const nameField = (page: Page) => page.getByLabel("Name", { exact: true });

const keptJob = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("evermind:assist:new") ?? "null")?.id ?? null);

/** Every list of jobs the page keeps for a card's first save. */
const jobLists = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("evermind:assist-jobs:")));

/** The page's request that makes a card. */
const creating = (page: Page) =>
  page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/characters");

/** The page's request that begins a draft. */
const starting = (page: Page) =>
  page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/characters/assist");

const sent = (request: Request) => request.postDataJSON() as Record<string, unknown>;

/** The jobs the page has written down, for a new card or a saved one. */
const keptJobs = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("evermind:assist:"))
      .map((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.id as string | undefined)
      .filter(Boolean));

// A job left running would go on writing into the tests that come next.
test.afterEach(async ({ page, request }) => {
  for (const kept of await keptJobs(page).catch(() => [])) {
    await request.delete(`${API}/api/characters/assist/${kept}`);
  }
});

test("a draft reloaded while it runs is claimed by the card it became", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/#/characters/new");
  const ended = cardEnds(page);
  await brief(page).fill("A seller of maps MOCK_THINKS");
  await generate(page).click();
  await expect(stop(page)).toBeVisible();
  await expect.poll(() => keptJob(page), { message: "the job written down" }).not.toBeNull();
  const job = await keptJob(page);

  await page.reload();
  await expect(stop(page)).toBeVisible();
  await ended;
  await expect(nameField(page)).not.toHaveValue("");

  const made = creating(page);
  await page.getByRole("button", { name: "Create card" }).click();
  expect(sent(await made).assist_jobs).toEqual([job]);
  await expect(page).toHaveURL(/#\/characters\/(?!new$)[^/]+$/);
  // Claimed: kept under no name, neither for the next new card nor for the card it became.
  expect(await jobLists(page), "the claimed jobs were still kept").toEqual([]);
});

test("a draft whose text was lost is not claimed by the next card", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/#/characters/new");
  const ended = cardEnds(page);
  await brief(page).fill("A seller of maps");
  await generate(page).click();
  await ended;
  await expect(nameField(page)).not.toHaveValue("");

  await page.reload();
  await expect(nameField(page)).toHaveValue("");
  await expect(brief(page)).toHaveValue("");

  await nameField(page).fill(`Another ${Date.now()}`);
  const made = creating(page);
  await page.getByRole("button", { name: "Create card" }).click();
  expect(sent(await made).assist_jobs).toEqual([]);
});

test("a card being edited sends its id with the brief", async ({ page, request }) => {
  const card = await makeCharacter(request);
  await page.goto(`/#/characters/${card.id}/edit`);
  const ended = cardEnds(page);
  const started = starting(page);
  await brief(page).fill("A seller of maps");
  await generate(page).click();
  expect(sent(await started).card_id).toBe(card.id);
  await ended;
  expect(await jobLists(page), "a saved card's job was kept for a claim").toEqual([]);
});

test("a new card saved once, still on its form, sends its id with the next brief", async ({ page, request }) => {
  const name = `Saved once ${Date.now()}`;
  await page.goto("/#/characters/new");
  await nameField(page).fill(name);
  // Its portrait fails: the card is made, and the form stays.
  await page.locator('input[type="file"]').setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  await page.route("**/api/characters/*/avatar", (route) =>
    route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" }));
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page.getByText("HTTP 500")).toBeVisible();
  const made = (await (await request.get(`${API}/api/characters`)).json())
    .filter((c: { name: string }) => c.name === name);
  expect(made).toHaveLength(1);

  const ended = cardEnds(page);
  const started = starting(page);
  await brief(page).fill("A seller of maps");
  await generate(page).click();
  expect(sent(await started).card_id).toBe(made[0].id);
  await ended;
  expect(await jobLists(page), "a saved card's job was kept for a claim").toEqual([]);
  await page.unroute("**/api/characters/*/avatar");
});
