import { expect, test, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { chat, inLocale, makeCharacter, misfits, rootAt } from "./fixtures";

/**
 * The pages that did not fit a small phone at a very large text size: 320 by 640, with a root of
 * 32 px, as Safari and Firefox set it for the largest system text. Each is measured whole, in the
 * languages whose words are the longest.
 */

const LOCALES = ["en", "fr", "de"] as const;

async function large(page: Page, locale: string) {
  await inLocale(page, locale);
  await page.addInitScript(rootAt, "32px");
  await page.setViewportSize({ width: 320, height: 640 });
}

async function at32(page: Page) {
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
}

/** A character with a conversation that has a reply, so that her page lists it. */
async function characterWithConversation(request: Parameters<typeof makeCharacter>[0]) {
  const card = await makeCharacter(request, { name: "Wilhelmina" });
  const convo = await (await request.post(`${API}/api/conversations`, { data: { character_id: card.id } })).json();
  await chat(request, { conversation_id: convo.id, mode: "send", content: "Tell me." });
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { title: "An evening at the lighthouse" } });
  return { card, convo };
}

for (const locale of LOCALES) {
  test(`a character's page fits, in ${locale}`, async ({ page, request }) => {
    const { card } = await characterWithConversation(request);
    await large(page, locale);
    await page.goto(`/#/characters/${card.id}`);
    await at32(page);
    await expect(page.locator("main button", { hasText: "An evening at the lighthouse" })).toBeVisible();
    expect(await misfits(page)).toEqual([]);
  });
}

for (const locale of [...LOCALES, "es"] as const) {
  test(`the list of conversations behind its window of deletion fits, in ${locale}`, async ({ page, request }) => {
    const { convo } = await characterWithConversation(request);
    await large(page, locale);
    await page.goto("/#/chat");
    await at32(page);
    const row = page.locator(`main a[href="#/chat/${convo.id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.locator("button").last().click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await misfits(page)).toEqual([]);
  });

  test(`a character's form behind its window of deletion fits, in ${locale}`, async ({ page, request }) => {
    const card = await makeCharacter(request, { name: "Wilhelmina" });
    await large(page, locale);
    await page.goto(`/#/characters/${card.id}/edit`);
    await at32(page);
    await page.locator("main button.btn-danger, main button:has(svg.lucide-trash-2)").first().click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(await misfits(page)).toEqual([]);
  });
}
