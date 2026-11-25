import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import {
  MOCK, addModel, chat, conversation, conversationWithReply, inLocale, makeCharacter, makeConversation, misfits, replyEnds,
  rootAt, stopTurn,
} from "./fixtures";

/**
 * The way a conversation plays, under its input beside the AI's chip: the chip that names it, the
 * sheet that changes it for this conversation alone, what the AI reads, and the way chosen as a
 * conversation is made. The ways are the server's, shared by every test: each test leaves them as
 * the server starts them, the four built in at their own figures, Balanced offered.
 */

interface Way { id: string; built_in: boolean; overridden: boolean }

async function waysAsStarted(request: APIRequestContext) {
  const ways: { ways: Way[] } = await (await request.get(`${API}/api/ways`)).json();
  for (const way of ways.ways) {
    if (way.built_in && way.overridden) await request.post(`${API}/api/ways/${way.id}/reset`);
    if (!way.built_in && way.id !== "mine") await request.delete(`${API}/api/ways/${way.id}`);
  }
  await request.put(`${API}/api/ways/default`, { data: { id: "balanced" } });
}

test.beforeEach(async ({ request }) => waysAsStarted(request));
test.afterEach(async ({ request }) => waysAsStarted(request));

const WAYS = ["Light", "Balanced", "Immersive", "Maximum"];

const statusRow = (page: Page) => page.locator("[data-status-row]");
const chipOf = (page: Page) => statusRow(page).getByRole("button", { name: /^Way to play:/ });
const aiChipOf = (page: Page) => statusRow(page).locator("[data-ai-chip]");
const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Way to play" });
const aiSheetOf = (page: Page) => page.getByRole("dialog", { name: "Which AI answers?" });
const rowOf = (page: Page, name: string) => sheetOf(page).getByRole("radio", { name: new RegExp(`^${name}`) });
const toastOf = (page: Page) => page.locator("[data-chat-toast]");

async function openSheet(page: Page) {
  await chipOf(page).click();
  await expect(sheetOf(page)).toBeVisible();
  // The rows come with the whole outlook, read as the sheet opens.
  await expect(sheetOf(page).getByRole("radio")).toHaveCount(4);
  return sheetOf(page);
}

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** An AI of its own, with what is saved on it. */
const anAi = (request: APIRequestContext, name: string, changes: Record<string, unknown>) =>
  addModel(request, { base_url: MOCK, model: `way-chip-${stamp()}`, name, changes });

async function removeAi(request: APIRequestContext, id: string) {
  await request.delete(`${API}/api/models/${id}`);
}

/** A conversation answered by this AI under this way, with `turns` long messages of the person's
 *  and their replies: past a small AI's reading capacity. */
async function story(request: APIRequestContext, aiId: string, way: string, turns: number) {
  const convo = await makeConversation(request);
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: aiId, play_style: way } });
  const long = "The rain kept on over the harbour and nobody spoke of the ship. ".repeat(30);
  for (let turn = 0; turn < turns; turn++) {
    await chat(request, { conversation_id: convo.id, mode: "send", content: `${turn}. ${long}` });
  }
  return convo;
}

async function noSidewaysScroll(page: Page) {
  const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wider, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

test("switching the way is two taps and the next turn plays it @desktop", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");

  const sheet = await openSheet(page);
  await expect(sheet).toContainText("For this conversation only.");
  await expect(rowOf(page, "Balanced")).toHaveAttribute("aria-checked", "true");
  await rowOf(page, "Light").click();
  await expect(sheet).toHaveCount(0);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Light. Change.");
  expect((await conversation(request, convo.id)).play_style).toBe("light");

  await page.locator("textarea").first().fill("And now?");
  const ends = replyEnds(page, convo.id);
  await page.locator('button[title="Send"]').click();
  await ends;
  const after = await conversation(request, convo.id);
  expect(after.messages.at(-1).meta.context.history_limit).toBe(16);
});

test("adjusted for this conversation only", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const other = await makeConversation(request);
  await page.goto(`/#/chat/${convo.id}`);
  const sheet = await openSheet(page);
  await sheet.getByText("Adjust for this conversation").click();
  await sheet.getByRole("group", { name: "Reply length to aim for" }).getByRole("button", { name: "Long", exact: true }).click();
  await expect(chipOf(page)).toHaveText("Balanced · adjusted");
  await expect.poll(async () => (await conversation(request, convo.id)).play_overrides).toEqual({ reply_length: "long" });
  await expect(sheet.getByRole("group", { name: "Reply length to aim for" }).getByRole("button", { name: "Long", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await sheet.getByRole("button", { name: "Back to Balanced as it is" }).click();
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");
  expect((await conversation(request, convo.id)).play_overrides).toBeNull();

  // Adjusted again, then another conversation: it stays as it was.
  await sheet.getByRole("group", { name: "Reply length to aim for" }).getByRole("button", { name: "Short", exact: true }).click();
  await expect(chipOf(page)).toHaveText("Balanced · adjusted");
  await page.goto(`/#/chat/${other.id}`);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");
  expect((await conversation(request, other.id)).play_overrides).toBeNull();
});

test("a small ai under immersive says it rereads n of 60 on the chip and in the sheet", async ({ page, request }) => {
  test.setTimeout(180_000);
  const small = await anAi(request, `Small ${stamp()}`, { context_own: 4096 });
  try {
    const convo = await story(request, small.id, "immersive", 40);
    await page.goto(`/#/chat/${convo.id}`);
    await expect(chipOf(page)).toHaveText(/^Immersive · rereads \d+ of 60$/);
    await expect(chipOf(page)).toHaveAccessibleName(/^Way to play: Immersive\. Its reading capacity is full: it rereads \d+ messages of 60\. Change\.$/);

    const sheet = await openSheet(page);
    await expect(sheet).toContainText(/rereads \d+ of the 60 asked/);
    await expect(sheet).toContainText("Its reading capacity is full");
    await sheet.getByText("Why", { exact: true }).click();
    await expect(sheet.getByText(/^In Light, it would reread \d+\.$/)).toBeVisible();
    await expect(sheet).toContainText("That is the model's limit, not Evermind's");
    await expect(sheet).toContainText(/In tokens: card [\d,]+ · reminders [\d,]+ · messages reread [\d,]+ · room for the reply 2,048 · capacity 4,096/);
  } finally {
    await removeAi(request, small.id);
  }
});

test("the current ai costs the same in both sheets", async ({ page, request }) => {
  // A short name, which the sheet does not cut in the middle; a capacity said, so that pages are.
  const priced = await anAi(request, `Dear ${Math.random().toString(36).slice(2, 6)}`, {
    price_own_in: 3, price_own_out: 15, context_own: 32768,
  });
  try {
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: priced.id } });
    await page.goto(`/#/chat/${convo.id}`);

    // The way as it is, then adjusted: longer replies cost more, and both sheets count the adjusted.
    let sheet = await openSheet(page);
    const plain = await rowOf(page, "Balanced").locator("[data-estimate]").textContent();
    expect(plain).toContain("per 100 messages");
    await sheet.getByText("Adjust for this conversation").click();
    await sheet.getByRole("group", { name: "Reply length to aim for" }).getByRole("button", { name: "Long", exact: true }).click();
    await expect(chipOf(page)).toHaveText("Balanced · adjusted");
    await expect(rowOf(page, "Balanced").locator("[data-estimate]")).not.toHaveText(plain!);
    const adjusted = await rowOf(page, "Balanced").locator("[data-estimate]").textContent();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);

    await aiChipOf(page).click();
    const aiRow = aiSheetOf(page).getByRole("radio", { name: new RegExp(`^${priced.name}`) });
    // Under the conversation's way: the row also says what this AI rereads of it.
    await expect(aiRow).toContainText(/Rereads 1 of the 1 messages · ≈ \d+ pages? sent/);
    await expect(aiRow.locator("[data-estimate]")).toHaveText(adjusted!);
    await aiSheetOf(page).getByRole("button", { name: "Close" }).click();

    // Opened again, the way's sheet still says the adjusted figure for the way played.
    sheet = await openSheet(page);
    await expect(rowOf(page, "Balanced").locator("[data-estimate]")).toHaveText(adjusted!);
  } finally {
    await removeAi(request, priced.id);
  }
});

test("an ai whose capacity is not said is given no pages in either sheet", async ({ page, request }) => {
  const untold = await anAi(request, `Open ${stamp()}`, { reply_cap: { mode: "unsent" } });
  try {
    const ais = await (await request.get(`${API}/api/models`)).json();
    // Neither typed nor read: Evermind counts with a size of its own.
    expect(["own", "read"]).not.toContain(ais.find((ai: { id: string }) => ai.id === untold.id).context.source);
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: untold.id } });
    await page.goto(`/#/chat/${convo.id}`);
    await expect(aiChipOf(page)).toHaveAccessibleName(`AI: ${untold.name}. Change.`);

    const sheet = await openSheet(page);
    await expect(sheet).toContainText("Rereads 1 messages, all it was asked");
    await expect(sheet).not.toContainText(`What ${untold.name} reads`);
    await expect(sheet.locator("[data-reading-bar]")).toHaveCount(0);
    await expect(sheet).not.toContainText("capacity");
    for (const name of WAYS) {
      await expect(rowOf(page, name)).toContainText("Rereads 1 of the 1 messages");
      await expect(rowOf(page, name)).not.toContainText("pages");
    }
    await sheet.getByRole("button", { name: "Close" }).click();

    await aiChipOf(page).click();
    const aiRow = aiSheetOf(page).getByRole("radio", { checked: true });
    await expect(aiRow).toContainText(untold.name);
    await expect(aiRow).toContainText("reading capacity not given");
    await expect(aiRow).toContainText("Rereads 1 of the 1 messages");
    await expect(aiRow).not.toContainText("pages");
  } finally {
    await removeAi(request, untold.id);
  }
});

test("the notices under the list say only what holds", async ({ page, request }) => {
  const unsent = await anAi(request, `Open ${stamp()}`, { reply_cap: { mode: "unsent" } });
  const fixed = await anAi(request, `Fixed ${stamp()}`, { reply_cap: { mode: "fixed", tokens: 2048 } });
  try {
    // Balanced keeps 1,024 for a reply: what an AI sent no ceiling has already.
    const underBalanced = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${underBalanced.id}`, { data: { model_id: unsent.id } });
    // A ceiling of 2,048 cuts no reply a way asks for.
    const underImmersive = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${underImmersive.id}`, { data: { model_id: fixed.id, play_style: "immersive" } });
    for (const [convo, ai] of [[underBalanced, unsent], [underImmersive, fixed]] as const) {
      await page.goto(`/#/chat/${convo.id}`);
      await expect(aiChipOf(page)).toHaveAccessibleName(`AI: ${ai.name}. Change.`);
      const sheet = await openSheet(page);
      await expect(sheet).not.toContainText("is sent no ceiling");
      await expect(sheet).not.toContainText("keeps a ceiling of");
      await expect(sheet.getByRole("button", { name: "Keep the room long replies need" })).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: "Let Evermind set it" })).toHaveCount(0);
    }
  } finally {
    for (const ai of [unsent, fixed]) await removeAi(request, ai.id);
  }
});

test("no price under the input, whatever the way and the ai", async ({ page, request }) => {
  const priced = await anAi(request, `Priced ${stamp()}`, { price_own_in: 3, price_own_out: 15 });
  try {
    const convo = await makeConversation(request);
    for (const [id, name] of [["light", "Light"], ["balanced", "Balanced"], ["immersive", "Immersive"], ["maximum", "Maximum"]]) {
      await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: priced.id, play_style: id } });
      await page.goto(`/#/chat/${convo.id}`);
      await page.reload();
      await expect(chipOf(page)).toContainText(name);
      await expect(aiChipOf(page)).toHaveAccessibleName(`AI: ${priced.name}. Change.`);
      for (const word of ["$", "free", "per 100"]) {
        await expect(statusRow(page), `${word} under the input in ${name}`).not.toContainText(word);
      }
    }
  } finally {
    await removeAi(request, priced.id);
  }
});

test("a way removed on another device leaves the chip on the default", async ({ page, request }) => {
  const made = await (await request.post(`${API}/api/ways`, { data: { from: "balanced", name: "Harbour nights" } })).json();
  const turned = await conversationWithReply(request);
  const reopened = await makeConversation(request);
  for (const convo of [turned, reopened]) {
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { play_style: made.id } });
  }

  await page.goto(`/#/chat/${turned.id}`);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Harbour nights. Change.");
  await request.delete(`${API}/api/ways/${made.id}`);
  await page.locator("textarea").first().fill("Still there?");
  const ends = replyEnds(page, turned.id);
  await page.locator('button[title="Send"]').click();
  await ends;
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");

  const again = await (await request.post(`${API}/api/ways`, { data: { from: "balanced", name: "Harbour mornings" } })).json();
  await request.patch(`${API}/api/conversations/${reopened.id}`, { data: { play_style: again.id } });
  await page.goto(`/#/chat/${reopened.id}`);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Harbour mornings. Change.");
  await request.delete(`${API}/api/ways/${again.id}`);
  await chipOf(page).click();
  await expect(rowOf(page, "Balanced")).toHaveAttribute("aria-checked", "true");
  await expect(sheetOf(page).getByRole("radio", { name: /^Harbour/ })).toHaveCount(0);
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");
});

test("a way changed elsewhere shows when the sheet opens again", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  for (let turn = 0; turn < 3; turn++) {
    await chat(request, { conversation_id: convo.id, mode: "send", content: `Turn ${turn}.` });
  }
  await page.goto(`/#/chat/${convo.id}`);
  const sheet = await openSheet(page);
  await expect(rowOf(page, "Balanced")).toContainText("Rereads 9 of the 9 messages");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);

  expect((await request.put(`${API}/api/ways/balanced`, { data: { history_limit: 4 } })).ok()).toBe(true);
  await openSheet(page);
  await expect(rowOf(page, "Balanced")).toContainText("Rereads 4 of the 9 messages");
});

test("a turn that ends with the sheet open leaves it its rows, counted again", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Slowly now.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  await openSheet(page);
  await expect(rowOf(page, "Balanced")).toContainText("Rereads 4 of the 4 messages");
  // The reply ends while the sheet is open: the turn's end reads it all again.
  await stopTurn(request, convo.id);
  await expect(rowOf(page, "Balanced")).toContainText("Rereads 5 of the 5 messages");
  await expect(sheetOf(page).getByRole("radio")).toHaveCount(4);
});

test("a turn that ends with the ais' sheet open leaves its rows their figures, counted again", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { slowly: true });
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Slowly now.");
  await page.locator('button[title="Send"]').click();
  await expect(page.locator('button[title="Stop generation"]')).toBeVisible();
  await aiChipOf(page).click();
  const row = aiSheetOf(page).getByRole("radio", { checked: true });
  await expect(row).toContainText("Rereads 4 of the 4 messages");
  await stopTurn(request, convo.id);
  await expect(row).toContainText("Rereads 5 of the 5 messages");
});

test("the sheet answers the touch before anything it shows has come", async ({ page, request }) => {
  const convo = await makeConversation(request);
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  // The chip's short read never comes; the whole one waits until the test lets it.
  await page.route(`**/api/conversations/${convo.id}/outlook**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("only") === "current") return;
    await released;
    await route.continue();
  });
  await page.goto(`/#/chat/${convo.id}`);
  await chipOf(page).click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("For this conversation only.");
  await expect(sheet.locator("[aria-busy=true]")).toHaveCount(1);
  expect(await misfits(page, "dialog")).toEqual([]);
  release();
  await expect(sheet.getByRole("radio")).toHaveCount(4);
  await expect(rowOf(page, "Balanced")).toHaveAttribute("aria-checked", "true");
});

test("a failed switch keeps the sheet open and the chip as it was", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.route(`**/api/conversations/${convo.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "text/html", body: "<html>Server error</html>" })
      : route.continue());
  await page.goto(`/#/chat/${convo.id}`);
  const sheet = await openSheet(page);
  await rowOf(page, "Light").click();
  await expect(sheet.getByRole("alert")).not.toBeEmpty();
  await expect(sheet).toBeVisible();
  await expect(rowOf(page, "Light")).toHaveAttribute("aria-checked", "false");
  await expect(rowOf(page, "Light")).not.toHaveAttribute("aria-busy", "true");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Balanced. Change.");
  expect((await conversation(request, convo.id)).play_style).toBe("balanced");
});

test("the long room notice lets evermind set it", async ({ page, request }) => {
  const unsent = await anAi(request, `Open ${stamp()}`, { reply_cap: { mode: "unsent" } });
  try {
    const convo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { model_id: unsent.id, play_style: "immersive" } });
    await page.goto(`/#/chat/${convo.id}`);
    const sheet = await openSheet(page);
    const notice = sheet.getByText(
      `${unsent.name} is sent no ceiling, and Evermind keeps it only 1,024 tokens: a long reply may not fit in what it reads.`,
    );
    await expect(notice).toBeVisible();
    const list = (await sheet.getByRole("radiogroup").boundingBox())!;
    expect((await notice.boundingBox())!.y, "the notice is not under the list").toBeGreaterThan(list.y + list.height - 1);

    await sheet.getByRole("button", { name: "Keep the room long replies need" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(toastOf(page)).toContainText(`${unsent.name} no longer has a ceiling of its own`);
    const ais = await (await request.get(`${API}/api/models`)).json();
    expect(ais.find((ai: { id: string }) => ai.id === unsent.id).reply_cap.mode).toBe("auto");
  } finally {
    await removeAi(request, unsent.id);
  }
});

test("the four ways are in sight on opening", async ({ page, request }) => {
  test.setTimeout(120_000);
  const roomy = await anAi(request, `Roomy ${stamp()}`, { context_own: 32768 });
  const capped = await anAi(request, `Capped ${stamp()}`, { reply_cap: { mode: "fixed", tokens: 1024 } });
  const small = await anAi(request, `Small ${stamp()}`, { context_own: 4096 });
  try {
    const roomyConvo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${roomyConvo.id}`, { data: { model_id: roomy.id } });
    const cappedConvo = await makeConversation(request);
    await request.patch(`${API}/api/conversations/${cappedConvo.id}`, { data: { model_id: capped.id, play_style: "immersive" } });
    const fullConvo = await story(request, small.id, "immersive", 10);
    for (const [width, height] of [[390, 667], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const [convo, what] of [[roomyConvo, "roomy"], [cappedConvo, "capped"], [fullConvo, "full"]] as const) {
        await page.goto(`/#/chat/${convo.id}`);
        const sheet = await openSheet(page);
        if (what === "capped") await expect(sheet).toContainText("keeps a ceiling of 1,024 tokens per reply");
        if (what === "full") await expect(sheet).toContainText("Its reading capacity is full");
        for (const name of WAYS) {
          await expect(rowOf(page, name), `${name}, ${what}, at ${width}x${height}`).toBeInViewport({ ratio: 1 });
        }
        await sheet.getByRole("button", { name: "Close" }).click();
      }
    }
  } finally {
    for (const ai of [roomy, capped, small]) await removeAi(request, ai.id);
  }
});

test("at very large text the four ways stay in reach", async ({ page, request }) => {
  const small = await anAi(request, `Small ${stamp()}`, { context_own: 4096 });
  try {
    const convo = await story(request, small.id, "immersive", 6);
    await page.addInitScript(rootAt, "32px");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/chat/${convo.id}`);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
    await openSheet(page);
    await expect(rowOf(page, "Light")).toBeInViewport({ ratio: 1 });
    const balanced = (await rowOf(page, "Balanced").boundingBox())!;
    expect(balanced.y, "Balanced does not begin in view").toBeLessThan(844);
    const bar = (await sheetOf(page).locator("[data-reading-bar]").boundingBox())!;
    const last = (await rowOf(page, "Maximum").boundingBox())!;
    expect(bar.y, "the bar is not under the list").toBeGreaterThan(last.y + last.height - 1);

    // The narrowest phone, its folds open: nothing in the sheet slides sideways.
    await page.setViewportSize({ width: 320, height: 640 });
    for (const summary of await sheetOf(page).locator("summary").all()) await summary.click();
    const sideways = await sheetOf(page).evaluate((sheet) => {
      const body = sheet.querySelector("[data-sheet] .overflow-y-auto")!;
      return body.scrollWidth - body.clientWidth;
    });
    expect(sideways, "the sheet slides sideways at 320px").toBeLessThanOrEqual(0);
    expect(await misfits(page, "dialog")).toEqual([]);

    // Each fold's title whole in each language, German's words the longest, on both phones.
    for (const locale of ["en", "fr", "de", "es"]) {
      await inLocale(page, locale);
      for (const [width, height] of [[390, 844], [320, 640]]) {
        await page.setViewportSize({ width, height });
        await page.reload();
        await statusRow(page).locator("[data-way-chip]").click();
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByRole("radio")).toHaveCount(4);
        const cut = await dialog.evaluate((sheet) => [...sheet.querySelectorAll("summary")]
          .filter((summary) => summary.scrollWidth > summary.clientWidth)
          .map((summary) => `"${summary.textContent}" ${summary.scrollWidth} wide in ${summary.clientWidth}`));
        expect(cut, `in ${locale} at ${width}px`).toEqual([]);
        expect(await misfits(page, "dialog"), `in ${locale} at ${width}px`).toEqual([]);
      }
    }
  } finally {
    await removeAi(request, small.id);
  }
});

test("the header has no context bar any more @desktop", async ({ page, request }) => {
  const convo = await conversationWithReply(request);
  await page.goto(`/#/chat/${convo.id}`);
  await page.locator("textarea").first().fill("Once more.");
  const ends = replyEnds(page, convo.id);
  await page.locator('button[title="Send"]').click();
  await ends;
  await expect(page.locator("[data-message-id]")).toHaveCount(5);
  const header = page.locator("header").first();
  await expect(header).not.toContainText("%");
  await expect(header).not.toContainText("t/s");
});

test("a new conversation is made with the way chosen", async ({ page, request }) => {
  const character = await makeCharacter(request, { name: "Ilse" });
  await page.goto(`/#/characters/${character.id}`);
  await page.getByRole("button", { name: "Start a conversation" }).click();
  const dialog = page.getByRole("dialog", { name: "Join Ilse" });
  const select = dialog.getByLabel("Way to play");
  await expect(select).toHaveValue("balanced");
  await select.selectOption({ label: "Light" });
  await dialog.getByRole("button", { name: "Enter the story" }).click();
  await expect(page).toHaveURL(/#\/chat\/[^/]+$/);
  const id = new URL(page.url()).hash.split("/").at(-1)!;
  expect((await conversation(request, id)).play_style).toBe("light");
  await expect(chipOf(page)).toHaveAccessibleName("Way to play: Light. Change.");
});

test("the chip row wraps rather than hide", async ({ page, request }) => {
  const long = await anAi(request, "Obsidienne R1 Distill Llama 70B Instruct", { context_own: 4096 });
  try {
    const convo = await story(request, long.id, "immersive", 6);
    await request.patch(`${API}/api/conversations/${convo.id}`, { data: { play_overrides: { reminders: "essential" } } });
    for (const [width, height] of [[390, 844], [360, 740], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`/#/chat/${convo.id}`);
      await expect(chipOf(page)).toHaveText(/^Immersive · adjusted · rereads \d+ of 13$/);
      for (const said of await statusRow(page).locator(":scope > *").all()) {
        const edge = (await said.boundingBox())!;
        expect(edge.x, `something on the row starts off the screen at ${width}px`).toBeGreaterThanOrEqual(0);
        expect(edge.x + edge.width, `something on the row is off the screen at ${width}px`).toBeLessThanOrEqual(width);
      }
      expect(await misfits(page, "[data-status-row]"), `at ${width}px`).toEqual([]);
      await noSidewaysScroll(page);
    }
  } finally {
    await removeAi(request, long.id);
  }
});
