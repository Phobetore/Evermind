import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
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

/** The card a tEXt chunk of this keyword holds, in base64. */
function cardIn(chunks: { type: string; data: Buffer }[], keyword: string) {
  const text = chunks.find((c) => c.type === "tEXt" && c.data.toString("latin1").startsWith(`${keyword}\0`));
  expect(text, `a ${keyword} chunk`).toBeTruthy();
  return JSON.parse(Buffer.from(text!.data.toString("latin1").slice(keyword.length + 1), "base64").toString("utf8"));
}

const NAME = "The Elmswood Vigil";

async function installed(request: APIRequestContext): Promise<{ id: string; avatar_url: string }[]> {
  const all = await (await request.get(`${API}/api/characters`)).json();
  return all.filter((c: { name: string }) => c.name === NAME);
}

/** A library card's portrait is a JPEG; a portrait that does not go leaves no card behind. */
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
  for (const [keyword, spec] of [["chara", "chara_card_v2"], ["ccv3", "chara_card_v3"]]) {
    const exported = cardIn(chunks, keyword);
    expect(exported.spec).toBe(spec);
    expect(exported.data.name).toBe(NAME);
    expect(exported.data.character_book.entries).toHaveLength(6);
  }

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

/** A chunk of this type, its length and CRC as a PNG has them. */
function chunk(type: string, body: Buffer) {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
  const out = Buffer.alloc(typed.length + 8);
  out.writeUInt32BE(body.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), typed.length + 4);
  return out;
}

/** A grey PNG of this size, with these chunks before its image. */
function greyPng(width: number, height: number, ...extra: Buffer[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per sample; colour type 0, grey, and the rest 0
  // Each row: its filter byte, 0, then a sample per pixel.
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), ...extra, chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A portrait is not drawn again: wider than the 1536 the canvas would bring it down to, and with a
 *  chunk of another application, it comes back as it went in. */
test("a PNG card comes back with its own image bytes and every chunk it had", { tag: "@desktop" }, async ({ page, request }) => {
  const name = "The Wide Portrait";
  const card = { spec: "chara_card_v2", spec_version: "2.0", data: { name, description: "A long, thin picture." } };
  const own = chunk("evMd", Buffer.from("a chunk Evermind does not know", "latin1"));
  const text = chunk("tEXt", Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`, "latin1"));
  const png = greyPng(2000, 10, own, text);

  await page.goto("/#/");
  await page.getByTitle(/^import a card/i).click();
  const importing = page.getByRole("dialog");
  await importing.locator('input[type="file"]').setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: png });
  await expect(importing.locator("li", { hasText: "wide.png" }).locator("svg.lucide-check")).toBeVisible();
  const all: { id: string; name: string }[] = await (await request.get(`${API}/api/characters`)).json();
  const made = all.filter((c) => c.name === name);
  try {
    expect(made).toHaveLength(1);
    await page.goto(`/#/characters/${made[0].id}/edit`);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "PNG" }).click();
    const chunks = chunksOf(await readFile(await (await download).path()));
    const header = chunks[0].data;
    expect([header.readUInt32BE(0), header.readUInt32BE(4)]).toEqual([2000, 10]);
    expect(chunks.find((c) => c.type === "evMd")?.data).toEqual(own.subarray(8, -4));
    expect(chunks.find((c) => c.type === "IDAT")?.data).toEqual(chunksOf(png).find((c) => c.type === "IDAT")!.data);
    expect(cardIn(chunks, "chara").data).toMatchObject(card.data);
    expect(cardIn(chunks, "ccv3").data).toMatchObject(card.data);
  } finally {
    for (const { id } of made) await request.delete(`${API}/api/characters/${id}`);
  }
});
