import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MOCK, MOCK_ROOT, addModel, forgetServices, inLocale, makeConversation, misfits, rootAt, routeServiceTo,
} from "./fixtures";

/**
 * Adding AIs from Settings. The chips name the real services' addresses: OpenRouter's is sent to
 * the mock server's, whose paths choose its answer (scripts/mock_llm.py): /many/ its list of 471
 * models in OpenRouter's shape, /slow/ the same late, /broken/ a failure, /empty/ no model, and
 * /locked/ a key refused but for one.
 */

const OPENROUTER = "https://openrouter.ai/api/v1";
const MANY = `${MOCK_ROOT}/many/api/v1`;
const LOCKED = `${MOCK_ROOT}/locked/api/v1`;
/** The mock's plain list: two bare ids, nothing said of their size or price. */
const PLAIN = `${MOCK_ROOT}/plain/v1`;

interface Row {
  id: string;
  name: string;
  context: { served: number | null; configured: number | null; max: number | null };
  price: { input: number | null; output: number | null; varies: boolean };
}

/** The list as the server relays it, read as the page reads it, saving nothing. */
async function relayed(request: APIRequestContext): Promise<Row[]> {
  const read = await request.post(`${API}/api/connections/probe`, {
    data: { provider: "openai-compatible", base_url: MANY, api_key: "sk-e2e-any", family: "openrouter" },
  });
  return (await read.json()).models;
}

/** A service with AIs on it, made as the page makes one. */
async function service(request: APIRequestContext, base_url: string, models: string[], api_key = "sk-e2e-bad") {
  const made = await request.post(`${API}/api/models`, {
    data: { service: { provider: "openai-compatible", base_url, api_key, family: "openrouter" }, models: models.map((model) => ({ model })) },
  });
  expect(made.ok()).toBe(true);
}

async function aisOn(request: APIRequestContext, fragment: string): Promise<{ model: string }[]> {
  const ais = await (await request.get(`${API}/api/models`)).json();
  return ais.filter((ai: { service: { base_url: string } }) => ai.service.base_url.includes(fragment));
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Add an AI" });

async function openAdd(page: Page) {
  await page.goto("/#/settings");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

async function chip(page: Page, label: string) {
  await dialog(page).getByRole("button", { name: label, exact: true }).click();
}

async function withKey(page: Page, key: string) {
  await dialog(page).getByPlaceholder("Paste the key here").fill(key);
  await dialog(page).getByRole("button", { name: "See the models" }).click();
}

async function otherAddress(page: Page, address: string) {
  await dialog(page).getByRole("button", { name: "Other address…" }).click();
  await dialog(page).getByLabel("Server address").fill(address);
  await dialog(page).getByRole("button", { name: "See the models" }).click();
}

/** The row of a model, by its id, which each row prints under its name. */
const row = (page: Page, id: string) => dialog(page).locator("li").filter({ has: page.getByText(id, { exact: true }) });

test.describe("adding AIs", () => {
  test("adding two models of one service asks the key once", async ({ page, request }) => {
    await forgetServices(request, "/many/");
    const [first, second] = await relayed(request);
    await routeServiceTo(page, OPENROUTER, MANY);

    await openAdd(page);
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-once");
    await row(page, first.id).getByRole("checkbox").check();
    await row(page, second.id).getByRole("checkbox").check();
    await dialog(page).getByRole("button", { name: "Add 2 AIs" }).click();
    await expect(dialog(page).getByText("2 AIs added")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Back to settings" }).click();
    await expect(dialog(page)).toHaveCount(0);

    let keyAsked = false;
    page.on("request", (sent) => {
      if (sent.url().endsWith("/api/connections/probe") && (sent.postData() ?? "").includes("api_key")) keyAsked = true;
    });
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const saved = dialog(page).getByRole("button", { name: /Already connected · 2 AIs in your list · see its other models/ })
      .filter({ hasText: "/many/" });
    // The end of the key, as the server gives it: with its own ellipsis, and only that one.
    await expect(saved).toContainText(" · …once");
    await saved.click();
    await expect(dialog(page).getByText(/^List read/)).toBeVisible();
    await expect(dialog(page).getByPlaceholder("Paste the key here")).toHaveCount(0);
    for (const { id } of [first, second]) {
      await expect(row(page, id).getByText("Already in your AIs")).toBeVisible();
      await expect(row(page, id).getByRole("checkbox")).toBeDisabled();
    }
    expect(keyAsked).toBe(false);
    expect(await aisOn(request, "/many/")).toHaveLength(2);
  });

  test("every model can be found and ticked on a phone", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    const rows = await relayed(request);
    expect(rows).toHaveLength(384);
    const last = rows[rows.length - 1];
    const eclair = rows.find((r) => r.name === "Eclair Mini")!;
    const free = rows.filter((r) => r.price.input === 0 && r.price.output === 0);
    // The page's own rule (lib/ai.ts): the price of a message of the reference story, then what it reads.
    const weight = (r: Row) => (r.price.varies || r.price.input === null || r.price.output === null
      ? Infinity : r.price.input + r.price.output * 0.05);
    const reads = (r: Row) => r.context.served ?? r.context.configured ?? r.context.max ?? -Infinity;
    const cheapest = [...rows].sort((a, b) => weight(a) - weight(b) || reads(b) - reads(a))[0];
    await routeServiceTo(page, OPENROUTER, MANY);
    let adds = 0;
    page.on("request", (sent) => {
      if (sent.method() === "POST" && new URL(sent.url()).pathname === "/api/models") adds += 1;
    });

    await openAdd(page);
    const box = dialog(page);
    // As high as the screen allows at every step, whatever each one holds.
    const panel = box.locator(".panel");
    const high = (await panel.boundingBox())!.height;
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-any");
    await expect(box.getByText('384 models · 87 "batch" copies not listed')).toBeVisible();
    expect(Math.abs((await panel.boundingBox())!.height - high)).toBeLessThan(1);
    const search = box.getByRole("searchbox");
    await expect(search).not.toBeFocused();

    // The foot stays on the dialog's own edge as the list goes by under it: no row shows below it.
    const foot = box.getByRole("button", { name: "Back", exact: true }).locator("xpath=../..");
    const bottom = async (of: typeof panel) => {
      const edge = (await of.boundingBox())!;
      return edge.y + edge.height;
    };
    expect(Math.abs(await bottom(panel) - 1 - await bottom(foot))).toBeLessThan(1);

    // Drawn a slice at a time as the list nears the bottom: down to the last one.
    const boxes = box.getByRole("checkbox");
    await expect(boxes).toHaveCount(30);
    for (let drawn = await boxes.count(); drawn < rows.length; drawn = await boxes.count()) {
      await boxes.last().scrollIntoViewIfNeeded();
      await expect.poll(() => boxes.count()).toBeGreaterThan(drawn);
    }
    await row(page, last.id).getByRole("checkbox").check();
    // The block stuck on top keeps to the dialog's edge too: no row shows above it.
    const stuck = (await search.locator("xpath=../..").boundingBox())!;
    expect(Math.abs(stuck.y - (await panel.boundingBox())!.y - 1)).toBeLessThan(1);

    // A new order, or a filter, shows the results from their first.
    const first = box.locator("li").first();
    await expect(first).not.toBeInViewport();
    await box.getByRole("combobox").selectOption({ label: "By name" });
    await expect(first).toBeInViewport();
    await boxes.last().scrollIntoViewIfNeeded();
    await expect(first).not.toBeInViewport();
    await box.getByRole("button", { name: "Free", exact: true }).click();
    await expect(first).toBeInViewport();
    await box.getByRole("button", { name: "Free", exact: true }).click();
    await box.getByRole("combobox").selectOption({ label: "Service's order" });

    // The newest ones are marked.
    await box.getByRole("combobox").selectOption({ label: "Newest" });
    await expect(first.getByText("new", { exact: true })).toBeVisible();
    await box.getByRole("combobox").selectOption({ label: "Service's order" });

    // While the field is typed in, the sort and the count give it their room, and the field stays
    // where it is: the dialog keeps its height whatever the results, and the rows typing takes away
    // do not take the field with them.
    await panel.evaluate((scrolled) => scrolled.scrollBy(0, 900));
    await search.click();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
    const at = (await search.boundingBox())!.y;
    await search.press("a");
    // A keystroke draws the first slice again, never the whole list.
    await expect(boxes).toHaveCount(30);
    for (const key of "ur") await search.press(key);
    await expect(boxes).toHaveCount(1);
    expect((await search.boundingBox())!.y).toBe(at);
    await search.fill("eclair");
    await expect(boxes).toHaveCount(1);
    expect((await search.boundingBox())!.y).toBe(at);
    await expect(box.getByRole("combobox")).toBeHidden();
    await search.press("Enter");
    await expect(box.getByText("1 of 384", { exact: true })).toBeVisible();
    await expect(box.getByRole("combobox")).toBeVisible();
    await row(page, eclair.id).getByRole("checkbox").check();

    await search.fill("osbidienne");
    await expect(box.getByText("Obsidienne", { exact: true })).toBeVisible();
    await search.fill("large");
    await expect(box.getByText("Aurore Large", { exact: true })).toBeVisible();
    await expect(box.getByText("Sillage 7B", { exact: true })).toHaveCount(0);
    await search.fill("");
    await search.press("Enter");

    await box.getByRole("button", { name: "Free", exact: true }).click();
    await expect(box.getByText(`${free.length} of 384 · free only`)).toBeVisible();
    await box.getByRole("button", { name: "Free", exact: true }).click();

    await box.getByRole("combobox").selectOption({ label: "Cheapest" });
    await expect(boxes.first()).toBeVisible();
    await expect(box.locator("li").first()).toContainText(cheapest.id);
    await box.getByRole("combobox").selectOption({ label: "Service's order" });

    // The ticked rows, and no other, can be untouched there.
    await search.fill("aurore");
    await search.press("Enter");
    await box.getByRole("button", { name: "Ticked · 2" }).click();
    await expect(boxes).toHaveCount(2);
    await row(page, eclair.id).getByRole("checkbox").uncheck();
    await expect(box.getByRole("button", { name: "Ticked · 1" })).toBeVisible();
    await row(page, eclair.id).getByRole("checkbox").check();
    await expect(box.getByRole("button", { name: "Ticked · 2" })).toHaveAttribute("aria-pressed", "true");
    await search.press("a");
    await search.press("Enter");
    await expect(box.getByRole("button", { name: "Ticked · 2" })).toHaveAttribute("aria-pressed", "false");

    // A word of three letters has no typo allowed: nothing, and the name it was near.
    await search.fill("aurore lrg");
    await expect(box.getByText('No model matches "aurore lrg".')).toBeVisible();
    await box.getByRole("button", { name: "Did you mean Aurore Large?" }).click();
    await expect(search).toHaveValue("Aurore Large");

    await search.fill("zz-absent");
    await expect(box.getByText('No model matches "zz-absent".')).toBeVisible();
    await box.getByRole("button", { name: 'Use "zz-absent" as it is' }).click();
    await expect(row(page, "zz-absent").getByText("typed by hand")).toBeVisible();
    await expect(row(page, "zz-absent").getByRole("checkbox")).toBeChecked();

    // The copies at batch price are not offered at all.
    await search.fill("batch");
    await expect(box.getByText('No model matches "batch".')).toBeVisible();

    // Two touches in one frame, before the button is drawn disabled, send one request.
    await box.getByRole("button", { name: "Add 3 AIs" }).evaluate((button: HTMLElement) => {
      button.click();
      button.click();
    });
    await expect(box.getByText("3 AIs added")).toBeVisible();
    expect(adds).toBe(1);
    expect((await aisOn(request, "/many/")).map((ai) => ai.model).sort()).toEqual([eclair.id, last.id, "zz-absent"].sort());
  });

  /** The list of the mock's many models, its search field focused and the box scrolled to it. */
  async function searching(page: Page) {
    const box = dialog(page);
    const search = box.getByRole("searchbox");
    await openAdd(page);
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-any");
    await expect(box.getByRole("checkbox")).toHaveCount(30);
    await search.click();
    await frames(page);
    return {
      box, search, panel: box.locator(".panel"), boxes: box.getByRole("checkbox"),
      // The field and, once it lets go, the sort and the count under it.
      block: search.locator("xpath=../.."),
      foot: box.getByRole("button", { name: "Back", exact: true }).locator("xpath=../.."),
    };
  }

  const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  const edges = async (of: Locator) => {
    const { y, height } = (await of.boundingBox())!;
    return { top: y, bottom: y + height };
  };
  /** Past the moment the sort and the count come back: both drawn again, and the frames after them
   *  in which the list puts the row it holds back in place. */
  const settled = async (page: Page) => {
    await expect(dialog(page).getByRole("combobox")).toBeVisible();
    await expect(dialog(page).locator("p[role=status]").filter({ hasText: /\d/ })).toBeVisible();
    await frames(page);
  };
  // Phones of today, and the smallest one still sold.
  const PHONES = [{ width: 390, height: 844 }, { width: 320, height: 640 }];

  test("a row tapped while the field lets go stays under the finger", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    await routeServiceTo(page, OPENROUTER, MANY);

    for (const size of [null, ...PHONES]) {
      if (size) await page.setViewportSize(size);
      const { box, search, panel, boxes, block } = await searching(page);

      // Deep in the results: the rows come back under the sort, and none moves.
      await search.press("a");
      await expect(boxes).toHaveCount(30);
      await panel.evaluate((scrolled) => scrolled.scrollBy(0, 400));
      await frames(page);
      const tappedRow = box.locator("li").nth(6);
      await boxes.nth(6).tap();
      const deep = (await boxes.nth(6).boundingBox())!.y;
      await settled(page);
      await expect(boxes.nth(6)).toBeChecked();
      expect(Math.abs((await boxes.nth(6).boundingBox())!.y - deep)).toBeLessThan(1);
      expect((await edges(tappedRow)).top).toBeGreaterThanOrEqual((await edges(block)).bottom - 0.5);

      await box.getByRole("button", { name: "Close" }).click();
      await expect(box).toHaveCount(0);
    }
  });

  test("a lone result tapped is never left under the sort and the count", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    await routeServiceTo(page, OPENROUTER, MANY);

    for (const size of PHONES) {
      await page.setViewportSize(size);
      const { box, search, panel, boxes, block, foot } = await searching(page);
      await search.fill("eclair");
      await expect(boxes).toHaveCount(1);
      await frames(page);
      await boxes.first().tap();
      await settled(page);
      await expect(boxes.first()).toBeChecked();
      const lone = await edges(box.locator("li").first());
      expect(lone.top).toBeGreaterThanOrEqual((await edges(block)).bottom - 0.5);
      // In sight: inside the box that scrolls, above the foot that covers its bottom.
      expect(lone.top).toBeGreaterThanOrEqual((await edges(panel)).top);
      expect(lone.bottom).toBeLessThanOrEqual((await edges(foot)).top + 0.5);

      // The room kept for the search is given back once the view changes: no screen of empty
      // space under the one ticked row.
      await box.getByRole("button", { name: "Ticked · 1" }).click();
      await expect(boxes).toHaveCount(1);
      await frames(page);
      expect(await block.locator("xpath=..").evaluate((whole: HTMLElement) => whole.style.minHeight)).toBe("");
      const [scrollable, shown] = await panel.evaluate((scrolled) => [scrolled.scrollHeight, scrolled.clientHeight]);
      expect(scrollable - shown).toBeLessThan(shown / 2);

      await box.getByRole("button", { name: "Close" }).click();
      await expect(box).toHaveCount(0);
    }
  });

  test("the field left with Enter leaves the first result in sight", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    await routeServiceTo(page, OPENROUTER, MANY);

    for (const size of PHONES) {
      await page.setViewportSize(size);
      const { box, search, boxes, block } = await searching(page);
      await search.press("a");
      await expect(boxes).toHaveCount(30);
      await search.press("Enter");
      await settled(page);
      await expect(box.getByRole("combobox")).toBeVisible();
      expect((await edges(box.locator("li").first())).top).toBeGreaterThanOrEqual((await edges(block)).bottom - 0.5);

      await box.getByRole("button", { name: "Close" }).click();
      await expect(box).toHaveCount(0);
    }
  });

  test("a row pressed then scrolled away is not the one held when Enter lets the field go", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    await routeServiceTo(page, OPENROUTER, MANY);

    for (const size of PHONES) {
      await page.setViewportSize(size);
      const { box, search, panel, boxes, block } = await searching(page);
      await search.press("a");
      await expect(boxes).toHaveCount(30);
      // A drag that starts on a row: the press lands on it, then the list scrolls.
      await box.locator("li").first().dispatchEvent("pointerdown");
      await panel.evaluate((scrolled) => scrolled.scrollBy(0, 600));
      await frames(page);
      const edge = (await edges(block)).bottom;
      const under = await box.locator("li").evaluateAll(
        (lis, below) => lis.findIndex((li) => li.getBoundingClientRect().top >= below), edge);
      const was = (await edges(box.locator("li").nth(under))).top;
      const scrolled = await panel.evaluate((it) => it.scrollTop);
      await search.press("Enter");
      await settled(page);
      await expect(box.getByRole("combobox")).toBeVisible();
      const back = (await edges(block)).bottom;
      const now = (await edges(box.locator("li").nth(under))).top;
      expect(Math.abs(now - Math.max(was, back))).toBeLessThan(1);
      expect(await panel.evaluate((it) => it.scrollTop)).toBeGreaterThanOrEqual(scrolled - (back - edge) - 1);

      await box.getByRole("button", { name: "Close" }).click();
      await expect(box).toHaveCount(0);
    }
  });

  test("the first of many results tapped is not left under the sort and the count", async ({ page, request }) => {
    test.setTimeout(120_000);
    await forgetServices(request, "/many/");
    await routeServiceTo(page, OPENROUTER, MANY);

    for (const size of PHONES) {
      await page.setViewportSize(size);
      const { box, search, boxes, block } = await searching(page);
      await search.press("a");
      await expect(boxes).toHaveCount(30);
      await frames(page);
      await boxes.first().tap();
      await settled(page);
      await expect(boxes.first()).toBeChecked();
      expect((await edges(box.locator("li").first())).top).toBeGreaterThanOrEqual((await edges(block)).bottom - 0.5);

      await box.getByRole("button", { name: "Close" }).click();
      await expect(box).toHaveCount(0);
    }
  });

  test("a server that fails says what failed and can be asked again", async ({ page, request }) => {
    test.setTimeout(120_000);
    for (const fragment of ["/broken/", "/empty/", "/locked/", "/slow/", "/many/"]) await forgetServices(request, fragment);
    await service(request, LOCKED, ["locked/one"]);
    const [first] = await relayed(request);
    let probes = 0;
    page.on("request", (sent) => {
      if (sent.url().endsWith("/api/connections/probe")) probes += 1;
    });
    const box = dialog(page);
    const back = () => box.getByRole("button", { name: "Back", exact: true }).click();
    const byHand = box.getByRole("button", { name: "Type the model's name by hand" });

    await openAdd(page);
    await otherAddress(page, `${MOCK_ROOT}/broken/v1`);
    await expect(box.getByRole("alert")).toBeVisible();
    await expect(byHand).toBeVisible();
    const before = probes;
    await box.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => probes).toBe(before + 1);
    await expect(box.getByRole("alert")).toBeVisible();
    await back();

    await otherAddress(page, `${MOCK_ROOT}/empty/v1`);
    await expect(box.getByText("The server answers, but offers no model.")).toBeVisible();
    await expect(byHand).toBeVisible();
    await back();

    await routeServiceTo(page, OPENROUTER, LOCKED);
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-bad");
    await expect(box.getByText("OpenRouter refuses this key. Check it, then try again.")).toBeVisible();
    await expect(byHand).toHaveCount(0);
    await expect(box.getByRole("button", { name: "Change the key" })).toHaveCount(0);
    await back();

    await otherAddress(page, "http://127.0.0.1:1/v1");
    await expect(box.getByText("The server does not answer at http://127.0.0.1:1/v1.")).toBeVisible();
    await back();

    // A saved service whose key is refused can be given another.
    await box.getByRole("button", { name: /Already connected/ }).filter({ hasText: "/locked/" }).click();
    await expect(box.getByText(/refuses this key/)).toBeVisible();
    await expect(box.getByRole("button", { name: "Change the key" })).toBeVisible();
    await back();

    // Cancel gives up on a list that is slow to come, and says nothing failed.
    await otherAddress(page, `${MOCK_ROOT}/slow/api/v1`);
    await expect(box.getByText("Evermind is asking the server…")).toBeVisible();
    await box.getByRole("button", { name: "Cancel" }).click();
    await expect(box.getByLabel("Server address")).toBeVisible();
    await expect(box.getByRole("alert")).toHaveCount(0);
    await back();

    // A server with no list still takes a model named by hand.
    await otherAddress(page, `${MOCK_ROOT}/broken/v1`);
    await byHand.click();
    await expect(box.getByText("Type the exact name of the model, as the service writes it.")).toBeVisible();
    await box.getByRole("searchbox").fill("hand-made");
    await box.getByRole("button", { name: 'Use "hand-made" as it is' }).click();
    await box.getByRole("button", { name: "Add 1 AI" }).click();
    await expect(box.getByText("1 AI added")).toBeVisible();
    expect((await aisOn(request, "/broken/")).map((ai) => ai.model)).toEqual(["hand-made"]);
    await box.getByRole("button", { name: "Back to settings" }).click();

    // A list read again that fails stays on screen, with what was ticked.
    await page.unrouteAll();
    await routeServiceTo(page, OPENROUTER, MANY);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-any");
    await row(page, first.id).getByRole("checkbox").check();
    await page.route("**/api/connections/probe", (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ detail: "The list broke.", kind: "model_error" }) }));
    await box.getByRole("button", { name: "Read again" }).click();
    await expect(box.getByRole("alert")).toContainText("The list broke.");
    await expect(box.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(row(page, first.id).getByRole("checkbox")).toBeChecked();
    await expect(box.getByText('384 models · 87 "batch" copies not listed')).toBeVisible();
  });

  test("a refused key is replaced without adding an ai", async ({ page, request }) => {
    await forgetServices(request, "/locked/");
    const [first, second] = await relayed(request);
    await service(request, LOCKED, [first.id, second.id]);

    await openAdd(page);
    const box = dialog(page);
    await box.getByRole("button", { name: /Already connected · 2 AIs/ }).filter({ hasText: "/locked/" }).click();
    await expect(box.getByText(/refuses this key/)).toBeVisible();
    await box.getByRole("button", { name: "Change the key" }).click();
    await withKey(page, "sk-e2e-good");
    for (const { id } of [first, second]) await expect(row(page, id).getByText("Already in your AIs")).toBeVisible();
    await box.getByRole("button", { name: "Save the key" }).click();
    await expect(box.getByText("Key saved.")).toBeVisible();

    const services = await (await request.get(`${API}/api/connections`)).json();
    const locked = services.find((s: { base_url: string }) => s.base_url.includes("/locked/"));
    expect(locked.api_key_hint).toBe("…good");
    expect(await aisOn(request, "/locked/")).toHaveLength(2);
  });

  test("what a service does not say is asked under the ticked row, and sent", async ({ page, request }) => {
    await forgetServices(request, "/plain/");
    // A list of bare ids, as most servers give: no size, no price.
    await routeServiceTo(page, "https://api.groq.com/openai/v1", PLAIN);
    const box = dialog(page);

    await openAdd(page);
    await chip(page, "Groq");
    await withKey(page, "sk-e2e-any");
    await expect(box.getByRole("radio")).toHaveCount(0);
    await row(page, "evermind-demo").getByRole("checkbox").check();
    const ticked = row(page, "evermind-demo");
    await expect(ticked.getByRole("group", { name: "How much can it read at once?" })).toBeVisible();
    await expect(ticked.getByRole("radio")).toHaveCount(4);
    await expect(ticked.getByRole("radio", { name: "I don't know" })).toBeChecked();
    await expect(ticked.getByText("Evermind then counts 16,384 tokens (≈ 33 pages), as today.")).toBeVisible();
    await ticked.getByRole("radio", { name: /^Medium/ }).check();
    await expect(ticked.getByText("Noted. Can be changed at any time on the AI's page.")).toBeVisible();
    await expect(ticked.getByText("Its price, if you know it ($ per million tokens)")).toBeVisible();
    await expect(ticked.getByText("As on Groq's pricing page. Optional.")).toBeVisible();
    await ticked.getByLabel("Read", { exact: true }).fill("0,5");
    await ticked.getByLabel("Written", { exact: true }).fill("1.5");
    // Only under the ticked row.
    await expect(box.getByRole("radio")).toHaveCount(4);

    const sent = page.waitForRequest((asked) => asked.method() === "POST" && new URL(asked.url()).pathname === "/api/models");
    await box.getByRole("button", { name: "Add 1 AI" }).click();
    expect((await sent).postDataJSON().models).toEqual([
      expect.objectContaining({ model: "evermind-demo", context_own: 32_000, price_own_in: 0.5, price_own_out: 1.5 }),
    ]);
    await expect(box.getByText("1 AI added")).toBeVisible();
  });

  test("a server at home that does not say its size is told what Evermind counts", async ({ page }) => {
    const box = dialog(page);
    await openAdd(page);
    // Ollama's size is read from it when the model is added.
    // Each at an address of its own, as two servers at home are.
    await routeServiceTo(page, "http://localhost:11434/v1", `${MOCK_ROOT}/home-ollama/v1`);
    await chip(page, "Ollama");
    await expect(row(page, "evermind-demo").getByText("Size read when it is added.")).toBeVisible();
    await box.getByRole("button", { name: "Back", exact: true }).click();

    await page.unrouteAll();
    await routeServiceTo(page, "http://localhost:8080/v1", `${MOCK_ROOT}/home-llama/v1`);
    await chip(page, "llama.cpp");
    await expect(row(page, "evermind-demo").getByText(
      "This server does not say the size it loads: Evermind counts 4,096. Can be changed on the AI's page.",
    )).toBeVisible();
    // A server at home asks neither a size nor a price.
    await row(page, "evermind-demo").getByRole("checkbox").check();
    await expect(box.getByRole("radio")).toHaveCount(0);
    await expect(box.getByText("Its price, if you know it ($ per million tokens)")).toHaveCount(0);
  });

  test("a service with no ai can be removed, and a refusal is said on its row", async ({ page, request }) => {
    await forgetServices(request, "/plain/");
    await service(request, PLAIN, ["evermind-demo"]);
    const services = await (await request.get(`${API}/api/connections`)).json();
    const held = services.find((s: { base_url: string }) => s.base_url.includes("/plain/"));
    // The release before can leave a service with no AI, which nothing here can make: one is shown
    // to the page, and the one it shows as empty has had an AI added on it from elsewhere since.
    const empty = { ...held, id: "e2e-empty-service", name: "Empty one", base_url: `${MOCK_ROOT}/emptied/v1`, model_count: 0 };
    await page.route("**/api/connections", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const listed = await route.fetch();
      const shown = (await listed.json()).map((s: { id: string }) => (s.id === held.id ? { ...s, model_count: 0 } : s));
      await route.fulfill({ response: listed, json: [...shown, empty] });
    });
    await page.route(`**/api/connections/${empty.id}`, (route) => route.fulfill({ status: 204 }));
    const box = dialog(page);
    const entry = (fragment: string) => box.locator("li").filter({ hasText: fragment });

    await openAdd(page);
    await expect(entry("/emptied/").getByText("Already connected · no AI in your list")).toBeVisible();
    await entry("/emptied/").getByRole("button", { name: "Remove" }).click();
    const sure = page.getByRole("alertdialog", { name: "Remove Empty one? Its key will be forgotten." });
    await sure.getByRole("button", { name: "Remove" }).press("Enter");
    await expect(entry("/emptied/")).toHaveCount(0);

    await entry("/plain/").getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).press("Enter");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(entry("/plain/").getByRole("alert")).toContainText("This service now holds AIs: it was not removed.");
    expect(await aisOn(request, "/plain/")).toHaveLength(1);
  });

  test("leaving the flow half-way changes nothing", async ({ page, request }) => {
    await forgetServices(request, "/many/");
    const [first, second] = await relayed(request);
    const before = [
      await (await request.get(`${API}/api/models`)).json(),
      await (await request.get(`${API}/api/connections`)).json(),
    ];
    await routeServiceTo(page, OPENROUTER, MANY);

    await openAdd(page);
    await chip(page, "OpenRouter");
    const key = dialog(page).getByPlaceholder("Paste the key here");
    await expect(key).toHaveAttribute("type", "text");
    await withKey(page, "sk-e2e-half-way");
    await row(page, first.id).getByRole("checkbox").check();
    await row(page, second.id).getByRole("checkbox").check();
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);

    expect([
      await (await request.get(`${API}/api/models`)).json(),
      await (await request.get(`${API}/api/connections`)).json(),
    ]).toEqual(before);
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(kept).not.toContain("sk-e2e-half-way");
  });

  test("leaving the flow half-way from a conversation changes nothing", async ({ page, request }) => {
    await forgetServices(request, "/many/");
    const [first, second] = await relayed(request);
    const convo = await makeConversation(request);
    const before = [
      await (await request.get(`${API}/api/models`)).json(),
      await (await request.get(`${API}/api/connections`)).json(),
      (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id,
    ];
    await routeServiceTo(page, OPENROUTER, MANY);

    await page.goto(`/#/chat/${convo.id}`);
    const aiChip = page.locator("[data-status-row]").getByRole("button").first();
    await expect(aiChip).toHaveAccessibleName("AI: e2e. Change.");
    await aiChip.click();
    await page.getByRole("dialog", { name: "Which AI answers?" }).getByRole("button", { name: "Other model…" }).click();
    await chip(page, "OpenRouter");
    await withKey(page, "sk-e2e-half-way");
    await row(page, first.id).getByRole("checkbox").check();
    await row(page, second.id).getByRole("checkbox").check();
    await expect(dialog(page).getByRole("button", { name: /will answer here/ })).toBeVisible();
    await dialog(page).getByRole("button", { name: "Close" }).click();
    await expect(dialog(page)).toHaveCount(0);

    expect([
      await (await request.get(`${API}/api/models`)).json(),
      await (await request.get(`${API}/api/connections`)).json(),
      (await (await request.get(`${API}/api/conversations/${convo.id}`)).json()).model_id,
    ]).toEqual(before);
    await expect(aiChip).toHaveAccessibleName("AI: e2e. Change.");
    const kept = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(kept).not.toContain("sk-e2e-half-way");
  });

  /** Whether what is drawn at the middle of the element is the element itself, or something inside it:
   *  nothing lies over it. */
  const uncovered = (target: Locator) => target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const there = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return there !== null && (there === el || el.contains(there));
  });

  // Text set to its largest on the smallest phone still sold: the root at 32px on 320x640.
  test.describe("at very large text on a small phone", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(rootAt, "32px");
      await page.setViewportSize({ width: 320, height: 640 });
    });

    test("a row of the list can be seen whole and ticked, and the confirm button reached and pressed", async ({ page, request }) => {
      await forgetServices(request, "/many/");
      await routeServiceTo(page, OPENROUTER, MANY);
      await openAdd(page);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
      const box = dialog(page);
      await chip(page, "OpenRouter");
      await withKey(page, "sk-e2e-any");
      const boxes = box.getByRole("checkbox");
      await expect(boxes).toHaveCount(30);
      const panel = box.locator(".panel");
      const block = box.getByRole("searchbox").locator("xpath=../..");
      const confirm = box.getByRole("button", { name: "Tick at least one model" });

      // As the list comes: the foot takes no more than a third of the box, and the search lies over
      // none of its buttons.
      await frames(page);
      const shownOf = async (target: Locator) => {
        const it = await edges(target);
        const room = await edges(panel);
        return Math.max(0, Math.min(it.bottom, room.bottom) - Math.max(it.top, room.top));
      };
      const boxHeight = (await panel.boundingBox())!.height;
      expect(await shownOf(confirm.locator("xpath=../..")), "the foot takes more than a third of the box")
        .toBeLessThanOrEqual(boxHeight / 3);
      for (const button of [confirm, box.getByRole("button", { name: "Back", exact: true })]) {
        if (await shownOf(button) > 0) expect(await uncovered(button), "something lies over a button of the foot").toBe(true);
      }

      // The foot no longer covers the list. A row there is taller than the box (750px of text on a
      // 589px box), so its top is what must come whole into sight, between the stuck search and the
      // box's bottom, or the foot's top where the foot stays: its box to tick.
      const first = box.locator("li").first();
      const top = boxes.first();
      // Its top to the box's top, then down by the search stuck there.
      await first.evaluate((li) => li.scrollIntoView({ block: "start" }));
      await frames(page);
      const stuckHeight = (await block.boundingBox())!.height;
      await panel.evaluate((scrolled, by) => scrolled.scrollBy(0, -by), stuckHeight + 8);
      await frames(page);
      const row = await edges(top);
      expect(row.top, "the row is under the search").toBeGreaterThanOrEqual((await edges(block)).bottom - 0.5);
      const foot = await edges(confirm.locator("xpath=../.."));
      const floor = foot.top > row.top ? Math.min((await edges(panel)).bottom, foot.top) : (await edges(panel)).bottom;
      expect(row.bottom, "the row's top is under the foot, or past the box").toBeLessThanOrEqual(floor + 0.5);
      expect(await uncovered(boxes.first()), "something lies over the row's box").toBe(true);
      await boxes.first().tap();
      await expect(boxes.first()).toBeChecked();

      // Narrowed to one, ticked, and added: its button reached by scrolling, and nothing over it.
      const search = box.getByRole("searchbox");
      await search.click();
      await search.fill("eclair");
      await search.press("Enter");
      await expect(boxes).toHaveCount(1);
      await boxes.first().check();
      const add = box.getByRole("button", { name: "Add 2 AIs" });
      await add.scrollIntoViewIfNeeded();
      await frames(page);
      expect(await uncovered(add), "something lies over the confirm button").toBe(true);
      await add.tap();
      await expect(box.getByText("2 AIs added")).toBeVisible();
    });
  });

  // Text set to its largest, in every language: each step of the dialog keeps its buttons, its
  // fields and its sort inside the box. The page's own paste is offered, as where the browser allows it.
  test.describe("at very large text each step fits", () => {
    for (const locale of ["en", "fr", "de", "es"]) {
      test(`in ${locale}`, async ({ page, request }) => {
        test.setTimeout(120_000);
        const words = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", `${locale}.json`), "utf8"));
        await forgetServices(request, "/many/");
        // A service added by its address is named after it: one long word, on a row of its own.
        await addModel(request, { base_url: MOCK, model: "evermind-demo", name: "e2e" });
        // And one with no AI, which the release before can leave: its row also holds the button that removes it.
        await page.route("**/api/connections", async (route) => {
          if (route.request().method() !== "GET") return route.continue();
          const listed = await route.fetch();
          const services = await listed.json();
          const held = services.find((s: { base_url: string }) => s.base_url === MOCK);
          const empty = { ...held, id: "e2e-empty-service", base_url: `${MOCK_ROOT}/emptied/v1`, model_count: 0 };
          await route.fulfill({ response: listed, json: [...services, empty] });
        });
        await routeServiceTo(page, OPENROUTER, MANY);
        await inLocale(page, locale);
        await page.addInitScript(rootAt, "32px");
        await page.addInitScript(() => {
          Object.defineProperty(window, "isSecureContext", { value: true });
          Object.defineProperty(navigator, "clipboard", { value: { readText: () => Promise.resolve("") } });
        });
        const box = page.getByRole("dialog");
        for (const [width, height] of [[390, 844], [320, 640]]) {
          await page.setViewportSize({ width, height });
          await page.goto("/#/settings");
          await page.reload();
          await page.getByRole("button", { name: words.ai.add.open, exact: true }).click();
          await expect(box.getByRole("button", { name: "OpenRouter", exact: true })).toBeVisible();
          // A saved service's name and sentence break where their column ends, and do not run on
          // under the arrow beside them; the button that removes one stays inside its row.
          for (const address of [MOCK, "/emptied/"]) {
            const saved = box.locator("li").filter({ hasText: address }).first();
            await expect(saved).toBeVisible();
            expect(
              await saved.evaluate((row) => {
                const room = row.getBoundingClientRect();
                return [
                  ...[...row.querySelectorAll("span")]
                    .filter((part) => part.scrollWidth > part.clientWidth + 1)
                    .map((part) => `"${part.textContent}" ${part.scrollWidth} wide in ${part.clientWidth}`),
                  ...[...row.querySelectorAll("button")].map((button) => button.getBoundingClientRect())
                    .filter((button) => button.left < room.left - 0.5 || button.right > room.right + 0.5)
                    .map((button) => `a button at ${Math.round(button.left)}..${Math.round(button.right)} of ${Math.round(room.left)}..${Math.round(room.right)}`),
                ];
              }),
              `the row of ${address}, at ${width}px`,
            ).toEqual([]);
          }
          expect(await misfits(page, "dialog[open]"), `where, at ${width}px`).toEqual([]);
          await box.getByRole("button", { name: words.ai.add.other }).click();
          await expect(box.getByRole("button", { name: words.ai.add.paste })).toBeVisible();
          expect(await misfits(page, "dialog[open]"), `another address, at ${width}px`).toEqual([]);
          await box.getByRole("button", { name: words.ai.add.back, exact: true }).click();
          await box.getByRole("button", { name: "OpenRouter", exact: true }).click();
          const key = box.getByPlaceholder(words.ai.add.keyPlaceholder);
          await expect(key).toBeVisible();
          expect(await misfits(page, "dialog[open]"), `the key, at ${width}px`).toEqual([]);
          await key.fill("sk-e2e-any");
          await box.getByRole("button", { name: words.ai.add.seeModels }).click();
          await expect(box.getByRole("checkbox")).toHaveCount(30);
          expect(await misfits(page, "dialog[open]"), `the list, at ${width}px`).toEqual([]);
        }
      });
    }
  });
});
