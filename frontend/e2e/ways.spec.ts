import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK, addModel, answer, chat, conversation, conversationWithReply, inLocale, makeConversation, misfits, rootAt } from "./fixtures";

/**
 * The ways to play in Settings, and the page of each. The ways are the server's, shared by every
 * test: each test leaves them as the server starts them, the four built in at their own figures,
 * none of a person's own, Balanced offered.
 */

interface Way {
  id: string;
  name: string | null;
  built_in: boolean;
  overridden: boolean;
  conversations: number;
  history_limit: number;
  reply_length: string;
  reply_room: number | null;
  facts_cap: number | null;
  max_facts: number | null;
  lore_cap: number | null;
  lore_share: number | null;
  passage_cap: number | null;
  passage_share: number | null;
}
interface Ways { default: string; passages_available: boolean; ways: Way[] }

const BUILT_IN = ["light", "balanced", "immersive", "maximum"];
const NAMES: Record<string, string> = { light: "Light", balanced: "Balanced", immersive: "Immersive", maximum: "Maximum" };

async function waysOf(request: APIRequestContext): Promise<Ways> {
  return (await request.get(`${API}/api/ways`)).json();
}

async function wayOf(request: APIRequestContext, id: string): Promise<Way | undefined> {
  return (await waysOf(request)).ways.find((way) => way.id === id);
}

/** The ways back as the server starts them. A way of a person's own that the update brought over
 *  from the settings of before ("mine") stays: it is the database's, not a test's. */
async function waysAsStarted(request: APIRequestContext) {
  const ways = await waysOf(request);
  for (const way of ways.ways) {
    if (way.built_in && way.overridden) await request.post(`${API}/api/ways/${way.id}/reset`);
    if (!way.built_in && way.id !== "mine") await request.delete(`${API}/api/ways/${way.id}`);
  }
  await request.put(`${API}/api/ways/default`, { data: { id: "balanced" } });
}

test.beforeEach(async ({ request }) => waysAsStarted(request));
test.afterEach(async ({ request }) => waysAsStarted(request));

/** A choice of a way's page, by the name of its group and its own. */
const choice = (page: Page, group: string, name: string) =>
  page.getByRole("group", { name: group }).getByRole("button", { name, exact: true });

async function openWay(page: Page, id: string) {
  await page.goto(`/#/settings/way/${id}`);
  await expect(page.getByRole("group", { name: "Messages reread before each reply" })).toBeVisible();
}

test("settings lists the four ways with their sentence, the default and their conversations @desktop", async ({ page, request }) => {
  const ways = await waysOf(request);
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "Ways to play" })).toBeVisible();
  const sentences: Record<string, string> = {
    light: "Short replies, rereads the last 16 messages, reminders kept to the essentials. Quick and thrifty: for a small AI or a tight budget.",
    balanced: "Replies of 1 to 3 paragraphs, rereads the last 24 messages. Evermind's original setting, figure for figure.",
    immersive: "Long replies, rereads the last 60 messages, more reminders. For AIs that read a lot at once.",
    maximum: "Rereads the whole story, as much as the AI can read at once. Long replies, rich reminders. The most faithful, and the dearest on a paid AI.",
  };
  for (const id of BUILT_IN) {
    const line = page.locator(`main a[href="#/settings/way/${id}"]`);
    await expect(line).toContainText(NAMES[id]);
    await expect(line).toContainText(sentences[id]);
    const count = (ways.ways.find((way) => way.id === id) as Way).conversations;
    await expect(line).toContainText(count === 1 ? "1 conversation" : `${count} conversations`);
    if (id === "balanced") await expect(line.getByText("Default", { exact: true })).toBeVisible();
    else await expect(line.getByText("Default", { exact: true })).toHaveCount(0);
  }
  // Between My AIs and the display.
  const order = await page.locator("main h2").allTextContents();
  expect(order.indexOf("Ways to play")).toBe(order.indexOf("My AIs") + 1);
});

test("a choice saves at a touch and the next turn plays it", async ({ page, request }) => {
  const convo = await conversationWithReply(request, { says: "rain" });
  for (let turn = 0; turn < 9; turn++) {
    await chat(request, { conversation_id: convo.id, mode: "send", content: `Turn ${turn}.` });
  }
  await openWay(page, "balanced");
  const reread = page.getByRole("group", { name: "Messages reread before each reply" });
  await expect(reread.getByRole("button", { name: "24", exact: true })).toHaveAttribute("aria-pressed", "true");
  await reread.getByRole("button", { name: "16", exact: true }).click();
  await expect(reread.getByText("Saved.")).toBeVisible();
  await expect(reread.getByRole("button", { name: "16", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await wayOf(request, "balanced"))?.history_limit).toBe(16);

  await chat(request, { conversation_id: convo.id, mode: "send", content: "And now?" });
  const after = await conversation(request, convo.id);
  expect(after.messages.length).toBeGreaterThan(16);
  expect(after.messages.at(-1).meta.context.messages_included).toBe(16);
});

test("original values bring a built-in back", async ({ page, request }) => {
  await openWay(page, "balanced");
  await choice(page, "Messages reread before each reply", "60").click();
  await expect.poll(async () => (await wayOf(request, "balanced"))?.overridden).toBe(true);
  await page.getByRole("button", { name: "Original values" }).click();
  await expect(choice(page, "Messages reread before each reply", "24")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await wayOf(request, "balanced"))?.overridden).toBe(false);
  await expect(page.getByRole("button", { name: "Original values" })).toHaveCount(0);
});

test("a copy opens, is renamed, offered to new conversations, then deleted, its conversations moving to balanced", async ({ page, request }) => {
  await openWay(page, "balanced");
  await page.getByRole("button", { name: "Make a copy" }).click();
  await expect(page).not.toHaveURL(/#\/settings\/way\/balanced$/);
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue("Balanced (copy)");
  const id = decodeURIComponent(page.url().split("/settings/way/")[1]);
  expect(BUILT_IN).not.toContain(id);

  await name.fill("Night shift");
  await name.press("Enter");
  await expect(page.locator("header").getByText("Saved.")).toBeVisible();
  await expect.poll(async () => (await wayOf(request, id))?.name).toBe("Night shift");

  await page.getByRole("button", { name: "Offer Night shift to new conversations" }).click();
  await expect(page.getByText("Offered to new conversations.")).toBeVisible();
  expect((await waysOf(request)).default).toBe(id);

  const convo = await makeConversation(request);
  expect(convo.play_style).toBe(id);

  await page.getByRole("button", { name: "Delete this way to play" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("1 conversation will move to Balanced.");
  await answer(page, true);
  await expect(page).toHaveURL(/#\/settings$/);
  const left = await waysOf(request);
  expect(left.ways.map((way) => way.id)).not.toContain(id);
  expect(left.default).toBe("balanced");
  expect((await conversation(request, convo.id)).play_style).toBe("balanced");
});

test("a length keeps the room it needs, and reminders bring their whole level, each saved under its own choice", async ({ page, request }) => {
  await openWay(page, "balanced");
  const reread = page.getByRole("group", { name: "Messages reread before each reply" });
  const length = page.getByRole("group", { name: "Reply length to aim for" });
  const reminders = page.getByRole("group", { name: "Reminders of the world and of what happened" });

  await length.getByRole("button", { name: "Long", exact: true }).click();
  await expect(length.getByText("Saved.")).toBeVisible();
  await expect(reread.getByText("Saved.")).toHaveCount(0);
  await expect(reminders.getByText("Saved.")).toHaveCount(0);
  await expect.poll(async () => {
    const way = await wayOf(request, "balanced");
    return [way?.reply_length, way?.reply_room];
  }).toEqual(["long", 2048]);

  await reminders.getByRole("button", { name: "Rich", exact: true }).click();
  await expect(reminders.getByText("Saved.")).toBeVisible();
  await expect(reminders.getByRole("button", { name: "Rich", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => {
    const way = await wayOf(request, "balanced");
    return [way?.facts_cap, way?.max_facts, way?.lore_cap, way?.lore_share, way?.passage_cap, way?.passage_share];
  }).toEqual([4000, 120, 1600, 0.06, 3000, 0.1]);
});

test("reminders of no level show custom, pressed and not to be chosen", async ({ page, request }) => {
  await request.put(`${API}/api/ways/balanced`, { data: { max_facts: 7 } });
  await openWay(page, "balanced");
  const custom = choice(page, "Reminders of the world and of what happened", "Custom");
  await expect(custom).toHaveAttribute("aria-pressed", "true");
  await expect(custom).toBeDisabled();
  for (const level of ["Essentials", "Normal", "Rich", "No cap"]) {
    await expect(choice(page, "Reminders of the world and of what happened", level)).toHaveAttribute("aria-pressed", "false");
  }
});

test("a figure the server refuses is said under its field, which shows what is kept", async ({ page }) => {
  await openWay(page, "balanced");
  await page.getByText("Advanced: the exact values").click();
  const most = page.getByRole("textbox", { name: "Remembered facts: how many at most" });
  await expect(most).toHaveValue("60");
  await most.fill("0");
  await most.press("Tab");
  await expect(most.locator("..").getByRole("alert")).toBeVisible();
  await expect(most).toHaveValue("60");
});

test("the history field emptied saves nothing and shows the figure kept", async ({ page, request }) => {
  await openWay(page, "balanced");
  await page.getByText("Advanced: the exact values").click();
  const saved: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "PUT" && new URL(sent.url()).pathname.startsWith("/api/ways/")) saved.push(sent.url());
  });
  const history = page.getByRole("textbox", { name: "Messages reread (0: all)" });
  await expect(history).toHaveValue("24");
  await history.fill("");
  await history.press("Tab");
  await expect(history).toHaveValue("24");
  // Past the pause that saves what is typed: nothing went.
  await page.waitForTimeout(1000);
  expect(saved).toEqual([]);
  expect((await wayOf(request, "balanced"))?.history_limit).toBe(24);
});

test("a share is shown in whole per cent", async ({ page, request }) => {
  const copy = await (await request.post(`${API}/api/ways`, { data: { from: "balanced", name: "Seven" } })).json() as Way;
  await request.put(`${API}/api/ways/${copy.id}`, { data: { lore_share: 0.07 } });
  await openWay(page, copy.id);
  await page.getByText("Advanced: the exact values").click();
  const lore = page.getByRole("group", { name: "Pages of the world: at most (tokens)" });
  await expect(lore.getByRole("textbox", { name: "or share of what it reads (%)" })).toHaveValue("7");
});

test("with a priced default ai, each way says what 100 messages cost, and the card names that ai first", async ({ page, request }) => {
  const stamp = Date.now();
  const priced = await addModel(request, {
    base_url: MOCK, model: `priced-${stamp}`, name: `Priced ${stamp}`,
    changes: { context_own: 32768, price_own_in: 0.2, price_own_out: 0.6, is_default: true },
  });
  try {
    await page.goto("/#/settings");
    for (const id of BUILT_IN) {
      await expect(page.locator(`main a[href="#/settings/way/${id}"]`)).toContainText("per 100 messages");
    }
    await openWay(page, "balanced");
    await expect(page.getByLabel("With", { exact: true }).locator("option").first()).toHaveText(priced.name);
    await expect(page.getByLabel("With", { exact: true })).toHaveValue(priced.id);
  } finally {
    await request.delete(`${API}/api/models/${priced.id}`);
    const e2e = ((await (await request.get(`${API}/api/models`)).json()) as { id: string; name: string }[])
      .find((ai) => ai.name === "e2e");
    if (e2e) await request.put(`${API}/api/models/${e2e.id}`, { data: { is_default: true } });
  }
});

test("the reading card says when the capacity is full and what light would do", async ({ page, request }) => {
  const small = await addModel(request, {
    base_url: MOCK, model: `small-${Date.now()}`, name: `Small ${Date.now()}`, changes: { context_own: 8192 },
  });
  try {
    await openWay(page, "immersive");
    await page.getByLabel("With", { exact: true }).selectOption({ label: small.name });
    await expect(page.getByText(/^Its reading capacity is full: it rereads \d+ of the 60 messages asked\./)).toBeVisible();
    await expect(page.getByText(/^In Light, it would reread \d+\.$/)).toBeVisible();
  } finally {
    await request.delete(`${API}/api/models/${small.id}`);
  }
});

test("old passages say when they cannot work", async ({ page }) => {
  await page.route("**/api/ways", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const served = await route.fetch();
    await route.fulfill({ response: served, json: { ...(await served.json()), passages_available: false } });
  });
  await openWay(page, "balanced");
  await page.getByText("Advanced: the exact values").click();
  await expect(page.getByText("Not available on this install: the search-by-meaning module is not installed.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Old passages brought back" })).toHaveCount(0);
  // The other figures are still there.
  await expect(page.getByRole("textbox", { name: "Pages of the world: at most (tokens)" })).toBeVisible();
});

test("a number typed sets the cap and clears the share", async ({ page, request }) => {
  const copy = await (await request.post(`${API}/api/ways`, { data: { from: "immersive", name: "Wide" } })).json() as Way;
  // Immersive keeps both a cap and a share of the lorebook.
  expect(copy.lore_cap).not.toBeNull();
  expect(copy.lore_share).not.toBeNull();
  await openWay(page, copy.id);
  await page.getByText("Advanced: the exact values").click();
  const lore = page.getByRole("group", { name: "Pages of the world: at most (tokens)" });
  const cap = lore.getByRole("textbox", { name: "Pages of the world: at most (tokens)" });
  const share = lore.getByRole("textbox", { name: "or share of what it reads (%)" });
  await expect(share).toHaveValue("6");

  await cap.fill("1200");
  await expect.poll(async () => {
    const way = await wayOf(request, copy.id);
    return [way?.lore_cap, way?.lore_share];
  }).toEqual([1200, null]);
  await expect(share).toHaveValue("");

  await share.fill("5");
  await expect.poll(async () => {
    const way = await wayOf(request, copy.id);
    return [way?.lore_cap, way?.lore_share];
  }).toEqual([null, 0.05]);
  await expect(cap).toHaveValue("");
});

// Text at its own size and at its largest, on two phones: the choices keep whole, side by side or
// each taken to the next line, and nothing slides the page sideways.
test.describe("nothing scrolls sideways at 390, 320 and a 32 px root, the four choices in sight", () => {
  for (const locale of ["en", "fr"]) {
    test(`in ${locale}`, async ({ page }) => {
      await inLocale(page, locale);
      for (const root of ["16px", "32px"]) {
        if (root === "32px") await page.addInitScript(rootAt, root);
        for (const size of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
          const at = `at ${size.width}px, a root of ${root}`;
          await page.setViewportSize(size);
          await page.goto("about:blank");
          await page.goto("/#/settings");
          await expect(page.locator("main a[href='#/settings/way/maximum']")).toBeVisible();
          await page.waitForLoadState("networkidle");
          expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(root);
          expect(await misfits(page), `settings ${at}`).toEqual([]);

          await page.goto("about:blank");
          await page.goto("/#/settings/way/balanced");
          const groups = page.locator("main [role=group]:has(button[aria-pressed])");
          await expect(groups).toHaveCount(3);
          await page.waitForLoadState("networkidle");
          expect(await misfits(page), `a way's page ${at}`).toEqual([]);
          // Every choice whole on the screen: none narrower than a finger, none past an edge.
          const off = await groups.locator("button").evaluateAll((all) => all
            .map((el) => el.getBoundingClientRect())
            .filter((box) => box.left < 0 || box.right > document.documentElement.clientWidth || box.height < 44)
            .map((box) => `${Math.round(box.left)}..${Math.round(box.right)} × ${Math.round(box.height)}`));
          expect(off, `a choice cut ${at}`).toEqual([]);
          await page.locator("main details summary").click();
          await expect(page.locator("main details[open]")).toHaveCount(1);
          expect(await misfits(page), `a way's page, its exact values open, ${at}`).toEqual([]);
        }
      }
    });
  }
});
