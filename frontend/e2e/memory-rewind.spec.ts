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
  summary: { placeholder: string; saveButton: string };
  facts: { extractButton: string };
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
  const pass = () =>
    request.post(`${API}/api/conversations/${convo.id}/memories/extract`, { timeout: 60_000 });
  await say("First question.");
  await pass();
  await say("Second question.");
  await pass();
  const before = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(before.summary).toMatch(/woke the character in a crypt/);
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

  // greeting, then two questions and their replies: the second question is the fourth message.
  if (covers) await panel.getByLabel(panelText.closeAriaLabel).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTitle("Delete from here").nth(3).click();
  if (covers) await opener.click();

  // The second pass had read to the second reply; the first, to the first.
  await expect(summary).toHaveValue(before.summary);
  const read = await (await request.get(`${API}/api/conversations/${convo.id}`)).json();
  expect(read.summary).toBe(before.summary);
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
