import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { API } from "../playwright.config";
import { makeCharacter, PNG } from "./fixtures";

const EXPORT_FAILED = "The card could not be exported.";

/** A card whose portrait the server will be made to refuse to hand back. */
async function withPortrait(request: APIRequestContext) {
  const card = await makeCharacter(request);
  await request.post(`${API}/api/characters/${card.id}/avatar`, {
    multipart: { file: { name: "face.png", mimeType: "image/png", buffer: PNG } },
  });
  return card;
}

const badGateway = { status: 500, contentType: "text/html", body: "<h1>Bad gateway</h1>" };
const refusePortraits = (page: Page) => page.route("**/api/media/**", (route) => route.fulfill(badGateway));

/** Exporting is a click that starts a download. When the file cannot be made, the
 *  page has to say so: a click that does nothing, and says nothing, looks like a
 *  button that is broken. */
test("a card that cannot be exported says so, where the buttons are", async ({ page, request }) => {
  const card = await withPortrait(request);
  await page.goto(`/#/characters/${card.id}/edit`);
  await refusePortraits(page);

  await page.getByRole("button", { name: "PNG" }).click();
  // An alert of its own beside the buttons: the line at the bottom of the form
  // is a screen below them on a phone, and nothing there would have scrolled
  // into view.
  const message = page.getByRole("alert").filter({ hasText: EXPORT_FAILED });
  await expect(message).toBeVisible();
  await expect(message).toBeInViewport();
  // What the server answered is said too, in words and not as a code alone.
  await expect(message).toContainText("HTTP 500");

  // The next try starts clean, and works once the server does.
  await page.unroute("**/api/media/**");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG" }).click();
  expect((await download).suggestedFilename()).toBe("Vane.png");
  await expect(page.getByText(EXPORT_FAILED)).toBeHidden();
});

test("a failed export leaves a save error alone", async ({ page, request }) => {
  const card = await withPortrait(request);
  await page.goto(`/#/characters/${card.id}/edit`);

  // The save fails for lack of a name, and says so at the bottom of the form.
  await page.getByLabel("Name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Name is required.")).toBeVisible();

  await refusePortraits(page);
  await page.getByRole("button", { name: "PNG" }).click();

  await expect(page.getByRole("alert").filter({ hasText: EXPORT_FAILED })).toBeVisible();
  // Two different problems, each in its own place.
  await expect(page.getByText("Name is required.")).toBeVisible();
});

/** The chunks of a PNG, each with its CRC checked. */
function chunksOf(png: Buffer) {
  const chunks: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < png.length; at += png.readUInt32BE(at) + 12) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    expect(png.readUInt32BE(at + 8 + length), `the CRC of ${type}`).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    chunks.push({ type, data: png.subarray(at + 8, at + 8 + length) });
  }
  return chunks;
}

const NAME = "The Elmswood Vigil";

async function installed(request: APIRequestContext): Promise<{ id: string; avatar_url: string }[]> {
  const all = await (await request.get(`${API}/api/characters`)).json();
  return all.filter((c: { name: string }) => c.name === NAME);
}

/** A library card's portrait is a JPEG, which the export once swapped for a dark square. A
 *  portrait that does not go, as the card is made, leaves no card behind. */
test("a library card exported as a PNG keeps its portrait and its lorebook, and comes back with them", { tag: "@desktop" }, async ({ page, request }) => {
  for (const card of await installed(request)) await request.delete(`${API}/api/characters/${card.id}`);
  await page.goto("/#/");
  await page.getByTitle("Starter library").click();
  const library = page.getByRole("dialog");
  const row = library.locator(".rounded-xl", { has: page.getByRole("heading", { name: NAME }) });
  await page.route("**/api/library/*/avatar", (route) => route.fulfill(badGateway));
  await row.getByRole("button", { name: "Install" }).click();
  await expect(library.getByText("HTTP 500")).toBeVisible();
  expect(await installed(request)).toEqual([]);
  await page.unroute("**/api/library/*/avatar");
  await row.getByRole("button", { name: "Install" }).click();
  await expect(row.getByText("Installed")).toBeVisible();
  const [card] = await installed(request);

  await page.goto(`/#/characters/${card.id}/edit`);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG" }).click();
  const file = await (await download).path();
  const chunks = chunksOf(await readFile(file));
  const header = chunks[0].data;
  expect([header.readUInt32BE(0), header.readUInt32BE(4)], "not the portrait's size").toEqual([960, 615]);
  const text = chunks.find((c) => c.type === "tEXt" && c.data.toString("latin1").startsWith("chara\0"));
  const exported = JSON.parse(Buffer.from(text!.data.toString("latin1").slice(6), "base64").toString("utf8"));
  expect(exported.data.name).toBe(NAME);
  expect(exported.data.character_book.entries).toHaveLength(6);

  await page.goto("/#/");
  await page.getByTitle(/^import a card/i).click();
  const importing = page.getByRole("dialog");
  const vigil = { name: "vigil.png", mimeType: "image/png", buffer: await readFile(file) };
  await page.route("**/api/characters/*/avatar", (route) => route.fulfill(badGateway));
  await importing.locator('input[type="file"]').setInputFiles(vigil);
  await expect(importing.locator("li", { hasText: "vigil.png" })).toContainText("HTTP 500");
  expect(await installed(request)).toHaveLength(1);
  await page.unroute("**/api/characters/*/avatar");
  await importing.locator('input[type="file"]').setInputFiles(vigil);
  await expect(importing.locator("li", { hasText: "vigil.png" }).locator("svg.lucide-check")).toBeVisible();

  const copy = (await installed(request)).find((c) => c.id !== card.id)!;
  const read = await (await request.get(`${API}/api/characters/${copy.id}`)).json();
  expect(read).toMatchObject({ kind: "scenario", lore_entries: expect.arrayContaining([expect.objectContaining({ keys: ["rule", "rules", "three rules"] })]) });
  expect(read.lore_entries).toHaveLength(6);
  const portrait = await request.get(`${API}/${copy.avatar_url}`);
  expect(portrait.headers()["content-type"]).toBe("image/png");
  for (const made of await installed(request)) await request.delete(`${API}/api/characters/${made.id}`);
});
