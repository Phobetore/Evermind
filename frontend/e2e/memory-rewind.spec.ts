import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { API } from "../playwright.config";
import { makeConversation } from "./fixtures";

/**
 * Taking the story back from a message takes what was remembered of it back too:
 * the facts drawn from the turns that went, and the summary that described them.
 * The panel beside the conversation showed what it had read when it opened, so the
 * summary of a story that no longer existed stayed on screen, and saving it, or
 * just leaving its box, wrote it back.
 */

const panelText = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "src", "i18n", "locales", "en.json"), "utf8"),
).chat.panel as { closeAriaLabel: string; summary: { placeholder: string } };

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
  expect(read.memory_position).toBe(2);
});
