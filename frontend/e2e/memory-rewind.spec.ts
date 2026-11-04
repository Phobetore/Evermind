import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { makeConversation } from "./fixtures";

/**
 * Taking the story back from a message takes what was remembered of it back too, to what
 * it was at that point: the facts as they stood, and the summary of the turns that stay.
 * The panel beside the conversation showed what it had read when it opened, so the
 * summary of a story that no longer existed stayed on screen, and saving it wrote it back.
 */

const panelText = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", "en.json"), "utf8"),
).chat.panel as {
  closeAriaLabel: string;
  summary: { placeholder: string; generateButton: string; saveButton: string };
  facts: { memoryTaskRunning: string; conversationChangedWhileReading: string; extractButton: string };
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
  // The pass was the first, so there is no earlier checkpoint to go back to.
  expect(read.memory_position).toBe(0);
});

test("cutting the story back puts the summary it had back", async ({ page, request }) => {
  const convo = await makeConversation(request);
  const say = (content: string) =>
    request.post(`${API}/api/chat`, {
      data: { conversation_id: convo.id, mode: "send", content, message_mode: "say" },
      timeout: 60_000,
    });
  await say("First question.");
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("Second question.");
  // Asked for, the summary of the story so far is another one than the pass wrote.
  const asked = await (await request.post(`${API}/api/conversations/${convo.id}/summarize`, {
    timeout: 60_000,
  })).json();
  await say("Third question.");
  await request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  const before = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(before.summary).not.toBe(asked.summary);

  await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("textarea").first()).toBeVisible();
  const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
  const covers = await opener.isVisible();
  if (covers) await opener.click();
  const panel = page.locator("aside:visible:has(textarea)");
  const summary = panel.getByPlaceholder(panelText.summary.placeholder);
  await expect(summary).toHaveValue(before.summary);

  // greeting, then three questions and their replies: the third question is the sixth message.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTitle("Delete from here").nth(5).click();
  if (covers) await opener.click();

  await expect(summary).toHaveValue(asked.summary);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe(asked.summary);
  // What was asked for read the turns without drawing facts from them: the pass that
  // wrote the first summary had read to the reply of the first question.
  expect(read.memory_position).toBe(2);
});

for (const [skipped, sentence] of [
  ["busy", panelText.facts.memoryTaskRunning],
  ["changed", panelText.facts.conversationChangedWhileReading],
] as const) {
  test(`a summary that was refused (${skipped}) says why and leaves the box alone`, async ({ page, request }) => {
    const convo = await makeConversation(request);
    await page.route("**/summarize", async (route) => {
      await route.fulfill({ json: { ...convo, summary: "", skipped } });
    });

    await page.addInitScript(() => localStorage.setItem("evermind:locale", "en"));
    await page.goto(`/#/chat/${convo.id}`);
    await expect(page.locator("textarea").first()).toBeVisible();
    const opener = page.locator("header button:has(svg.lucide-sliders-horizontal)");
    if (await opener.isVisible()) await opener.click();
    const panel = page.locator("aside:visible:has(textarea)");
    const summary = panel.getByPlaceholder(panelText.summary.placeholder);
    await summary.fill("Being typed.");

    await panel.getByRole("button", { name: panelText.summary.generateButton, exact: true }).click();

    await expect(panel).toContainText(sentence);
    await expect(summary).toHaveValue("Being typed.");
  });
}

// What is typed while the memory writes a summary would be replaced by what it writes.
for (const [task, url, button] of [
  ["a summary is written", "**/summarize", panelText.summary.generateButton],
  ["the memory reads the story", "**/memories/extract", panelText.facts.extractButton],
] as const) {
  test(`the summary box cannot be typed in while ${task}`, async ({ page, request }) => {
    const convo = await makeConversation(request);
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route(url, async (route) => {
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

    await panel.getByRole("button", { name: button, exact: true }).click();

    await expect(summary).toBeDisabled();
    await expect(panel.getByRole("button", { name: panelText.summary.saveButton })).toBeDisabled();
    release();
    await expect(summary).toBeEnabled();
  });
}

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
