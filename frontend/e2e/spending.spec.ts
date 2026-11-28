import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK, MOCK_ROOT, chat, forgetServices, inLocale, makeCharacter, misfits, rootAt } from "./fixtures";
import { answerSpending, dayBefore, inWords, month, nothing, year } from "./spending.fixture";

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

/** The month, but $1.00 over the last 7 days, and an AI with no call in them: an answer of one
 *  period told from another's. */
function weekOrMonth(url: URL) {
  const said = month();
  if (url.searchParams.get("from") !== dayBefore(6)) return said;
  return { ...said, total: 1, previous: { cost: 0.5, unpriced_calls: 0 }, models: said.models.filter(([id]) => id !== "ai-sylve") };
}

/** Each read of the summary, before the fixture answers it: `answer` holds it, fails it or lets
 *  it through with route.fallback(). */
async function onSummary(page: Page, answer: (url: URL, route: Route) => Promise<void>) {
  await page.route((url) => url.pathname.endsWith("/api/spending"), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await answer(new URL(route.request().url()), route);
  });
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

test("what was spent outside replies and in the days before follows the rule of a line", async ({ page }) => {
  let said = (s: ReturnType<typeof month>) => s;
  await answerSpending(page, () => said(month()));
  const outside = page.locator("[data-outside]");
  const before = page.getByText(/^The 30 days before: /);

  // Memory passes on an AI with no price, and days before that held only such calls.
  said = (s) => ({ ...s, outside_replies: { cost: 0, calls: 40, unpriced_calls: 40, free_calls: 0 }, previous: { cost: 0, unpriced_calls: 12 } });
  await page.goto("/#/spending");
  await expect(outside).toHaveText("of which price not given outside replies: automatic memory, card assistant…");
  await expect(before).toHaveText("The 30 days before: price not given");

  // Both, and a true nothing.
  said = (s) => ({ ...s, outside_replies: { cost: 1.58, calls: 62, unpriced_calls: 21, free_calls: 0 }, previous: { cost: 0, unpriced_calls: 0 } });
  await page.reload();
  await expect(outside).toHaveText("of which $1.58 + 21 calls without a price outside replies: automatic memory, card assistant…");
  await expect(before).toHaveText("The 30 days before: nothing");

  // Every call outside replies to a free AI: no such line. Days never counted: none either.
  said = (s) => ({ ...s, outside_replies: { cost: 0, calls: 6, unpriced_calls: 0, free_calls: 6 }, previous: null });
  await page.reload();
  await expect(total(page)).toBeVisible();
  await expect(outside).toHaveCount(0);
  await expect(page.getByText(/days before/)).toHaveCount(0);
});

test("a name written right to left stays apart from the words around it", async ({ page }) => {
  const LAYLA = "ليلى";
  const NIGHT = "ليلة في النزل";
  const SYLVE = "سيلف ميني";
  await answerSpending(page, () => {
    const s = month();
    return {
      ...s,
      models: s.models.map((m) => (m[0] === "ai-sylve" ? [m[0], SYLVE, ...m.slice(2)] as typeof m : m)),
      cards: s.cards.map((c) => (c[0] === "card-serana" ? [c[0], LAYLA, ...c.slice(2)] as typeof c : c)),
      conversations: s.conversations.map((c) => (c[0] === "conv-inn" ? [c[0], NIGHT, LAYLA, ...c.slice(3)] as typeof c : c)),
    };
  });
  await page.route("**/api/spending/detail?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("key") !== "card-serana") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      name: LAYLA, kind: "character", deleted: false, cost: 1.6, calls: 300, unpriced_calls: 184,
      models: [["ai-sylve", SYLVE, 1.6, 116, 0, false]],
      conversations: [["conv-inn", NIGHT, 1.6, 300, 184, false, false]], conversations_rest: null,
    }) });
  });
  await page.goto("/#/spending");
  /** The first row of a line: its name, then its amount, last. */
  const head = (key: string) => list(page).locator(`[data-key="${key}"] button > span:first-child`);
  await expect(head("ai-sylve").locator("bdi")).toHaveText(SYLVE);
  expect(await head("ai-sylve").evaluate((el) => el.textContent)).toMatch(/\$1\.43$/);

  await page.getByRole("button", { name: "By character" }).click();
  await expect(head("card-serana").locator("bdi")).toHaveText(LAYLA);
  expect(await head("card-serana").evaluate((el) => el.textContent)).toMatch(/\$1\.60 \+ 184 calls without a price$/);

  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(head("conv-inn").locator("bdi")).toHaveText(NIGHT);
  // Its character, in the small line under it.
  await expect(list(page).locator('[data-key="conv-inn"] button bdi')).toHaveText([NIGHT, LAYLA]);

  // In a sentence: isolated by its marks.
  await page.getByRole("combobox").selectOption({ label: SYLVE });
  await expect(page.getByText(`With \u2068${SYLVE}\u2069: $1.43`)).toBeVisible();

  // A line opened: its title and each name of what it holds.
  await page.getByRole("combobox").selectOption({ label: "All AIs" });
  await page.getByRole("button", { name: "By character" }).click();
  await list(page).locator('[data-key="card-serana"] button').click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("h2 bdi")).toHaveText(LAYLA);
  await expect(detail(page).locator("li").filter({ hasText: SYLVE })).toHaveText(`\u2068${SYLVE}\u2069: $1.60`);
  await expect(detail(page).locator("li").filter({ hasText: NIGHT })).toHaveText(`\u2068${NIGHT}\u2069: $1.60 + 184 calls without a price`);
});

test("deleted agrees with what each line is, in french", async ({ page }) => {
  await inLocale(page, "fr");
  await answerSpending(page, () => {
    const s = month();
    return { ...s, models: s.models.map((m) => (m[0] === "ai-aurore" ? [...m.slice(0, 11), true] as typeof m : m)) };
  });
  await page.goto("/#/spending");
  await expect(line(page, "Aurore")).toContainText("Auroresupprimée");
  await page.getByRole("button", { name: "Par personnage" }).click();
  await expect(line(page, "Old friend")).toContainText("Old friendsupprimé");
  await expect(line(page, "Old friend")).not.toContainText("supprimée");
  await page.getByRole("button", { name: "Par conversation" }).click();
  await expect(line(page, "Lost road")).toContainText("Lost roadsupprimée");
});

test("retried attempts agree with the calls they are of, in spanish", async ({ page }) => {
  await inLocale(page, "es");
  await answerSpending(page);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "Por uso" }).click();
  await expect(line(page, "Respuestas")).toContainText("300 llamadas · de las cuales 4 intentos repetidos");
});

test("free ais are apart and never an amount", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  const free = list(page).locator("[data-free]");
  await expect(free).toContainText("Free");
  await expect(free).toContainText("Brume 12B");
  await expect(free).toContainText("on this PC");
  await expect(free).toContainText(`free on \u2068OpenRouter\u2069`);
  await expect(free).not.toContainText("$");
  // Last of the list.
  expect(await list(page).evaluate((el) => el.lastElementChild?.hasAttribute("data-free"))).toBe(true);
  const openrouter = list(page).locator("[data-service]").filter({ hasText: "OpenRouter" });
  await expect(openrouter).toContainText("Claude Byok");
  await expect(openrouter).toContainText(`of which $0.01 billed by \u2068Anthropic\u2069`);
});

test("the one-ai filter narrows the list, never the total", async ({ page }) => {
  const asked = await answerSpending(page);
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  await page.getByRole("button", { name: "By conversation" }).click();
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get("model") === "ai-sylve");
  await page.getByRole("combobox").selectOption({ label: "Sylve Mini" });
  await read;
  await expect(page.getByText(`With \u2068Sylve Mini\u2069: $1.43`)).toBeVisible();
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
  // A name forgotten is not offered to be forgotten again.
  await expect(detail(page).getByRole("button", { name: "Forget this name" })).toHaveCount(0);
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
  // A day the server does not read is no choice: nothing is asked.
  await sheet.locator("input[type=date]").fill("1999-05-01");
  await expect(clear).toBeDisabled();
  await expect(sheet).toContainText("Choose what goes");
  expect(asked.clear).toEqual([]);
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


test("a period chosen shows no amount of the one before while it waits", async ({ page }) => {
  await answerSpending(page, weekOrMonth);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await onSummary(page, async (url, route) => {
    if (url.searchParams.get("from") === dayBefore(6)) await held;
    await route.fallback();
  });
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  const height = await page.locator("main").evaluate((el) => el.scrollHeight);
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(page.locator("[aria-busy=true]").first()).toContainText("Loading…");
  await expect(total(page)).toHaveCount(0);
  await expect(list(page)).toHaveCount(0);
  await expect(page.getByText(/\$/)).toHaveCount(0);
  // What waits holds the room of what it replaces: nothing below it jumps.
  expect(await page.locator("main").evaluate((el) => el.scrollHeight)).toBeGreaterThanOrEqual(height);
  release();
  await expect(total(page)).toHaveText("$1.00 + 205 calls without a price");
  await expect(page.getByText("The 7 days before: $0.50")).toBeVisible();
});

test("a period that cannot be read says so and reads again", async ({ page }) => {
  await answerSpending(page, weekOrMonth);
  let failing = true;
  await onSummary(page, async (url, route) => {
    if (failing && url.searchParams.get("from") === dayBefore(6)) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    }
    await route.fallback();
  });
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  await expect(page.getByRole("button", { name: "7 days", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(total(page)).toHaveCount(0);
  await expect(page.getByText(/\$3\.02|The 7 days before/)).toHaveCount(0);
  failing = false;
  // On a slow link, the read asked again says it waits, in place of the failure it answers.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await onSummary(page, async (url, route) => {
    if (url.searchParams.get("from") === dayBefore(6)) await held;
    await route.fallback();
  });
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("[aria-busy=true]").first()).toContainText("Loading…");
  await expect(page.getByRole("alert")).toHaveCount(0);
  release();
  await expect(total(page)).toHaveText("$1.00 + 205 calls without a price");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a first read that fails says it waits when asked again", async ({ page }) => {
  await answerSpending(page);
  let failing = true;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await onSummary(page, async (_url, route) => {
    if (failing) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    await held;
    await route.fallback();
  });
  await page.goto("/#/spending");
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  failing = false;
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("[aria-busy=true]").first()).toContainText("Loading…");
  await expect(page.getByRole("alert")).toHaveCount(0);
  release();
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
});

test("the same period read again and failed shows none of its old amounts", async ({ page }) => {
  const asked = await answerSpending(page);
  let fail = false;
  await onSummary(page, async (_url, route) => {
    if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    await route.fallback();
  });
  await page.goto("/#/spending");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  await page.getByRole("button", { name: "Clear the history…" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "Everything" }).check();
  const clear = sheet.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeEnabled();
  fail = true;
  await clear.click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  await expect(total(page)).toHaveCount(0);
  await expect(page.getByText(/\$3\.02/)).toHaveCount(0);
  expect(asked.clear.at(-1)!.searchParams.get("dry_run")).toBeNull();
});

test("a list narrowed to one ai waits in its place, and says when it cannot be read", async ({ page }) => {
  await answerSpending(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await onSummary(page, async (url, route) => {
    const model = url.searchParams.get("model");
    if (model === "ai-sylve") await held;
    if (model === "ai-brume") {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    }
    await route.fallback();
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(line(page, "Lost road")).toBeVisible();
  await page.getByRole("combobox").selectOption({ label: "Sylve Mini" });
  await expect(list(page)).toHaveCount(0);
  await expect(page.locator("[aria-busy=true]").first()).toContainText("Loading…");
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
  release();
  await expect(line(page, "At the inn")).toBeVisible();
  await expect(line(page, "Lost road")).toHaveCount(0);

  await page.getByRole("combobox").selectOption({ label: "Brume 12B" });
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  await expect(list(page)).toHaveCount(0);
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
});

test("a line closed leaves no step behind for the back button", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/");
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await line(page, "At the inn").click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/#\/spending/);
});

test("back from an address opened cold, a period chosen, stays in evermind", async ({ page }) => {
  await answerSpending(page);
  // A bookmark: the tab's first entry of the app.
  await page.goto("/#/spending?per=7");
  await expect(total(page)).toBeVisible();
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await expect(page).not.toHaveURL(/per=/);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
});

test("back from a line opened cold and closed by its cross stays in evermind", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending?cut=conversation&key=conv-inn");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("At the inn");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
});

test("a line low in a long list is in sight once closed", async ({ page }) => {
  await answerSpending(page, year);
  await page.goto("/#/spending?per=all&cut=conversation&key=conv-40");
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(list(page).locator('[data-key="conv-40"]')).toBeInViewport();
});

test("a late answer of another period is dropped", async ({ page }) => {
  await answerSpending(page, weekOrMonth);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await onSummary(page, async (_url, route) => {
    // The page's first read, of 30 days, comes back last.
    if (first) {
      first = false;
      await held;
    }
    await route.fallback();
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(total(page)).toHaveText("$1.00 + 205 calls without a price");
  const late = page.waitForResponse((r) => new URL(r.url()).searchParams.get("from") === dayBefore(29));
  release();
  await late;
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await expect(total(page)).toHaveText("$1.00 + 205 calls without a price");
});

test("a free ai chosen in the filter is free, never an amount", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  const read = page.waitForRequest((r) => new URL(r.url()).searchParams.get("model") === "ai-brume");
  await page.getByRole("combobox").selectOption({ label: "Brume 12B" });
  await read;
  await expect(page.getByText(`With \u2068Brume 12B\u2069: free`)).toBeVisible();
  await expect(page.getByText(/^With \u2068Brume 12B\u2069: \$/)).toHaveCount(0);
});

test("the ai filtered stays chosen in a period where it made no call", async ({ page }) => {
  const asked = await answerSpending(page, weekOrMonth);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await page.getByRole("combobox").selectOption({ label: "Sylve Mini" });
  await expect(page.getByText(`With \u2068Sylve Mini\u2069: $1.43`)).toBeVisible();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(total(page)).toHaveText("$1.00 + 205 calls without a price");
  expect(asked.summary.at(-1)!.searchParams.get("model")).toBe("ai-sylve");
  // What the select shows is what the page asks.
  await expect(page.getByRole("combobox")).toHaveValue("ai-sylve");
  await expect(page.getByRole("combobox").locator("option:checked")).toHaveText("Sylve Mini");
  await expect(page.getByText(`With \u2068Sylve Mini\u2069: nothing`)).toBeVisible();
  await page.getByRole("combobox").selectOption({ label: "All AIs" });
  await expect.poll(() => asked.summary.at(-1)!.searchParams.get("model")).toBeNull();
});

for (const [locale, words] of [
  ["en", { card: "By character", reload: "Reload" }],
  ["fr", { card: "Par personnage", reload: "Recharger" }],
  ["de", { card: "Nach Charakter", reload: "Neu laden" }],
] as const) {
  test(`a line that cannot be read keeps its way to read it again in reach, in ${locale}`, async ({ page }) => {
    await inLocale(page, locale);
    await answerSpending(page);
    await rootIs32(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/#/spending");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
    await page.getByRole("button", { name: words.card }).click();
    // The server fails this line: a failure that can be read again.
    await list(page).locator('[data-key="card-vigil"] button').click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("alert")).toBeVisible();
    await expect(sheet.getByRole("button", { name: words.reload })).toBeVisible();
    await fits(page);
  });
}

test("back closes a line opened before it leaves the page, and a reload keeps it open", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/");
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await line(page, "At the inn").click();
  await expect(page.getByRole("dialog")).toContainText("At the inn");
  expect(new URLSearchParams(page.url().split("?")[1] ?? "").get("key")).toBe("conv-inn");
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText("At the inn");
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/spending$/);
  await expect(line(page, "At the inn")).toBeVisible();
});

test("a line closed and a period chosen are what a reload shows", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending?cut=conversation&key=conv-inn&per=all");
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await page.reload();
  await expect(total(page)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "7 days", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a period chosen beside an open line is what a reload shows @desktop", async ({ page }) => {
  await answerSpending(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/spending?per=all");
  await page.getByRole("button", { name: "By conversation" }).click();
  await line(page, "At the inn").click();
  await expect(detail(page)).toContainText("At the inn");
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await detail(page).getByRole("button", { name: "Close" }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "7 days", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).not.toHaveURL(/per=/);
  await page.reload();
  await expect(total(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "7 days", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a period tapped is the one the next visit shows", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "Last month" }).click();
  await page.goto("/#/");
  await page.goto("/#/spending");
  await expect(page.getByRole("button", { name: "Last month" })).toHaveAttribute("aria-pressed", "true");
});

test("every line and control is a finger's size", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await expect(total(page)).toBeVisible();
  const heights = (selector: string) => page.locator(selector).evaluateAll((all) =>
    all.map((el) => [el.textContent?.trim().slice(0, 30), el.getBoundingClientRect().height] as const));
  const low = async (selector: string, least: number) => (await heights(selector)).filter(([, h]) => h < least);
  expect(await low("[role=group] > button", 44)).toEqual([]);
  expect(await heights("[data-outside]")).toHaveLength(1);
  expect(await low("[data-outside]", 44)).toEqual([]);
  for (const cut of ["By AI", "By character", "By conversation", "By use"]) {
    await page.getByRole("button", { name: cut }).click();
    expect(await low("[data-cut-list] [data-key] > button:first-child", 56), cut).toEqual([]);
  }
});

test("the bars slide sideways under a finger and say their choice aloud", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  expect(await page.locator("[data-bars]").evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");
  await expect(page.locator("[data-bars-legend]")).toHaveAttribute("aria-live", "polite");
});

test("only replies say their retried attempts", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By use" }).click();
  await expect(line(page, "Replies")).toContainText("retried");
  await expect(line(page, "Automatic memory")).not.toContainText("retried");
});

test("an amount computed from a cache with no price is at most", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await line(page, "Aurore").click();
  await expect(detail(page)).toContainText("computed with the service's price: at most $0.12");
});

test("lines only with free ais come last, under their title", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  for (const [cut, free] of [["By character", "Home only"], ["By conversation", "Quiet evening"]] as const) {
    await page.getByRole("button", { name: cut }).click();
    // Its words as written: a title is drawn in capitals.
    const rows = await list(page).locator(":scope > li").allTextContents();
    const title = rows.findIndex((text) => text.trim() === "Only with free AIs");
    expect(title, cut).toBe(rows.length - 2);
    expect(rows.at(-1), cut).toContain(free);
    // Once: not among the others too.
    expect(rows.filter((text) => text.includes(free)), cut).toHaveLength(1);
  }
});

test("how it is counted says where the amount comes from", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  await expect(total(page)).toBeVisible();
  const how = page.locator("details");
  await how.locator("summary").click();
  await expect(how.getByRole("heading", { name: "Where the amount comes from" })).toBeVisible();
  // Each share that is not zero, as the detail of an AI says them.
  await expect(how.locator("li")).toHaveText([
    "billed by the service: $1.44", "computed with the service's price: less than $0.01", "estimated: $0.02",
  ]);
});

test("where the amount comes from is not drawn when no share is above zero", async ({ page }) => {
  await answerSpending(page, () => ({ ...month(), sources: { reported: 0, computed_read: 0, computed_typed: 0, estimated: 0 } }));
  await page.goto("/#/spending");
  await expect(total(page)).toBeVisible();
  const how = page.locator("details");
  await how.locator("summary").click();
  await expect(how.locator("p").first()).toBeVisible();
  await expect(how.getByRole("heading", { name: "Where the amount comes from" })).toHaveCount(0);
  // Nor in the detail of an AI with no price, whose calls are all in the period.
  await page.goto("/#/spending?cut=model&key=ai-gateway");
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "What it read and wrote" })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Where the amount comes from" })).toHaveCount(0);
});

test("a line with no price at all says its tokens, in every cut", async ({ page }) => {
  await answerSpending(page, () => {
    const s = month();
    return {
      ...s,
      uses: s.uses.map((u) => (u[0] === "memory" ? ["memory", 0, 40, 3, 21, 98000, 6000, 0] as typeof u : u)),
      cards: s.cards.map((c) => (c[0] === "card-vigil" ? [c[0], c[1], c[2], 0, 10, 10, 5000, 300, false, false] as typeof c : c)),
      conversations: s.conversations.map((c) => (c[0] === "conv-gone" ? [c[0], c[1], c[2], 0, 3, 3, 2500, 120, false, true] as typeof c : c)),
    };
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By use" }).click();
  await expect(line(page, "Automatic memory")).toContainText("price not given");
  await expect(line(page, "Automatic memory")).toContainText("98,000 tokens read · 6,000 written");
  // A line with an amount says none.
  await expect(line(page, "Replies")).not.toContainText("tokens read");
  await page.getByRole("button", { name: "By character" }).click();
  await expect(line(page, "The Elmswood Vigil")).toContainText("price not given");
  await expect(line(page, "The Elmswood Vigil")).toContainText("5,000 tokens read · 300 written");
  await expect(line(page, "Serana")).not.toContainText("tokens read");
  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(line(page, "Lost road")).toContainText("price not given");
  await expect(line(page, "Lost road")).toContainText("2,500 tokens read · 120 written");
});

test("a character's line opened says which conversations were free, and the rest in one line", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending?cut=card&key=card-serana");
  const sheet = page.getByRole("dialog");
  const conversations = sheet.locator("section").filter({ hasText: "In which conversations" }).locator("li");
  await expect(conversations).toHaveText([
    "\u2068At the inn\u2069: $1.60 + 184 calls without a price", "\u2068By the hearth\u2069: free", "88 others: $0.50",
  ]);
});

test("a line that no longer exists says so under its cut's name, with nothing to read again", async ({ page }) => {
  await answerSpending(page);
  await page.goto("/#/spending?cut=model&key=nothing-here");
  const sheet = page.getByRole("dialog");
  await expect(sheet.locator("h2")).toHaveText("By AI");
  await expect(sheet.getByRole("alert")).toContainText("This item no longer exists.");
  await expect(sheet.getByRole("button", { name: "Reload" })).toHaveCount(0);
  await expect(sheet).not.toContainText("Loading…");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
});

test("at most is said why, and only where it is", async ({ page }) => {
  await answerSpending(page);
  const why = "Part of what it read came from the service's cache, which costs less; that price is not known, so this is the most it can have cost.";
  await page.goto("/#/spending?cut=model&key=ai-aurore");
  await expect(detail(page)).toContainText("at most $0.12");
  await expect(detail(page)).toContainText(why);
  await page.goto("/#/spending?cut=model&key=ai-sylve");
  await expect(detail(page)).toContainText("billed by the service: $1.43");
  await expect(detail(page)).not.toContainText(why);
});

test("the list offers a price only to an ai whose calls had none", async ({ page }) => {
  await answerSpending(page, () => {
    const s = month();
    // Sylve had some calls with no price beside those the service billed.
    return { ...s, models: s.models.map((m) => (m[0] === "ai-sylve" ? [...m.slice(0, 10), 7, false] as typeof m : m)) };
  });
  await page.goto("/#/spending");
  const offer = (key: string) => list(page).locator(`[data-key="${key}"]`).getByRole("button", { name: "Set the price" });
  await expect(offer("ai-gateway")).toBeVisible();
  await expect(offer("ai-sylve")).toBeVisible();
  // What the service billed, through a key of one's own or not, wants no price.
  await expect(offer("ai-claude")).toHaveCount(0);
  await expect(offer("ai-aurore")).toHaveCount(0);
});

test("a line beside the list takes the focus and gives it back to its line @desktop", async ({ page }) => {
  await answerSpending(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/spending");
  await line(page, "Sylve Mini").click();
  await expect(detail(page).locator("h2")).toBeFocused();
  await expect(detail(page).locator("h2")).toHaveText("Sylve Mini");
  await detail(page).getByRole("button", { name: "Close" }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(list(page).locator('[data-key="ai-sylve"] > button').first()).toBeFocused();
});

test.describe("on a touch tablet", () => {
  test.use({ hasTouch: true });

  test("set the price and the cross beside the list are a finger's size", async ({ page }) => {
    await answerSpending(page, () => {
      const s = month();
      return { ...s, models: s.models.map((m) => (m[0] === "ai-sylve" ? [...m.slice(0, 10), 7, false] as typeof m : m)) };
    });
    const size = async (locator: ReturnType<Page["locator"]>) => {
      const box = (await locator.boundingBox())!;
      return [Math.round(box.width) >= 44, Math.round(box.height) >= 44];
    };
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto("/#/spending");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const offer = list(page).locator('[data-key="ai-gateway"]').getByRole("button", { name: "Set the price" });
    expect(await size(offer)).toEqual([true, true]);
    await page.route("**/api/spending/detail?**", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        name: "Gateway", service_name: "Home gateway", deleted: false, priceable: true, per100: null, cost: 0,
        cost_upstream: 0, upstream: null, calls: 205, unpriced_calls: 205, tokens: { in: 123456, out: 7890, cached: 0, reasoning: 0 },
        sources: { reported: 0, computed_read: 0, computed_typed: 0, estimated: 0 }, at_most: false,
        uses: [["reply", 0, 190, 0, 190]], cards: [], cards_rest: null,
      }),
    }));
    await line(page, "Gateway").click();
    const inSheet = page.getByRole("dialog").getByRole("button", { name: "Set the price" });
    expect(await size(inSheet)).toEqual([true, true]);
    await page.keyboard.press("Escape");

    // Turned sideways: the line stands beside the list.
    await page.setViewportSize({ width: 1180, height: 820 });
    await line(page, "Gateway").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await size(detail(page).getByRole("button", { name: "Close" }))).toEqual([true, true]);
  });
});

test("a finger chooses a bar by a tap or a slide sideways, never by scrolling the page", async ({ page, context }) => {
  await answerSpending(page);
  await page.goto("/#/spending");
  const legend = page.locator("[data-bars-legend]");
  await expect(legend).toContainText(`${inWords(dayBefore(0))}: `);
  // Real touch events, as a phone sends them: the browser scrolls for a finger going up or down.
  const cdp = await context.newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => cdp.send("Input.dispatchTouchEvent", {
    type, touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 5, radiusY: 5, force: 1, id: 1 }],
  });
  async function slide(from: [number, number], to: [number, number]) {
    await touch("touchStart", ...from);
    for (let i = 1; i <= 15; i++) {
      await touch("touchMove", from[0] + ((to[0] - from[0]) * i) / 15, from[1] + ((to[1] - from[1]) * i) / 15);
      await page.waitForTimeout(16);
    }
    await touch("touchEnd", ...to);
    await page.waitForTimeout(300);
  }
  const scrolled = () => page.locator("main").evaluate((el) => el.scrollTop);
  await page.locator("main").evaluate((el) => (el.scrollTop = 120));
  const bars = page.locator("[data-bars] [data-bar]");

  // A tap chooses the bar under it.
  const fifth = (await bars.nth(4).boundingBox())!;
  await touch("touchStart", fifth.x + fifth.width / 2, fifth.y + fifth.height - 4);
  await touch("touchEnd", fifth.x + fifth.width / 2, fifth.y + fifth.height - 4);
  await expect(legend).toContainText(`${inWords(dayBefore(25))}: `);

  // A finger going up from the bars scrolls the page, and leaves the choice where it was.
  const box = (await page.locator("[data-bars]").boundingBox())!;
  const before = await scrolled();
  await slide([box.x + box.width * 0.8, box.y + box.height / 2], [box.x + box.width * 0.8, box.y + box.height / 2 - 300]);
  expect(await scrolled()).toBeGreaterThan(before + 100);
  await expect(legend).toContainText(`${inWords(dayBefore(25))}: `);

  // A slide sideways still moves it.
  const along = (await page.locator("[data-bars]").boundingBox())!;
  await slide([along.x + 10, along.y + along.height / 2], [along.x + along.width - 4, along.y + along.height / 2]);
  await expect(legend).toContainText(`${inWords(dayBefore(0))}: `);
});

/** The summary that `failing` names fails once; from `hold()` on, every read waits for `release()`. */
function failThenHold(page: Page, failing: (url: URL) => boolean) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const state = { failed: false, holding: false };
  const route = onSummary(page, async (url, r) => {
    if (failing(url) && !state.failed) {
      state.failed = true;
      return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    }
    if (state.holding) await held;
    await r.fallback();
  });
  return { route, hold: () => (state.holding = true), release: () => release() };
}

async function waitsWithoutItsFailure(page: Page) {
  await expect(page.locator("[aria-busy=true]").first()).toContainText("Loading…");
  await expect(page.getByRole("alert")).toHaveCount(0);
}

test("a period chosen back to the one that failed says it waits, not its failure", async ({ page }) => {
  await answerSpending(page);
  const read = failThenHold(page, (url) => url.searchParams.get("from") === dayBefore(29));
  await read.route;
  await page.goto("/#/spending");
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  read.hold();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await waitsWithoutItsFailure(page);
  read.release();
  await expect(total(page)).toHaveText("$3.02 + 205 calls without a price");
});

test("an ai chosen back to the one that failed says it waits, not its failure", async ({ page }) => {
  await answerSpending(page);
  const read = failThenHold(page, (url) => url.searchParams.get("model") === "ai-brume");
  await read.route;
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await page.getByRole("combobox").selectOption({ label: "Brume 12B" });
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  read.hold();
  await page.getByRole("combobox").selectOption({ label: "Sylve Mini" });
  await page.getByRole("combobox").selectOption({ label: "Brume 12B" });
  await waitsWithoutItsFailure(page);
  read.release();
  await expect(page.getByText(`With \u2068Brume 12B\u2069: free`)).toBeVisible();
});

test("everything read again after a failed read says it waits, not its failure", async ({ page }) => {
  await answerSpending(page);
  let fail = false;
  let holding = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await onSummary(page, async (_url, route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Down." }) });
    }
    if (holding) await held;
    await route.fallback();
  });
  await page.goto("/#/spending");
  await expect(total(page)).toBeVisible();
  const clearAll = async () => {
    await page.getByRole("button", { name: "Clear the history…" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: "Everything" }).check();
    await expect(sheet.getByRole("button", { name: "Clear", exact: true })).toBeEnabled();
    await sheet.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  };
  fail = true;
  await clearAll();
  await expect(page.getByRole("alert")).toContainText("HTTP 500");
  holding = true;
  await clearAll();
  await waitsWithoutItsFailure(page);
  release();
  await expect(total(page)).toBeVisible();
});

test("a character's name forgotten reads the summary again: her conversations' titles go with it", async ({ page }) => {
  let forgotten = false;
  const asked = await answerSpending(page, () => {
    const s = month();
    if (!forgotten) return s;
    return {
      ...s,
      cards: s.cards.map((c) => (c[0] === "card-old" ? [c[0], null, ...c.slice(2)] as typeof c : c)),
      conversations: s.conversations.map((c) => (c[0] === "conv-gone" ? [c[0], null, null, ...c.slice(3)] as typeof c : c)),
    };
  });
  await page.route("**/api/spending/forget", async (route) => {
    forgotten = true;
    await route.fallback();
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By character" }).click();
  await line(page, "Old friend").click();
  const reads = asked.summary.length;
  await detail(page).getByRole("button", { name: "Forget this name" }).click();
  await expect.poll(() => asked.summary.length).toBe(reads + 1);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(line(page, "Deleted character")).toBeVisible();
  await page.getByRole("button", { name: "By conversation" }).click();
  await expect(line(page, "Deleted conversation")).toBeVisible();
  await expect(line(page, "Lost road")).toHaveCount(0);
});

test("clear stays off when nothing would go", async ({ page }) => {
  await answerSpending(page);
  await page.route("**/api/spending?**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "DELETE" || url.searchParams.get("dry_run") !== "1") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ calls: 0, first: null, last: null }) });
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "Clear the history…" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: "Everything" }).check();
  await expect(sheet).toContainText("Nothing to clear before this date.");
  await expect(sheet.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
});

test("a free ai chosen stays free in a period where it made no call", async ({ page }) => {
  await answerSpending(page, (url) => {
    const s = month();
    if (url.searchParams.get("from") !== dayBefore(6)) return s;
    return { ...s, free: s.free.filter(([id]) => id !== "ai-brume") };
  });
  await page.goto("/#/spending");
  await page.getByRole("button", { name: "By conversation" }).click();
  await page.getByRole("combobox").selectOption({ label: "Brume 12B" });
  await expect(page.getByText(`With \u2068Brume 12B\u2069: free`)).toBeVisible();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await expect(page.getByRole("combobox")).toHaveValue("ai-brume");
  await expect(page.getByText(`With \u2068Brume 12B\u2069: free`)).toBeVisible();
  await expect(page.getByText(/^With \u2068Brume 12B\u2069: (nothing|\$)/)).toHaveCount(0);
});
