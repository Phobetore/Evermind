import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { answer, makeConversation } from "./fixtures";

/** What cannot be taken back is asked about in a box of our own: the browser's `confirm()` is not
 *  there to answer in a frame that forbids modals. */

async function listed(page: Page, request: APIRequestContext) {
  const convo = await makeConversation(request);
  const title = `Asked ${Date.now()}`;
  await request.patch(`${API}/api/conversations/${convo.id}`, { data: { title } });
  await page.goto("/#/chat");
  const row = page.locator(`main a[href$="/chat/${convo.id}"]`);
  await expect(row).toContainText(title);
  return { id: convo.id as string, row, remove: row.getByRole("button", { name: "Delete" }) };
}

const box = (page: Page) => page.getByRole("alertdialog", { name: /Delete the conversation/ });

test("asked before a conversation is deleted, and Cancel keeps it", async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page)).toBeVisible();

  await answer(page, false);
  await expect(row).toBeVisible();
});

test("Escape keeps it and hands the focus back", { tag: "@desktop" }, async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(remove).toBeFocused();
});

test("Enter as it opens deletes nothing", { tag: "@desktop" }, async ({ page, request }) => {
  const { row, remove } = await listed(page, request);
  await remove.click();
  await expect(box(page).getByRole("button", { name: "Cancel" })).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toBeVisible();
});

test("confirming deletes it, once", async ({ page, request }) => {
  const { id, row, remove } = await listed(page, request);
  const deletes: string[] = [];
  page.on("request", (r) => r.method() === "DELETE" && deletes.push(r.url()));

  await remove.click();
  await expect(box(page)).toBeVisible();
  await answer(page, true);
  await expect(row).toHaveCount(0);

  expect(deletes.filter((url) => url.endsWith(`/api/conversations/${id}`))).toHaveLength(1);
});

test("both buttons can be hit on a phone", async ({ page, request }, info) => {
  test.skip(info.project.name !== "phone", "a phone's thumb is the point");
  const { remove } = await listed(page, request);
  await remove.click();

  for (const name of ["Cancel", "Delete"]) {
    const button = box(page).getByRole("button", { name, exact: true });
    expect((await button.boundingBox())!.height, `${name} is too small to hit`).toBeGreaterThanOrEqual(43.5);
  }
});

test("a confirmation over another dialog answers for itself", async ({ page, request }) => {
  const persona = await (await request.post(`${API}/api/personas`, { data: { name: `Asked ${Date.now()}` } })).json();
  await page.goto("/#/personas");
  await page.getByRole("button", { name: persona.name }).click();
  const window = page.getByRole("dialog");
  await window.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();

  await answer(page, false);
  await expect(window).toBeVisible();
  await expect(window.getByRole("button", { name: "Delete" })).toBeFocused();
  const kept = (await (await request.get(`${API}/api/personas`)).json()).filter((p: { id: string }) => p.id === persona.id);
  expect(kept).toHaveLength(1);
  await request.delete(`${API}/api/personas/${persona.id}`);
});
