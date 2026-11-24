import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { MOCK_ROOT, answer, boxHears, makeCharacter } from "./fixtures";

/**
 * My AIs in Settings, and the page of each AI. The suite's server started on a database from the
 * release before (e2e/clean-data.mjs), whose one connection the update made "Brume 12B", an AI
 * brought over on an LM Studio of the mock server's (/lmstudio/, scripts/mock_llm.py), which loads
 * brume-12b with 32,768 tokens.
 */

const LMSTUDIO = `${MOCK_ROOT}/lmstudio/v1`;

interface Ai {
  id: string;
  name: string;
  model: string;
  is_default: boolean;
  created_at: string;
  service: { id: string; name: string };
  context: { own: number | null; used: number; read: number | null };
  reply_cap: { mode: string; tokens: number | null };
  temperature: number | null;
  top_p: number | null;
  frequency_penalty: number | null;
  presence_penalty: number | null;
  migrated: boolean;
  notices: string[];
}

async function ais(request: APIRequestContext): Promise<Ai[]> {
  return (await request.get(`${API}/api/models`)).json();
}

async function aiOf(request: APIRequestContext, id: string): Promise<Ai | undefined> {
  return (await ais(request)).find((ai) => ai.id === id);
}

/** An AI on the mock's LM Studio, on a service of its own: a key no other test sends makes one,
 *  and a list no other read has kept. Added as LM Studio, it reads the size loaded as it is added. */
async function lmstudioAi(request: APIRequestContext, name: string): Promise<Ai> {
  // As the mock starts: a test cut short may have left it changed.
  await loaded(request, 32768);
  const made = await request.post(`${API}/api/models`, {
    data: {
      service: { provider: "openai-compatible", base_url: LMSTUDIO, api_key: `sk-${name}-${Date.now()}`, family: "lmstudio" },
      models: [{ model: "brume-12b", name: `${name} ${Date.now()}` }],
    },
  });
  expect(made.ok()).toBe(true);
  return (await made.json()).models[0];
}

/** What the mock's LM Studio says brume-12b is loaded with. */
async function loaded(request: APIRequestContext, context_length: number) {
  expect((await request.post(`${MOCK_ROOT}/lmstudio/loaded`, { data: { context_length } })).ok()).toBe(true);
}

/** The page of an AI, once its own read on opening has come back; loaded again when it is the
 *  page already shown, which a move to the same address would not do. */
async function openPage(page: Page, id: string) {
  const read = page.waitForResponse((r) => r.url().endsWith(`/api/models/${id}/refresh`));
  const address = `/#/settings/ai/${id}`;
  if (page.url().endsWith(address)) await page.reload();
  else await page.goto(address);
  await read;
}

/** The line of an AI in My AIs, which leads to its page. */
const lineOf = (page: Page, id: string) => page.locator(`main a[href="#/settings/ai/${id}"]`);

async function openAdvanced(page: Page) {
  await page.getByText("Advanced", { exact: true }).click();
}

/** The default back on the AI every other test answers with. */
async function e2eDefault(request: APIRequestContext) {
  const e2e = (await ais(request)).find((ai) => ai.name === "e2e");
  if (e2e) await request.put(`${API}/api/models/${e2e.id}`, { data: { is_default: true } });
}

test.describe("my ais", () => {
  test("an ai brought over from a connection says what works against it and changes nothing by itself", async ({ page, request }, info) => {
    test.skip(info.project.name !== "phone", "Brume 12B exists once, on the server both projects share");
    const found = (await ais(request)).find((ai) => ai.name === "Brume 12B" && ai.migrated);
    expect(found, "the update made no Brume 12B").toBeTruthy();
    const brume = found as Ai;
    // As the update left it: a test before, or a retry, may have changed it.
    await request.put(`${API}/api/models/${brume.id}`, {
      data: { context_own: 16384, reply_cap: { mode: "fixed", tokens: 1024 }, notices_kept: false },
    });

    // Its page reads it: the probes find LM Studio, which has it loaded with 32,768.
    await openPage(page, brume.id);
    await expect(page.getByText("32,768 tokens loaded", { exact: false })).toBeVisible();

    await page.goto("/#/settings");
    const main = page.locator("main");
    await expect(main.getByText("Brume 12B was brought over from your old connection, with its figures.")).toBeVisible();
    await expect(main.getByText("Two of them may be working against you:")).toBeVisible();
    await expect(main.getByText("Reading capacity typed by hand: 16,384 tokens.")).toBeVisible();
    await expect(main.getByText("Brume 12B loaded this model with 32,768 tokens.")).toBeVisible();
    await expect(main.getByText("Reply ceiling: 1,024 tokens. Long replies would be cut short.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Follow the server" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Let Evermind set it" })).toBeVisible();

    const before = (await aiOf(request, brume.id)) as Ai;
    await main.getByRole("button", { name: "Keep everything as it is" }).click();
    await expect(main.getByText("Everything is kept as it is. You will find these choices on the page of Brume 12B.")).toBeVisible();
    await expect(main.getByRole("button", { name: "Follow the server" })).toHaveCount(0);
    const after = (await aiOf(request, brume.id)) as Ai;
    expect(after.notices).toEqual([]);
    const figures = (ai: Ai) => ({ ...ai, notices: [], updated_at: null });
    expect(figures(after)).toEqual(figures(before));

    await page.reload();
    await expect(page.getByRole("heading", { name: "My AIs" })).toBeVisible();
    await expect(main.getByText("was brought over from your old connection")).toHaveCount(0);
    await expect(main.getByText("Everything is kept as it is.")).toHaveCount(0);

    await request.put(`${API}/api/models/${brume.id}`, { data: { notices_kept: false } });
    await page.reload();
    await main.getByRole("button", { name: "Follow the server" }).click();
    await expect(main.getByText(
      "Brume 12B now follows its server. Your value before was 16,384 tokens: you can put it back on its page, under Advanced, “My value”.",
    )).toBeVisible();
    const followed = (await aiOf(request, brume.id)) as Ai;
    expect(followed.context.own).toBeNull();
    expect(followed.context.used).toBe(32768);
    // Nothing else was changed by it: its ceiling is still the one it came with.
    expect(followed.reply_cap).toEqual({ mode: "fixed", tokens: 1024 });

    // On its own page, the choices under Advanced follow what a notice's button saved.
    await request.put(`${API}/api/models/${brume.id}`, {
      data: { context_own: 16384, reply_cap: { mode: "fixed", tokens: 1024 }, notices_kept: false },
    });
    await openPage(page, brume.id);
    await openAdvanced(page);
    const capacity = page.getByRole("group", { name: "Reading capacity" });
    const ceiling = page.getByRole("group", { name: "Reply ceiling" });
    await expect(capacity.getByRole("button", { name: /^My value/ })).toHaveAttribute("aria-pressed", "true");
    await expect(ceiling.getByRole("button", { name: /^My value/ })).toHaveAttribute("aria-pressed", "true");

    await main.getByRole("button", { name: "Follow the server", exact: true }).click();
    await expect(main.getByText("Brume 12B now follows its server.", { exact: false })).toBeVisible();
    await expect(capacity.getByRole("button", { name: /^Follow the server/ })).toHaveAttribute("aria-pressed", "true");
    await expect(capacity.getByRole("button", { name: /^My value/ })).toHaveAttribute("aria-pressed", "false");
    await expect(capacity.getByRole("textbox")).toHaveCount(0);

    await main.getByRole("button", { name: "Let Evermind set it" }).click();
    await expect(main.getByText("Brume 12B no longer has a ceiling of its own: Evermind keeps the room it needs.")).toBeVisible();
    await expect(ceiling.getByRole("button", { name: "Set by Evermind" })).toHaveAttribute("aria-pressed", "true");
    await expect(ceiling.getByRole("button", { name: /^My value/ })).toHaveAttribute("aria-pressed", "false");
    await expect(ceiling.getByRole("textbox")).toHaveCount(0);
    expect((await aiOf(request, brume.id))?.reply_cap).toEqual({ mode: "auto", tokens: null });
  });

  test("a reading capacity above the server's is kept and said", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Above");
    await openPage(page, ai.id);
    await openAdvanced(page);
    const capacity = page.getByRole("group", { name: "Reading capacity" });
    await capacity.getByRole("button", { name: /^My value/ }).click();
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));
    await capacity.getByRole("textbox").fill("65536");
    await saved;
    const said = `More than ${ai.service.name} announces (32,768): what goes over may be cut without a word.`;
    await expect(page.getByText(said)).toBeVisible();
    expect((await aiOf(request, ai.id))?.context.own).toBe(65536);

    await page.reload();
    await openAdvanced(page);
    await expect(capacity.getByRole("textbox")).toHaveValue("65536");
    await expect(page.getByText(said)).toBeVisible();
    await request.delete(`${API}/api/models/${ai.id}`);
  });

  test("a reading capacity cleared to type another stays open and saves nothing meanwhile", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Cleared");
    let puts = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`)) puts += 1;
    });
    try {
      for (const [n, size] of [{ width: 390, height: 844 }, { width: 320, height: 640 }].entries()) {
        await page.setViewportSize(size);
        const own = 16384 + n;
        await request.put(`${API}/api/models/${ai.id}`, { data: { context_own: own } });
        await openPage(page, ai.id);
        await openAdvanced(page);
        const capacity = page.getByRole("group", { name: "Reading capacity" });
        const field = capacity.getByRole("textbox");
        await expect(field).toHaveValue(String(own));
        puts = 0;

        await field.click();
        await field.press("ControlOrMeta+a");
        await field.press("Backspace");
        // Longer than the pause after which a figure typed is saved.
        await page.waitForTimeout(1500);
        await expect(field, `${size.width}: the field went away under the typing`).toBeFocused();
        await expect(field).toHaveValue("");
        await expect(capacity.getByRole("button", { name: /^My value/ })).toHaveAttribute("aria-pressed", "true");
        expect(puts, `${size.width}: an empty field was saved while typed in`).toBe(0);
        expect((await aiOf(request, ai.id))?.context.own).toBe(own);

        const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));
        await field.pressSequentially("20000");
        await saved;
        await expect(field).toBeFocused();
        expect((await aiOf(request, ai.id))?.context.own).toBe(20000);
      }

      // Left empty, it follows the server, as its other choice does.
      const field = page.getByRole("group", { name: "Reading capacity" }).getByRole("textbox");
      await field.fill("");
      const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));
      await field.blur();
      await saved;
      expect((await aiOf(request, ai.id))?.context.own).toBeNull();
    } finally {
      await request.delete(`${API}/api/models/${ai.id}`);
    }
  });

  test("reread on the ai's page skips the server's list cache", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Reread");
    await openPage(page, ai.id);
    await expect(page.getByText("32,768 tokens loaded", { exact: false })).toBeVisible();

    await loaded(request, 65536);
    try {
      // Opened again, it reads through the list the server keeps ten minutes.
      await openPage(page, ai.id);
      await expect(page.getByText("32,768 tokens loaded", { exact: false })).toBeVisible();

      const fresh = page.waitForResponse((r) => r.url().endsWith(`/api/models/${ai.id}/refresh`));
      await page.getByRole("button", { name: "Read again" }).click();
      expect((await fresh).request().postDataJSON()).toEqual({ fresh: true });
      await expect(page.getByText("65,536 tokens loaded", { exact: false })).toBeVisible();
    } finally {
      await loaded(request, 32768);
    }
    await request.delete(`${API}/api/models/${ai.id}`);
  });

  test("removing the last ai of a service says its key goes too", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Last");
    await openPage(page, ai.id);
    await page.getByRole("button", { name: "Remove this AI" }).click();
    const box = page.getByRole("alertdialog", { name: `Remove ${ai.name}?` });
    await expect(box).toBeVisible();
    await expect(box.getByText(`It is the last AI of ${ai.service.name}: its key will be forgotten too.`)).toBeVisible();
    await boxHears(page);
    await box.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole("heading", { name: "My AIs" })).toBeVisible();
    await expect(lineOf(page, ai.id)).toHaveCount(0);
    expect(await aiOf(request, ai.id)).toBeUndefined();
    const services = (await (await request.get(`${API}/api/connections`)).json()) as { id: string }[];
    expect(services.map((s) => s.id)).not.toContain(ai.service.id);
  });

  test("removing the default ai names the oldest of the others in its confirmation", async ({ page, request }) => {
    const character = await makeCharacter(request);
    const ai = await lmstudioAi(request, "Default");
    await request.put(`${API}/api/models/${ai.id}`, { data: { is_default: true } });
    await request.post(`${API}/api/conversations`, { data: { character_id: character.id, model_id: ai.id } });
    // A second AI on its service: the key stays with it, and the box does not say it goes.
    const made = await request.post(`${API}/api/models`, {
      data: { service: { id: ai.service.id }, models: [{ model: "brume-12b-q8", name: `Second ${Date.now()}` }] },
    });
    expect(made.ok()).toBe(true);
    const second: Ai = (await made.json()).models[0];
    expect(second.service.id).toBe(ai.service.id);
    expect(second.id).not.toBe(ai.id);
    const others = (await ais(request)).filter((other) => other.id !== ai.id);
    const oldest = others.reduce((a, b) => (Date.parse(b.created_at) < Date.parse(a.created_at) ? b : a));
    try {
      await openPage(page, ai.id);
      await page.getByRole("button", { name: "Remove this AI" }).click();
      const box = page.getByRole("alertdialog", { name: `Remove ${ai.name}?` });
      await expect(box.getByText(`1 conversation will move to ${oldest.name}.`)).toBeVisible();
      await expect(box.getByText("It is the last AI of", { exact: false })).toHaveCount(0);
      await answer(page, false);
      expect(await aiOf(request, ai.id)).toBeTruthy();
    } finally {
      await e2eDefault(request);
      await request.delete(`${API}/api/models/${second.id}`);
      await request.delete(`${API}/api/models/${ai.id}`);
      await request.delete(`${API}/api/characters/${character.id}`);
    }
  });

  test("an ai that is not removed says so, and stays", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Kept");
    await openPage(page, ai.id);
    await page.route(`**/api/models/${ai.id}`, (route) =>
      route.request().method() === "DELETE" ? route.fulfill({ status: 500, body: "" }) : route.continue());
    const remove = page.getByRole("button", { name: "Remove this AI" });
    await remove.click();
    await answer(page, true);
    // Said under its button, the box closed, as everywhere else in Evermind.
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.locator("main").getByRole("alert")).toContainText("HTTP 500");
    await expect(page.locator("main").getByRole("alert")).toBeInViewport();
    await expect(remove).toBeEnabled();

    await page.goto("/#/settings");
    await expect(lineOf(page, ai.id)).toBeVisible();
    expect(await aiOf(request, ai.id)).toBeTruthy();
    await request.delete(`${API}/api/models/${ai.id}`);
  });

  test("a service moved to a new address asks for its key before anything is sent", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Moved");
    let sent = 0;
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/api/connections/")) sent += 1;
    });
    await openPage(page, ai.id);
    await openAdvanced(page);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const box = page.getByRole("dialog", { name: `Edit ${ai.service.name}` });
    await box.getByLabel("Server address").fill(`${MOCK_ROOT}/elsewhere/v1`);
    await box.getByRole("button", { name: "Save", exact: true }).click();
    await expect(box.getByRole("alert")).toHaveText(
      "New address: type the key again, or choose \"No key\". Evermind only sends it to the address you gave it for.",
    );
    expect(sent).toBe(0);
    expect((await (await request.get(`${API}/api/connections`)).json()).find((s: { id: string }) => s.id === ai.service.id).base_url)
      .toBe(LMSTUDIO);
    await request.delete(`${API}/api/models/${ai.id}`);
  });

  test("the page of a removed ai says it no longer exists", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Removed");
    await request.delete(`${API}/api/models/${ai.id}`);
    await page.goto(`/#/settings/ai/${ai.id}`);
    await expect(page.getByText("This AI no longer exists.")).toBeVisible();
    await page.getByRole("link", { name: "Back to settings" }).click();
    await expect(page.getByRole("heading", { name: "My AIs" })).toBeVisible();
  });

  test("the default switch makes the ai the default", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Switch");
    try {
      await openPage(page, ai.id);
      const toggle = page.getByRole("switch", { name: "Default AI" });
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));
      await toggle.click();
      await saved;
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await expect(toggle).toBeDisabled();
      expect((await aiOf(request, ai.id))?.is_default).toBe(true);
    } finally {
      await e2eDefault(request);
      await request.delete(`${API}/api/models/${ai.id}`);
    }
  });

  test("a price typed is saved as typed, and a negative one is refused and said", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Price");
    await openPage(page, ai.id);
    await openAdvanced(page);
    const saves = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));
    let saved = saves();
    await page.getByLabel("Read", { exact: true }).fill("0.5");
    await saved;
    await expect(page.getByText("Saved.")).toBeVisible();
    expect((await aiOf(request, ai.id)) as unknown as { price: { own_in: number | null } }).toMatchObject({ price: { own_in: 0.5 } });

    // Not thrown away in silence: the server's refusal is said under the fields, and nothing is cleared.
    saved = saves();
    await page.getByLabel("Read", { exact: true }).fill("-1");
    expect((await saved).status()).toBe(422);
    await expect(page.getByRole("alert")).toHaveText("Evermind could not accept this: something in it is missing or not valid.");
    expect((await aiOf(request, ai.id)) as unknown as { price: { own_in: number | null } }).toMatchObject({ price: { own_in: 0.5 } });
    await request.delete(`${API}/api/models/${ai.id}`);
  });

  test("a read the server refuses says why, and what is shown instead", async ({ page, request }) => {
    const made = await request.post(`${API}/api/models`, {
      data: {
        service: { provider: "openai-compatible", base_url: `${MOCK_ROOT}/locked/api/v1`, api_key: `sk-e2e-bad-${Date.now()}`, family: "openrouter" },
        models: [{ model: "locked/one", name: `Refused ${Date.now()}` }],
      },
    });
    expect(made.ok()).toBe(true);
    const ai: Ai = (await made.json()).models[0];
    try {
      await openPage(page, ai.id);
      await expect(page.getByRole("alert")).toHaveText(
        `${ai.service.name} refuses its key: change it under Advanced, “Service”, “Edit”. These are the values of the previous read.`,
      );
      await expect(page.getByText("the server does not say", { exact: true })).toBeVisible();

      await page.route(`**/api/models/${ai.id}/benchmark`, (route) => route.fulfill({ status: 500, body: "" }));
      await page.getByRole("button", { name: "Measure the speed" }).click();
      await expect(page.getByText("Evermind answered with an error (HTTP 500).")).toBeVisible();
    } finally {
      await request.delete(`${API}/api/models/${ai.id}`);
    }
  });

  test("an anthropic ai offers no penalties, which anthropic is never sent", async ({ page, request }) => {
    const made = await request.post(`${API}/api/models`, {
      data: {
        service: { provider: "anthropic", base_url: `${MOCK_ROOT}/anthropic-e2e`, api_key: `sk-ant-e2e-${Date.now()}` },
        models: [{ model: "claude-e2e", name: `Penalties ${Date.now()}` }],
      },
    });
    expect(made.ok()).toBe(true);
    const ai: Ai = (await made.json()).models[0];
    try {
      await openPage(page, ai.id);
      await openAdvanced(page);
      await expect(page.getByLabel("Temperature", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Frequency penalty", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("Presence penalty", { exact: true })).toHaveCount(0);
    } finally {
      await request.delete(`${API}/api/models/${ai.id}`);
    }
  });

  test("every advanced control saves on change and says so @desktop", async ({ page, request }) => {
    const ai = await lmstudioAi(request, "Controls");
    await openPage(page, ai.id);
    await openAdvanced(page);
    const saves = () => page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/models/${ai.id}`));

    /** Types into a field, and waits for its save and the word under it. */
    async function typed(label: string | RegExp, value: string, leave = false) {
      const field = page.getByLabel(label, { exact: typeof label === "string" });
      const saved = saves();
      await field.fill(value);
      if (leave) await field.blur();
      await saved;
      await expect(page.getByText("Saved.").first()).toBeVisible();
    }

    await typed("Display name", `Renamed ${Date.now()}`, true);
    await typed("Temperature", "0,7");
    await typed("Top-p", "0.9");
    await typed("Frequency penalty", "0.2");
    await typed("Presence penalty", "0.3");

    const capacity = page.getByRole("group", { name: "Reading capacity" });
    let saved = saves();
    await capacity.getByRole("button", { name: /^My value/ }).click();
    await capacity.getByRole("textbox").fill("20000");
    await saved;

    const ceiling = page.getByRole("group", { name: "Reply ceiling" });
    saved = saves();
    await ceiling.getByRole("button", { name: "Nothing sent" }).click();
    await saved;
    expect((await aiOf(request, ai.id))?.reply_cap.mode).toBe("unsent");
    saved = saves();
    await ceiling.getByRole("button", { name: /^My value/ }).click();
    await ceiling.getByRole("textbox").fill("3000");
    await saved;

    saved = saves();
    await capacity.getByRole("button", { name: /^Follow the server/ }).click();
    await saved;

    await typed("Model id", "brume-12b-q8", true);

    const now = (await aiOf(request, ai.id)) as Ai;
    expect(now.name).toMatch(/^Renamed /);
    expect([now.temperature, now.top_p, now.frequency_penalty, now.presence_penalty]).toEqual([0.7, 0.9, 0.2, 0.3]);
    expect(now.context.own).toBeNull();
    expect(now.reply_cap).toEqual({ mode: "fixed", tokens: 3000 });
    expect(now.model).toBe("brume-12b-q8");

    // Emptied, a setting goes back to the model's own.
    await typed("Temperature", "");
    expect((await aiOf(request, ai.id))?.temperature).toBeNull();
    await request.delete(`${API}/api/models/${ai.id}`);
  });
});
