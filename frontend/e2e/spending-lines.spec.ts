import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK, MOCK_ROOT, answer, boxHears, chat, makeCharacter, misfits, replyEnds, rootAt, turnRunning } from "./fixtures";

/**
 * The lines that lead to Spending (Settings, an AI's page, a conversation's panel, a character's
 * page), the measured figure in My AIs, and what the windows of deletion say is kept. On real
 * replies of the mock model, whose cost MOCK_COSTS_<n> sets in millionths of a dollar.
 */

const MANY = `${MOCK_ROOT}/many/api/v1`;
const LMSTUDIO = `${MOCK_ROOT}/lmstudio/v1`;

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

type Made = { id: string; name: string; service: { id: string } };

/** An AI of its own on a service of its own, so that its sums hold only this test's calls. */
async function aiOn(request: APIRequestContext, base_url: string, family: string, model: string, name: string): Promise<Made> {
  const made = await request.post(`${API}/api/models`, {
    data: { service: { provider: "openai-compatible", base_url, api_key: `sk-lines-${stamp()}`, family }, models: [{ model, name }] },
  });
  expect(made.ok()).toBe(true);
  return (await made.json()).models[0];
}

const pricedAi = (request: APIRequestContext, name: string) => aiOn(request, MANY, "openrouter", "nacre/nacre-chat-8b", name);

async function drop(request: APIRequestContext, ai: Made) {
  await request.delete(`${API}/api/models/${ai.id}`);
  await request.delete(`${API}/api/connections/${ai.service.id}`);
}

/** A conversation with `ai`, whose replies cost `costs` millionths of a dollar and say `says`. */
async function conversationOn(request: APIRequestContext, ai: Made, options: { costs?: number; card?: Record<string, unknown>; title?: string } = {}) {
  const card = await makeCharacter(request, options.card);
  const convo = await (await request.post(`${API}/api/conversations`, { data: { character_id: card.id, model_id: ai.id } })).json();
  const notes = [`MOCK_SAYS_coin`, options.costs !== undefined ? `MOCK_COSTS_${options.costs}` : ""].join(" ");
  await request.patch(`${API}/api/conversations/${convo.id}`, {
    data: { author_note: notes, ...(options.title ? { title: options.title } : {}) },
  });
  return { convo, card };
}

/** The panel of a conversation, opened from its button on a phone. */
async function openPanel(page: Page) {
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toBeVisible();
  return panel;
}

async function closePanel(page: Page, panel: ReturnType<Page["locator"]>) {
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toHaveCount(0);
}

/** Every request to Spending from now on. */
function spendingAsked(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/spending")) urls.push(r.url());
  });
  return urls;
}

async function fits(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), where)
    .toBeLessThanOrEqual(0);
  expect(await misfits(page), where).toEqual([]);
}

/** A line in the screen's width, as tall as a thumb, its words whole within it. */
async function lineFits(page: Page, lead: ReturnType<Page["locator"]>, where: string) {
  const box = (await lead.boundingBox())!;
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box.height, where).toBeGreaterThanOrEqual(44);
  expect(box.x, where).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, where).toBeLessThanOrEqual(width + 0.5);
  expect(await lead.evaluate((el) => el.scrollWidth - el.clientWidth), where).toBeLessThanOrEqual(0);
}

test("settings leads to spending in one tap", async ({ page }) => {
  // Another period kept on this device: the line names 30 days, and opens on them.
  await page.addInitScript(() => localStorage.setItem("evermind:spending:period", "7"));
  await page.goto("/#/settings");
  const lead = page.locator('main a[href="#/spending?per=30"]');
  await expect(lead).toHaveText(/^Spending · (\$[\d,.]+|less than \$0\.01|price not given|\$[\d,.]+ \+ [\d,]+ calls? without a price) in the last 30 days$/);
  // Under the title of My AIs, before its list.
  const box = await lead.boundingBox();
  const title = await page.getByRole("heading", { name: "My AIs" }).boundingBox();
  expect(box!.y).toBeGreaterThan(title!.y);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await lead.click();
  await expect(page).toHaveURL(/#\/spending\?per=30$/);
  await expect(page.locator("[data-total]")).toBeVisible();
  await expect(page.getByRole("button", { name: "30 days", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The period of this visit only: the one kept is still the device's.
  expect(await page.evaluate(() => localStorage.getItem("evermind:spending:period"))).toBe("7");
});

test("an ai's page says what was spent with it and opens it", async ({ page, request }) => {
  const ai = await pricedAi(request, `Lantern ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai, { costs: 2100000 });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.goto(`/#/settings/ai/${ai.id}`);
    const lead = page.locator('main a[href^="#/spending"]');
    await expect(lead).toHaveText(/^Spent with it: \$\d+\.\d\d in the last 30 days$/);
    await expect(lead).toHaveAttribute("href", `#/spending?cut=model&key=${ai.id}&per=30`);

    // What deleting it keeps is said before it goes.
    await page.getByRole("button", { name: "Remove this AI" }).click();
    await expect(page.getByRole("alertdialog")).toContainText("Its spending stays in Spending, under its name.");
    await answer(page, false);

    await lead.click();
    await expect(page).toHaveURL(new RegExp(`#/spending\\?cut=model&key=${ai.id}&per=30$`));
    // The line opened: its sheet, named after the AI.
    await expect(page.locator("[data-line-detail]")).toContainText("Where the amount comes from");
    await expect(page.getByRole("dialog")).toContainText(ai.name.split(" ")[0]);
  } finally {
    await drop(request, ai);
  }
});

test("a price typed on an ai's page says the earlier calls it priced", async ({ page, request }) => {
  // A gateway of no known family: it has no price until one is typed.
  const ai = await aiOn(request, MOCK, "generic", "evermind-demo", `Unpriced ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai);
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.goto(`/#/settings/ai/${ai.id}`);
    const lead = page.locator('main a[href^="#/spending"]');
    await expect(lead).toHaveText("Spent with it: price not given in the last 30 days");
    const read = page.getByLabel("Read", { exact: true });
    if (!(await read.isVisible())) await page.getByText("Advanced", { exact: true }).click();
    await read.fill("3");
    await page.getByLabel("Written", { exact: true }).fill("15");
    await page.getByLabel("Written", { exact: true }).press("Tab");
    await expect(page.getByText("Also applied to your earlier call, which had no price.")).toBeVisible();
    // The line is read again: the call has an amount now.
    await expect(lead).toHaveText(/^Spent with it: (less than \$0\.01|\$\d+\.\d\d) in the last 30 days$/);
  } finally {
    await drop(request, ai);
  }
});

test("the conversation panel follows each reply without asking", async ({ page, request }) => {
  const ai = await pricedAi(request, `Tally ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai, { costs: 1000000 });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.goto(`/#/chat/${convo.id}`);
    const asked = spendingAsked(page);
    let panel = await openPanel(page);
    const lead = panel.locator('a[href^="#/spending"]');
    await expect(lead).toHaveText(/^This conversation: \$\d+\.\d\d since the start$/);
    await expect(lead).toHaveAttribute("href", `#/spending?cut=conversation&key=${convo.id}&per=all`);
    const before = await lead.innerText();
    // Read once, as it first appears.
    expect(asked).toHaveLength(1);
    await closePanel(page, panel);
    // Opened again before any reply: what was read is kept.
    panel = await openPanel(page);
    await expect(lead).toHaveText(before);
    await closePanel(page, panel);
    expect(asked).toHaveLength(1);

    const ended = replyEnds(page, convo.id);
    await page.locator("textarea").first().fill("And then?");
    await page.locator('button[title="Send"]').click();
    await ended;
    panel = await openPanel(page);
    const after = panel.locator('a[href^="#/spending"]');
    await expect(after).toHaveText(/^This conversation: \$\d+\.\d\d since the start$/);
    await expect(after).not.toHaveText(before);
    // The turn's end carried it: nothing was asked of Spending for the reply.
    expect(asked).toHaveLength(1);
  } finally {
    await drop(request, ai);
  }
});

test("a first read that lands after a turn's end does not bring back an older amount", async ({ page, request }) => {
  const ai = await pricedAi(request, `Late ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai, { costs: 1000000 });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: "SLOWLY MOCK_SAYS_coin MOCK_COSTS_1000000" } });
    // A slow link: the panel's first read is answered by the server at once, while the reply is
    // being written, and reaches the page only once the turn has ended.
    let turnEnded!: () => void;
    const over = new Promise<void>((resolve) => (turnEnded = resolve));
    await page.route("**/api/spending/total?**", async (route) => {
      const response = await route.fetch();
      await over;
      await route.fulfill({ response });
    });
    await page.goto(`/#/chat/${convo.id}`);
    const ended = replyEnds(page, convo.id);
    await page.locator("textarea").first().fill("And then?");
    await page.locator('button[title="Send"]').click();
    await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/spending/total");
    const panel = await openPanel(page);
    // What the turn's end said the conversation has cost.
    const now: number = (await ((await ended) as Response).json()).spent.total;
    const lead = panel.locator('a[href^="#/spending"]');
    await expect(lead).toHaveText(`This conversation: $${now.toFixed(2)} since the start`);
    turnEnded();
    expect((await (await read).json()).total).toBeLessThan(now);
    // Whatever the late read would draw is drawn within a frame or two of its landing.
    await page.waitForTimeout(500);
    await expect(lead).toHaveText(`This conversation: $${now.toFixed(2)} since the start`);
  } finally {
    await drop(request, ai);
  }
});

test("a free conversation has no line", async ({ page, request }) => {
  await request.post(`${MOCK_ROOT}/lmstudio/loaded`, { data: { context_length: 32768 } });
  const ai = await aiOn(request, LMSTUDIO, "lmstudio", "brume-12b", `Hearth ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai);
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/spending/total");
    await page.goto(`/#/chat/${convo.id}`);
    const panel = await openPanel(page);
    expect((await (await read).json()).free).toBe(true);
    await expect(panel.locator('a[href^="#/spending"]')).toHaveCount(0);
    await expect(panel).not.toContainText("This conversation:");
  } finally {
    await drop(request, ai);
  }
});

/** The words under the input: what sits between the story's scroll and the page's foot (the status
 *  row, the line of a reply cut short, a failed write, the input and what it says above it). */
async function underTheInput(page: Page): Promise<string> {
  return page.evaluate(() => {
    const box = document.querySelector("textarea")!;
    let input: HTMLElement = box;
    while (!input.querySelector("[data-status-row]")) input = input.parentElement!;
    const said = [input.innerText];
    for (let before = input.previousElementSibling as HTMLElement | null; before; before = before.previousElementSibling as HTMLElement | null) {
      const scrolls = (el: Element) => ["auto", "scroll"].includes(getComputedStyle(el).overflowY) && !el.hasAttribute("data-truncated-text");
      if (scrolls(before) || [...before.querySelectorAll("*")].some(scrolls)) break;
      said.push(before.innerText);
    }
    return said.join("\n");
  });
}

async function noPrice(page: Page, where: string) {
  const said = await underTheInput(page);
  expect(said, where).not.toContain("$");
  expect(said.toLowerCase(), where).not.toContain("price");
  for (const text of await page.locator("[data-status-row]").allInnerTexts()) {
    expect(text, where).not.toContain("$");
    expect(text.toLowerCase(), where).not.toContain("price");
  }
}

test("no price under the input, ever", async ({ page, request }) => {
  test.setTimeout(240_000);
  const ai = await pricedAi(request, `Quiet ${stamp()}`);
  try {
    // Waiting for a first word, being written, refused, cut by the connection, cut by its ceiling.
    for (const how of ["MOCK_QUIET", "SLOWLY", "MOCK_FAILS", "MOCK_FAILS_MIDWAY", "MOCK_HITS_CEILING"]) {
      const { convo } = await conversationOn(request, ai, { costs: 1000000 });
      await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
      await request.patch(`${API}/api/conversations/${convo.id}`, { data: { author_note: `${how} MOCK_SAYS_coin MOCK_COSTS_1000000` } });
      await page.goto("about:blank");
      await page.goto(`/#/chat/${convo.id}`);
      await expect(page.locator("[data-status-row]")).toBeVisible();
      await noPrice(page, `${how}, before`);

      const ended = replyEnds(page, convo.id);
      await page.locator("textarea").first().fill("And then?");
      await page.locator('button[title="Send"]').click();
      await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
      await noPrice(page, `${how}, while it runs`);
      if (how === "SLOWLY") {
        await expect(page.getByText("coin one two")).toBeVisible();
        await noPrice(page, `${how}, being written`);
      }
      await ended;
      if (how === "MOCK_FAILS" || how === "MOCK_FAILS_MIDWAY") await expect(page.getByRole("alert").first()).toBeVisible();
      if (how === "MOCK_HITS_CEILING") await expect(page.locator("[data-ceiling]")).toBeVisible();
      await noPrice(page, `${how}, after`);
    }

    // The panel's line is the one place of the conversation with an amount.
    const panel = await openPanel(page);
    await expect(panel.locator('a[href^="#/spending"]')).toContainText("$");
    await closePanel(page, panel);
    await noPrice(page, "the panel closed");
  } finally {
    await drop(request, ai);
  }
});

test("my ais show what 100 messages really cost once measured", async ({ page, request }) => {
  test.setTimeout(240_000);
  const ai = await pricedAi(request, `Measured ${stamp()}`);
  try {
    const { convo } = await conversationOn(request, ai, { costs: 49000 });
    for (let turn = 0; turn < 20; turn++) {
      await chat(request, { conversation_id: convo.id, mode: "send", content: `${turn}.` });
    }
    await page.goto("/#/settings");
    await expect(page.locator(`main a[href="#/settings/ai/${ai.id}"]`))
      .toContainText("$4.90 per 100 messages, from your last 20 replies");
    await page.goto(`/#/settings/ai/${ai.id}`);
    await expect(page.locator("header")).toContainText("$4.90 per 100 messages, from your last 20 replies");

    // Where an AI is chosen, the estimate stays.
    await page.goto(`/#/chat/${convo.id}`);
    await page.locator("[data-status-row] [data-ai-chip]").click();
    const sheet = page.getByRole("dialog", { name: "Which AI answers?" });
    // Its name is drawn in two pieces, cut where two models of a family differ.
    const row = sheet.getByRole("list").getByRole("button", { name: /^Measured / });
    await expect(row).toContainText(/≈ \S+ per 100 messages/);
    await expect(row).not.toContainText("from your last");
  } finally {
    await drop(request, ai);
  }
});

test("deleting a conversation says its spending stays, and the tick forgets its name", async ({ page, request }) => {
  const ai = await pricedAi(request, `Ledger ${stamp()}`);
  const forgotten = `Forgotten ${stamp()}`;
  const kept = `Kept ${stamp()}`;
  try {
    for (const title of [forgotten, kept]) {
      const { convo } = await conversationOn(request, ai, { costs: 3000000, title });
      await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    }
    const deletes: string[] = [];
    page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));
    await page.goto("/#/chat");

    for (const [title, tick] of [[forgotten, true], [kept, false]] as const) {
      const row = page.locator("main a").filter({ hasText: title });
      await row.getByRole("button", { name: "Delete" }).click();
      const box = page.getByRole("alertdialog");
      await expect(box).toContainText("Its spending stays in Spending, under its name.");
      const forget = box.getByRole("checkbox", { name: "without keeping its name" });
      await expect(forget).not.toBeChecked();
      // Its words are what a finger touches: the label takes the whole height of a thumb.
      if (tick) await box.locator("label", { hasText: "without keeping its name" }).click();
      await expect(forget).toBeChecked({ checked: tick });
      await answer(page, true);
      await expect(row).toHaveCount(0);
    }
    expect(deletes.filter((url) => url.includes("forget_name=1"))).toHaveLength(1);
    expect(deletes.filter((url) => url.includes("/api/conversations/") && !url.includes("forget_name"))).toHaveLength(1);

    await page.goto(`/#/spending?per=all`);
    await page.getByRole("button", { name: "By conversation" }).click();
    const list = page.locator("[data-cut-list]");
    await expect(list.getByRole("button").filter({ hasText: kept })).toContainText("deleted");
    await expect(list.getByRole("button").filter({ hasText: forgotten })).toHaveCount(0);
    await expect(list.getByRole("button").filter({ hasText: "Deleted conversation" }).first()).toBeVisible();
  } finally {
    await drop(request, ai);
  }
});

test("deleting a character says its spending stays", async ({ page, request }) => {
  const card = await makeCharacter(request, { name: `Brief ${stamp()}` });
  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));
  await page.goto(`/#/characters/${card.id}/edit`);
  await page.getByRole("button", { name: "Delete" }).click();
  const box = page.getByRole("alertdialog");
  await expect(box).toContainText("Its spending stays in Spending, under its name.");
  await box.locator("label", { hasText: "without keeping its name" }).click();
  await expect(box.getByRole("checkbox", { name: "without keeping its name" })).toBeChecked();
  await boxHears(page);
  await box.getByRole("button").last().click();
  await expect(page).toHaveURL(/#\/$/);
  expect(deletes.filter((url) => url.includes(`/api/characters/${card.id}?forget_name=1`))).toHaveLength(1);
});

test("the character page line", async ({ page, request }) => {
  const ai = await pricedAi(request, `Weaver ${stamp()}`);
  try {
    const { convo, card } = await conversationOn(request, ai, { costs: 1000000, card: { name: "Nyra" } });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.goto(`/#/characters/${card.id}`);
    const lead = page.locator('main a[href^="#/spending"]');
    await expect(lead).toHaveText(/^Spent with Nyra since the start: \$\d+\.\d\d$/);
    await expect(lead).toHaveAttribute("href", `#/spending?cut=card&key=${card.id}&per=all`);
  } finally {
    await drop(request, ai);
  }
});

test("each line fits a small phone at a 32 px root", async ({ page, request }) => {
  const ai = await pricedAi(request, `Narrow ${stamp()}`);
  try {
    const { convo, card } = await conversationOn(request, ai, { costs: 1000000, card: { name: "Nyra" } });
    await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
    await page.addInitScript(rootAt, "32px");
    await page.setViewportSize({ width: 320, height: 640 });
    for (const [where, address] of [
      ["settings", "/#/settings"], ["its page", `/#/settings/ai/${ai.id}`], ["the character", `/#/characters/${card.id}`],
    ] as const) {
      await page.goto("about:blank");
      await page.goto(address);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
      const lead = page.locator('main a[href^="#/spending"]');
      await expect(lead).toBeVisible();
      await lineFits(page, lead, where);
      // The character's page has controls of its own that do not fit at this size: only its
      // line is measured there.
      if (where !== "the character") await fits(page, where);
    }
    await page.goto("about:blank");
    await page.goto(`/#/chat/${convo.id}`);
    const panel = await openPanel(page);
    await lineFits(page, panel.locator('a[href^="#/spending"]'), "the panel");
    await fits(page, "the panel");
  } finally {
    await drop(request, ai);
  }
});
