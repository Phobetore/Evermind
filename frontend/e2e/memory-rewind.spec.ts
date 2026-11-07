import { expect, test, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { makeConversation } from "./fixtures";

/**
 * Taking the story back from a message takes what was remembered of it back too: the facts
 * drawn from the turns that went, and the summary, to the one of the turns that stay.
 * The panel beside the conversation showed what it had read when it opened, so the
 * summary of a story that no longer existed stayed on screen, and saving it wrote it back.
 */

const en = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", "en.json"), "utf8"),
);
const panelText = en.chat.panel as {
  closeAriaLabel: string;
  directive: { placeholder: string; applyButton: string };
  summary: { placeholder: string; saveButton: string };
  facts: {
    extractButton: string; consolidateButton: string; pinTitle: string; unpinTitle: string;
    forgetAriaLabel: string;
  };
};

test("cutting the story back empties the summary and the facts of what went", async ({ page, request }) => {
  const convo = await makeConversation(request);
  for (const content of ["First question.", "Second question."]) {
    const sent = await request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content, message_mode: "say" },
      timeout: 60_000,
    });
    expect(sent.ok()).toBe(true);
  }
  // The model's memory pass writes two facts and a summary; one fact is by hand.
  const pass = await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, {
    timeout: 60_000,
  });
  expect(pass.ok()).toBe(true);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, {
    data: { content: "Written by hand.", is_pinned: true },
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  // On a laptop the panel is beside the conversation; on a phone it covers it.
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const covers = await opener.isVisible();
  if (covers) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(panel).toContainText("(3)");
  await expect(summary).toHaveValue(/woke the character in a crypt/);

  // The greeting, the first question and its reply stay; the second question goes.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTitle("Delete from here").nth(3).click();
  if (covers) await opener.click();

  await expect(panel).toContainText("(1)");
  await expect(summary).toHaveValue("");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.messages).toHaveLength(3);
  expect(read.summary).toBe("");
  // The pass was the first, so there is no earlier summary to go back to.
  expect(read.memory_position).toBe(0);
});

test("cutting the story back puts the summary it had back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const say = (content: string) =>
    request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content, message_mode: "say" },
      timeout: 60_000,
    });
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("First question.");
  await pass();
  const first = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  await say("Second question.");
  await pass();
  const before = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  // The mock's summary names the newest turn it read.
  expect(first.summary).toMatch(/woke the character in a crypt/);
  expect(before.summary).not.toBe(first.summary);
  expect(before.memory_position).toBe(4);

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const covers = await opener.isVisible();
  if (covers) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue(before.summary);

  // Reopened on a phone, the panel's own read never lands: the cut must be on the page already.
  let reopened = false;
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (!reopened || route.request().method() !== "GET") await route.continue();
  });
  // greeting, then two questions and their replies: the second question is the fourth message.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  // The facts are read again in the same breath as the reads that follow the cut.
  const cut = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${convo.id}/memories`));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTitle("Delete from here").nth(3).click();
  await cut;
  if (covers) {
    reopened = true;
    await opener.click();
  }

  // The second pass had read to the second reply; the first, to the first.
  await expect(summary).toHaveValue(first.summary);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe(first.summary);
  expect(read.memory_position).toBe(2);
});

// What is typed while the memory writes a summary would be replaced by what it writes.
test("the summary box cannot be typed in while the memory reads the story", async ({ page, request }) => {
  const convo = await makeConversation(request);
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/memories/extract", async (route) => {
    await released;
    await route.continue();
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await summary.fill("Typed before.");
  await expect(summary).toBeEnabled();

  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();

  await expect(summary).toBeDisabled();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeDisabled();
  release();
  await expect(summary).toBeEnabled();
});

test("a summary being typed is not replaced by one a pass wrote meanwhile", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await summary.fill("Typed, not saved yet.");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);

  await expect(summary).toHaveValue("Typed, not saved yet.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe("Typed, not saved yet.");
  // Typed over the summary from before the pass: the turns the pass read are read again.
  expect(read.memory_position).toBe(0);
});

test("a summary being typed stays through a Remember", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await summary.fill("Typed, not saved yet.");

  const remembered = page.waitForResponse((r) => r.url().endsWith("/memories/extract"));
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await remembered;
  await expect(summary).toBeEnabled();

  await expect(summary).toHaveValue("Typed, not saved yet.");
  await panel.getByRole("button", { name: panelText.summary.saveButton }).click();
  await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeHidden();
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe("Typed, not saved yet.");
  expect(read.memory_position).toBe(0);
});

test("a summary a pass wrote meanwhile shows when the person comes back to the window", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(summary).toHaveValue(/woke the character in a crypt/);
});

// On a laptop nothing else reads what a pass wrote before the person edits the summary.
test("the summary box shows what a pass wrote when it is entered", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  // The reads of the opening are done before the pass writes.
  await page.waitForLoadState("networkidle");

  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await summary.click();

  await expect(summary).toHaveValue(/woke the character in a crypt/);
});

// The directive's save and the summary's read go out together; the read must not undo the save.
test("a read sent with the directive's save does not put the old directive back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const directive = panel.getByPlaceholder(panelText.directive.placeholder);
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  await page.waitForLoadState("networkidle");
  // Something new for the read to bring, which shows when it has landed.
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });

  // The read is answered from the database as it was before the save, and lands after it.
  let readAnswered = () => {};
  const answered = new Promise<void>((resolve) => { readAnswered = resolve; });
  let saveShown = () => {};
  const shown = new Promise<void>((resolve) => { saveShown = resolve; });
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() === "PATCH") {
      await answered;
      await route.continue();
      return;
    }
    const before = await route.fetch();
    readAnswered();
    await shown;
    await route.fulfill({ response: before });
  });

  await directive.fill("Fog, lamplight, nothing resolved tonight.");
  await summary.click();
  await expect(panel.getByRole("button", { name: panelText.directive.applyButton })).toBeHidden();
  saveShown();

  await expect(summary).toHaveValue(/woke the character in a crypt/);
  await expect(directive).toHaveValue("Fog, lamplight, nothing resolved tonight.");
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.author_note).toBe("Fog, lamplight, nothing resolved tonight.");
});

test("an older read that lands last does not put back the summary a newer one brought", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/chat`, {
    data: { conversation_id: convo.id, mode: "send", content: "First question.", message_mode: "say" },
    timeout: 60_000,
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue("");
  await page.waitForLoadState("networkidle");

  // The read of a wake is answered before the pass, and delivered after the summary box's read.
  let fetched = () => {};
  const answered = new Promise<void>((resolve) => { fetched = resolve; });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "GET" || ++reads > 1) return route.continue();
    const old = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response: old });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await answered;
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await summary.click();
  await expect(summary).toHaveValue(/woke the character in a crypt/);
  const brought = await summary.inputValue();

  const late = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${convo.id}`));
  release();
  await (await late).finished();
  await page.waitForTimeout(500);
  await expect(summary).toHaveValue(brought);
});

// A read is the whole story; a phone has a hidden panel too, and a wake fires two events.
test("a phone waking reads the conversation once, and only for the panel it shows", async ({ page, request, isMobile }) => {
  test.skip(!isMobile, "a wide screen has neither a hidden panel nor one over the conversation");
  const convo = await makeConversation(request);
  const isRead = (r: Request) => r.method() === "GET" && r.url().endsWith(`/api/conversations/${convo.id}`);
  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const reads: string[] = [];
  page.on("request", (r) => {
    if (isRead(r)) reads.push(r.url());
  });
  const wake = async () => {
    reads.length = 0;
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(1500);
    return reads.length;
  };

  expect(await wake(), "reads for a panel nobody sees").toBe(0);

  const opened = page.waitForResponse((r) => isRead(r.request()));
  await page.locator("header button:has(svg.lucide-sliders-horizontal)").click();
  await opened;
  expect(await wake(), "reads for the panel over the conversation").toBe(1);
});

// A failed pass is told until one works, even a Remember that finds nothing to summarize.
test("a Remember that works takes away the error of a pass that failed before it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  // How the conversation reports the failed pass, until one works.
  let failing = true;
  await page.route(`**/api/conversations/${convo.id}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    const failure = { error: "Cannot reach the model.", kind: "unreachable" };
    await route.fulfill({ response, json: failing ? { ...body, memory_error: failure } : body });
  });
  await page.route("**/memories/extract", async (route) => {
    failing = false;
    await route.continue();
  });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const error = panel.locator("p.text-blood");
  await expect(error).toBeVisible();

  // Nothing in the story to read yet: it works, and writes no summary.
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();

  await expect(panel.locator("p.text-moss")).toBeVisible();
  await expect(error).toBeHidden();
});

test("pinning or forgetting a fact takes away the error a failed Remember left", async ({ page, request }) => {
  const convo = await makeConversation(request);
  for (const content of ["She keeps the key.", "The ferry runs on Tuesdays."]) {
    await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content } });
  }
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");
  const remember = panel.getByRole("button", { name: panelText.facts.extractButton, exact: true });
  const error = panel.locator("p.text-blood");

  await remember.click();
  await expect(error).toBeVisible();
  await panel.getByTitle(panelText.facts.pinTitle).first().click();
  await expect(error).toBeHidden();

  await remember.click();
  await expect(error).toBeVisible();
  await panel.getByLabel(panelText.facts.forgetAriaLabel).first().click();
  await expect(error).toBeHidden();
  await expect(panel).toContainText("(1)");
});

test("a memory pass that fails says so in the colour of an error, and keeps saying it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");

  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();

  const error = panel.locator("p.text-blood");
  await expect(error).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(error).toBeVisible();
});

test("a read of the facts that a pin overtook does not unpin it", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content: "She keeps the key." } });
  await page.route("**/memories/extract", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: "Cannot reach the model.", kind: "unreachable" }),
    }),
  );

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");

  // The read that follows the failed Remember is answered as the facts were, and delivered after the pin.
  let fetched = () => {};
  const answered = new Promise<void>((resolve) => { fetched = resolve; });
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/conversations/${convo.id}/memories`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const old = await route.fetch();
    fetched();
    await released;
    await route.fulfill({ response: old });
  });
  await panel.getByRole("button", { name: panelText.facts.extractButton, exact: true }).click();
  await answered;
  await panel.getByTitle(panelText.facts.pinTitle).click();
  await expect(panel.getByTitle(panelText.facts.unpinTitle)).toBeVisible();

  const late = page.waitForResponse((r) => r.url().endsWith(`/api/conversations/${convo.id}/memories`));
  release();
  await (await late).finished();
  await page.waitForTimeout(500);
  await expect(panel.getByTitle(panelText.facts.unpinTitle)).toBeVisible();
});

test("a merge with too few facts says why, in the colour of an error", async ({ page, request }) => {
  const convo = await makeConversation(request);
  await request.post(`${API}/api/conversations/${convo.id}/memories`, { data: { content: "She keeps the key." } });

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");

  await panel.getByRole("button", { name: panelText.facts.consolidateButton, exact: true }).click();

  await expect(panel.locator("p.text-blood")).toHaveText(en.errors.tooFewFacts);
  await expect(panel).toContainText("She keeps the key.");
});

test("a fact that is gone says so when it is pinned, and leaves the list", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const made = await request.post(`${API}/api/conversations/${convo.id}/memories`, {
    data: { content: "She keeps the key." },
  });
  const fact = await made.json();

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  if (await opener.isVisible()) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  await expect(panel).toContainText("She keeps the key.");

  // Taken out behind the panel's back, as a pass of the memory or a cut in the story can.
  await request.delete(`${API}/api/memories/${fact.id}`);
  await panel.getByTitle("Pin (always injected)").click();

  await expect(panel).toContainText("This fact no longer exists.");
  await expect(panel).not.toContainText("She keeps the key.");
});
