import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK, MOCK_ROOT, chat, forgetServices, inLocale, makeCharacter, misfits, rootAt } from "./fixtures";
import { answerSpending, dayBefore, inWords, nothing, year } from "./spending.fixture";

/**
 * The page of Spending: what the AIs cost, by period and four cuts. Most tests answer for the
 * server with spending.fixture.ts; two make real replies to the mock model and read what they cost.
 */

const MANY = `${MOCK_ROOT}/many/api/v1`;

const total = (page: Page) => page.locator("[data-total]");
const list = (page: Page) => page.locator("[data-cut-list]");
/** A line of the list, by the name it shows. */
const line = (page: Page, name: string) => list(page).getByRole("button").filter({ hasText: name });
const detail = (page: Page) => page.locator("[data-line-detail]");

/** A conversation with an AI of its own, whose replies cost what `costs` tells the mock (in
 *  millionths of a dollar); without it, the mock says no cost. */
async function conversationOn(request: APIRequestContext, modelId: string, costs?: number) {
  const card = await makeCharacter(request);
  const convo = await (await request.post(`${API}/api/conversations`, {
    data: { character_id: card.id, model_id: modelId },
  })).json();
  if (costs !== undefined) {
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: `MOCK_COSTS_${costs}` } });
  }
  return convo;
}

async function rootIs32(page: Page) {
  await page.addInitScript(rootAt, "32px");
}

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(0);
  expect(await misfits(page)).toEqual([]);
}

test("real replies are counted and priced", async ({ page, request }) => {
  await request.delete(`${API}/api/spending`);
  await forgetServices(request, "/many/");
  const made = await request.post(`${API}/api/models`, {
    data: {
      service: { provider: "openai-compatible", base_url: MANY, api_key: "sk-e2e-spending", family: "openrouter" },
      models: [{ model: "nacre/nacre-chat-8b", name: "Nacre Spent" }],
    },
  });
  expect(made.ok()).toBe(true);
  const ai = (await made.json()).models[0];
  try {
    const cheap = await conversationOn(request, ai.id, 2100);
    for (const content of ["Tell me.", "And then?"]) await chat(request, { conversation_id: cheap.id, mode: "send", content });
    await page.goto("/#/spending");
    // Two decimals, never "$0.0042".
    await expect(total(page)).toHaveText("less than $0.01");

    const dear = await conversationOn(request, ai.id, 2100000);
    for (const content of ["Tell me.", "And then?"]) await chat(request, { conversation_id: dear.id, mode: "send", content });
    await page.reload();
    await expect(total(page)).toHaveText("$4.20");
    await line(page, "Nacre Spent").click();
    await expect(detail(page)).toContainText("billed by the service: $4.20");
  } finally {
    await forgetServices(request, "/many/");
  }
});

test("an ai without a price says its tokens and takes one", async ({ page, request }) => {
  await request.delete(`${API}/api/spending`);
  const name = `Unpriced ${Date.now()}`;
  // A gateway of no known family, on a service of its own: never free, even at home.
  const made = await request.post(`${API}/api/models`, {
    data: {
      service: { provider: "openai-compatible", base_url: MOCK, api_key: `sk-spending-${Date.now()}`, family: "generic" },
      models: [{ model: "evermind-demo", name }],
    },
  });
  expect(made.ok()).toBe(true);
  const ai = (await made.json()).models[0];
  try {
    const convo = await conversationOn(request, ai.id);
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.goto("/#/spending");
    const row = list(page).locator("li").filter({ hasText: name });
    await expect(row).toContainText("price not given");
    await expect(row).toContainText(/tokens read · \d+ written/);

    await row.getByRole("button", { name: "Set the price" }).click();
    await detail(page).getByLabel("Read").fill("3");
    await detail(page).getByLabel("Written").fill("15");
    await detail(page).getByLabel("Written").press("Tab");
    await expect(detail(page)).toContainText("Also applied to your earlier call, which had no price.");
    await page.getByRole("button", { name: "Close" }).click();
    await expect(line(page, name)).toContainText("less than $0.01");
  } finally {
    await request.delete(`${API}/api/models/${ai.id}`);
    const services = await (await request.get(`${API}/api/connections`)).json();
    for (const service of services as { id: string; base_url: string; model_count: number }[]) {
      if (service.base_url === MOCK && service.model_count === 0) await request.delete(`${API}/api/connections/${service.id}`);
    }
  }
});

test("the five periods are in sight at 390 and at a 32 px root", async ({ page }) => {
  await answerSpending(page);
  const periods = ["7 days", "30 days", "This month", "Last month", "Since the start"];
  for (const [width, height, large] of [[390, 844, false], [320, 640, false], [390, 844, true]] as const) {
    if (large) await rootIs32(page);
    await page.setViewportSize({ width, height });
    // A new document each time: a move of the address after "#" alone would run no script given.
    await page.goto("about:blank");
    await page.goto("/#/spending");
    if (large) expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
    await expect(total(page)).toBeVisible();
    for (const name of periods) {
      const button = page.getByRole("button", { name, exact: true });
      if (width === 390) await expect(button).toBeInViewport({ ratio: 1 });
      await expect(button).toBeVisible();
    }
    await fits(page);
  }
});

for (const [locale, words] of [
  ["en", { conversation: "By conversation", clear: "Clear the history…" }],
  ["fr", { conversation: "Par conversation", clear: "Effacer l'historique…" }],
] as const) {
  test(`the list, a line opened and the clearing fit a phone, in ${locale}`, async ({ page }) => {
    await inLocale(page, locale);
    const asked = await answerSpending(page);
    for (const [width, height, large] of [[390, 844, false], [320, 640, false], [390, 844, true]] as const) {
      if (large) await rootIs32(page);
      await page.setViewportSize({ width, height });
      await page.goto("about:blank");
      await page.goto("/#/spending");
      await expect(total(page)).toBeVisible();
      if (large) expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
      await page.getByRole("button", { name: words.conversation }).click();
      await fits(page);
      await list(page).locator('[data-key="conv-inn"] button').click();
      await expect(detail(page)).toContainText(/1[.,]54/);
      await fits(page);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: words.clear }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await fits(page);
      await page.keyboard.press("Escape");
    }
    // Opening the page asked the server once each time; nothing more until a line was opened.
    expect(asked.summary).toHaveLength(3);
    expect(asked.detail).toHaveLength(3);
  });
}

test("a period with nothing says only that", async ({ page }) => {
  await answerSpending(page, nothing);
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$0");
  await expect(page.getByText(/^Evermind has been counting since /)).toBeVisible();
  await expect(page.getByText("Nothing noted for this period.")).toBeVisible();
  await expect(page.locator("[data-bars]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "By AI" })).toHaveCount(0);
});

test("a row says what it holds", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await expect(line(page, "Gateway")).toContainText("price not given");
  await expect(line(page, "Aurore")).toContainText("less than $0.01");
  await page.getByRole("button", { name: "By use" }).click();
  await expect(line(page, "Replies")).toContainText("$0.10 + 184 calls without a price");
  await expect(line(page, "Replies")).toContainText("of which 4 retried attempts");
  await expect(line(page, "Speed tests")).toContainText("free");
  for (const cut of ["By AI", "By character", "By conversation", "By use"]) {
    await page.getByRole("button", { name: cut }).click();
    for (const text of await list(page).allInnerTexts()) expect(text, cut).not.toMatch(/\$0(?![.,\d])/);
  }
  await page.getByRole("button", { name: "By conversation" }).click();
  await line(page, "At the inn").click();
  await expect(detail(page)).toContainText("Automatic memory: $1.54 + 21 calls without a price");
});

test("free ais are apart and never an amount", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  const free = list(page).locator("[data-free]");
  await expect(free).toContainText("Free");
  await expect(free).toContainText("Brume 12B");
  await expect(free).toContainText("on this PC");
  await expect(free).toContainText("free on OpenRouter");
  await expect(free).not.toContainText("$");
  // Last of the list.
  expect(await list(page).evaluate((el) => el.lastElementChild?.hasAttribute("data-free"))).toBe(true);
  const openrouter = list(page).locator("[data-service]").filter({ hasText: "OpenRouter" });
  await expect(openrouter).toContainText("Claude Byok");
  await expect(openrouter).toContainText("of which $0.01 billed by Anthropic");
});

test("the one-ai filter narrows the list, never the total", async ({ page }) => {
  const asked = await answerSpending(page);
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  await page.getByRole("button", { name: "By conversation" }).click();
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get("model") === "ai-sylve");
  await page.getByRole("combobox").selectOption({ label: "Sylve Mini" });
  await read;
  await expect(page.getByText("With Sylve Mini: $1.43")).toBeVisible();
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  await expect(line(page, "Lost road")).toHaveCount(0);
  expect(asked.summary).toHaveLength(2);
});

test("a bar is reached by sliding or stepping", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  const legend = page.locator("[data-bars-legend]");
  // The last one, today, at first.
  await expect(legend).toContainText(`${inWords(dayBefore(0))}: `);
  const bars = page.locator("[data-bars] [data-bar]");
  await expect(bars).toHaveCount(30);
  const first = (await bars.nth(0).boundingBox())!;
  const tenth = (await bars.nth(9).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height - 2);
  await page.mouse.down();
  await page.mouse.move(tenth.x + tenth.width / 2, first.y + first.height - 2, { steps: 6 });
  await page.mouse.up();
  await expect(legend).toContainText(`${inWords(dayBefore(20))}: `);
  await page.getByRole("button", { name: "Next bar" }).click();
  await expect(legend).toContainText(`${inWords(dayBefore(19))}: `);
  for (let i = 0; i < 10; i++) {
    const before = page.getByRole("button", { name: "Previous bar" });
    if (await before.isDisabled()) break;
    await before.click();
  }
  await expect(legend).toContainText(`${inWords(dayBefore(29))}: `);
  await expect(page.getByRole("button", { name: "Previous bar" })).toBeDisabled();
  await expect(legend).toContainText(`${inWords(dayBefore(29))}: `);
});

test("a year of weeks on a phone fits and slides", async ({ page }) => {
  await answerSpending(page, year);
  await rootIs32(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/#/spending?per=all");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
  await expect(page.locator("[data-bars] [data-bar]")).toHaveCount(53);
  await expect(page.locator("[data-bars-legend]")).toContainText(/^week of /);
  await fits(page);
  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(list(page)).toContainText("250 others");
  await fits(page);
  await page.getByRole("button", { name: "By character" }).click();
  await fits(page);
});

test("a line from elsewhere opens its detail on its own period", async ({ page }) => {
  const asked = await answerSpending(page);
  await page.goto("/#/spending?cut=conversation&key=conv-inn&per=all");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/since /);
  await expect(sheet).toContainText("At the inn");
  expect(asked.detail[0].searchParams.get("from")).toBeNull();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(line(page, "At the inn")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Since the start" })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/#/");
  await page.goto("/#/spending");
  await expect(page.getByRole("button", { name: "30 days", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a deleted line can forget its name", async ({ page }) => {
  const asked = await answerSpending(page);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(line(page, "Lost road")).toContainText("deleted");
  await line(page, "Lost road").click();
  const forgot = page.waitForRequest((r) => r.url().endsWith("/api/spending/forget"));
  await detail(page).getByRole("button", { name: "Forget this name" }).click();
  await forgot;
  expect(asked.forget).toEqual([{ cut: "conversation", key: "conv-gone" }]);
  await expect(page.getByRole("dialog")).toContainText("Deleted conversation");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(line(page, "Deleted conversation")).toBeVisible();
  await expect(line(page, "Lost road")).toHaveCount(0);
});

test("clearing needs a choice and says what goes", async ({ page }) => {
  const asked = await answerSpending(page);
  await page.goto("/#/spending");
  await expect(total(page)).toBeVisible();
  await page.getByRole("button", { name: "Clear the history…" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("radio", { checked: true })).toHaveCount(0);
  const clear = sheet.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeDisabled();
  await expect(sheet).toContainText("Choose what goes");

  const year = new Date().getFullYear();
  await sheet.getByRole("radio", { name: "Before" }).check();
  await expect(clear).toBeDisabled();
  await sheet.locator("input[type=date]").fill(`${year}-12-15`);
  await expect(sheet).toContainText(
    `1,214 calls, from ${inWords(`${year}-11-20`)} to ${inWords(`${year}-12-14`)}. This cannot be undone.`);
  expect(asked.clear.at(-1)!.searchParams.get("dry_run")).toBe("1");
  expect(asked.clear.at(-1)!.searchParams.get("before")).toBe(`${year}-12-15`);
  await expect(clear).toBeEnabled();
  const summaries = asked.summary.length;
  await clear.click();
  await expect(page.getByRole("status").filter({ hasText: "History cleared: 1,214 calls." })).toBeVisible();
  await expect(sheet).toHaveCount(0);
  expect(asked.clear.at(-1)!.searchParams.get("dry_run")).toBeNull();
  await expect.poll(() => asked.summary.length).toBe(summaries + 1);
  expect(await page.evaluate(() => [window.scrollY, document.querySelector("main")?.scrollTop ?? 0])).toEqual([0, 0]);
});

test("the export saves a file and says so", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export (CSV)" }).click();
  const name = (await download).suggestedFilename();
  expect(name).toMatch(/^evermind-spending-.+\.csv$/);
  await expect(page.getByRole("status").filter({ hasText: `File saved: ${name}` })).toBeVisible();
});

test("side by side on a wide screen @desktop", async ({ page }) => {
  await answerSpending(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/spending");
  await line(page, "Sylve Mini").click();
  await expect(detail(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const listBox = (await list(page).boundingBox())!;
  const detailBox = (await detail(page).boundingBox())!;
  expect(detailBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  await expect(detail(page)).toContainText("per 100 messages, from your last 100 replies");
});

