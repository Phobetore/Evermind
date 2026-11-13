import { expect, test } from "@playwright/test";
import { crc32, deflateRawSync, constants } from "node:zlib";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

test("Import explains itself before asking for a file", async ({ page, request }) => {
  await makeCharacter(request);
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  let pickerOpened = false;
  page.on("filechooser", () => { pickerOpened = true; });

  // By title: the label is hidden on a phone, where only the icon is left.
  await page.getByTitle(/^import a card/i).click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  expect(pickerOpened, "the file picker opened instead of the window").toBe(false);
  await expect(dialog).toContainText(/png/i);
  await expect(dialog).toContainText(/lorebook/i);
  await expect(dialog.getByRole("button", { name: /drop a card/i })).toBeVisible();
});

/** A zlib stream of `megabytes` of zeros, made without ever holding them: one megabyte deflated
 *  and flushed so that it stands alone, repeated, then the end and the checksum of that many zeros. */
function zerosDeflated(megabytes: number) {
  const block = deflateRawSync(Buffer.alloc(1 << 20), { finishFlush: constants.Z_FULL_FLUSH });
  const adler = Buffer.alloc(4);
  // Of zeros alone, the first sum stays 1 and the second counts them.
  adler.writeUInt32BE((((megabytes * 2 ** 20) % 65521) * 65536 + 1) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0x9c]), ...Array(megabytes).fill(block), deflateRawSync(Buffer.alloc(0)), adler]);
}

/** The PNG with a zTXt chunk under this keyword, before its end. */
function withZtxt(keyword: string, compressed: Buffer) {
  const typed = Buffer.concat([Buffer.from(`zTXt${keyword}\0\0`, "latin1"), compressed]);
  const chunk = Buffer.alloc(typed.length + 8);
  chunk.writeUInt32BE(typed.length - 4, 0);
  typed.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typed), typed.length + 4);
  return Buffer.concat([PNG.subarray(0, -12), chunk, PNG.subarray(-12)]);
}

test("a PNG whose card inflates without end is refused, and the page still answers", async ({ page, request }) => {
  await makeCharacter(request);
  const bomb = withZtxt("chara", zerosDeflated(3 * 1024));
  expect(bomb.length).toBeLessThan(15 * 1024 * 1024);

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByTitle(/^import a card/i).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.locator('input[type="file"]');

  const started = Date.now();
  await input.setInputFiles({ name: "bomb.png", mimeType: "image/png", buffer: bomb });
  await expect(dialog.locator("li", { hasText: "bomb.png" }))
    .toContainText("does not contain a character card", { timeout: 5_000 });
  expect(Date.now() - started, "the chunk was inflated far past the bound").toBeLessThan(5_000);

  const card = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "After the bomb" } });
  await input.setInputFiles({ name: "after.json", mimeType: "application/json", buffer: Buffer.from(card) });
  await expect(dialog.locator("li", { hasText: "after.json" }).locator("svg.lucide-check")).toBeVisible();

  const listed: { id: string; name: string }[] = await (await request.get(`${API}/api/characters`)).json();
  for (const made of listed.filter((c) => c.name === "After the bomb")) {
    await request.delete(`${API}/api/characters/${made.id}`);
  }
});
