import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "../playwright.config";
import { cardPortrait, conversationWithReply, makeConversation, PNG, turnRunning } from "./fixtures";

/** The smaller copies of a portrait, made by the browser and kept by the server: one 480 px wide
 *  for the grid, one 960 px wide for the backdrop. */

const SKIP = "evermind:sizes:skip";

type Card = { id: string; avatar_url: string | null; avatar_thumb_url: string | null; avatar_backdrop_url: string | null };

async function cardOf(request: APIRequestContext, id: string): Promise<Card> {
  return (await request.get(`${API}/api/characters/${id}`)).json();
}

const fileName = (url: string | null) => url?.slice(url.lastIndexOf("/") + 1) ?? "";

/** A picture drawn by a canvas of the page: a gradient, or a bright red centre on transparency. */
async function picture(page: Page, width: number, height: number, type: string, redCentre = false): Promise<Buffer> {
  const encoded = await page.evaluate(({ width, height, type, redCentre }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    if (redCentre) {
      context.fillStyle = "#ff0000";
      context.fillRect(width / 4, height / 4, width / 2, height / 2);
    } else {
      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#3a6ea5");
      gradient.addColorStop(1, "#e0b050");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    }
    return canvas.toDataURL(type).split(",")[1];
  }, { width, height, type, redCentre });
  return Buffer.from(encoded, "base64");
}

/** A card made by the form, with this portrait; its id once saved. */
async function cardWithPortrait(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  await page.goto("/#/characters/new");
  await page.getByLabel("Name", { exact: true }).fill(`Sized ${Date.now()}`);
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page).toHaveURL(/#\/characters\/(?!new$)[^/]+$/);
  return page.url().slice(page.url().lastIndexOf("/") + 1);
}

/** Waits until the copies of this card are kept, and gives the card then. */
async function copiesOf(request: APIRequestContext, id: string): Promise<Card> {
  await expect.poll(async () => (await cardOf(request, id)).avatar_backdrop_url, { timeout: 30_000 }).toBeTruthy();
  return cardOf(request, id);
}

/** The width of a kept picture, decoded in the page. */
function widthOf(page: Page, url: string): Promise<number> {
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const width = bitmap.width;
    bitmap.close();
    return width;
  }, url);
}

async function skipped(page: Page): Promise<string[]> {
  return JSON.parse((await page.evaluate((key) => localStorage.getItem(key), SKIP)) ?? "[]");
}

/** Settles once the page's queue has finished what it held: it makes one portrait's copies at a
 *  time, so a card asked for after them having its copies says the ones before are done. */
async function queueDrained(page: Page, request: APIRequestContext) {
  const convo = await makeConversation(request, { name: "After" });
  const sent = await request.post(`${API}/api/characters/${convo.character_id}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok()).toBe(true);
  // Within the page, not a new load: the same queue.
  await page.evaluate((id) => (location.hash = `#/chat/${id}`), convo.id);
  await copiesOf(request, convo.character_id);
}

/** Counts the requests that send copies. */
function sizesSent(page: Page): () => number {
  let sent = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/avatar/sizes")) sent += 1;
  });
  return () => sent;
}

test("a new portrait gets its two copies", { tag: "@desktop" }, async ({ page, request }) => {
  await page.goto("/");
  const buffer = await picture(page, 2000, 3000, "image/jpeg");
  const id = await cardWithPortrait(page, { name: "tall.jpg", mimeType: "image/jpeg", buffer });
  const card = await copiesOf(request, id);
  expect(card.avatar_thumb_url).toBeTruthy();
  expect(await widthOf(page, card.avatar_thumb_url!)).toBe(480);
  expect(await widthOf(page, card.avatar_backdrop_url!)).toBe(960);
});

test("an old card makes its copies when one of its conversations opens", { tag: "@desktop" }, async ({ page, request }) => {
  const convo = await makeConversation(request);
  const sent = await request.post(`${API}/api/characters/${convo.character_id}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(sent.ok()).toBe(true);
  expect((await cardOf(request, convo.character_id)).avatar_thumb_url).toBeNull();
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.locator("[data-message-id]").first()).toBeVisible();
  const card = await copiesOf(request, convo.character_id);
  expect(card.avatar_thumb_url).toBeTruthy();
});

test("an imported card gets the copies of its portrait", { tag: "@desktop" }, async ({ page, request }) => {
  const name = `Imported ${Date.now()}`;
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.getByTitle(/^import a card/i).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "imported.png", mimeType: "image/png",
    buffer: cardPortrait({ spec: "chara_card_v2", spec_version: "2.0", data: { name, description: "Brought in." } }),
  });
  await expect(dialog.getByRole("group", { name })).toBeVisible();
  const listed: { id: string; name: string }[] = await (await request.get(`${API}/api/characters`)).json();
  const made = listed.filter((c) => c.name === name);
  expect(made).toHaveLength(1);
  try {
    const card = await copiesOf(request, made[0].id);
    expect(card.avatar_thumb_url).toBeTruthy();
  } finally {
    await request.delete(`${API}/api/characters/${made[0].id}`);
  }
});

test("copies wait for the end of a reply being written", { tag: "@desktop" }, async ({ page, request }) => {
  test.setTimeout(120_000); // the slow reply alone takes about twenty seconds
  const convo = await conversationWithReply(request, { slowly: true });
  const portrait = await request.post(`${API}/api/characters/${convo.character_id}/avatar`, {
    multipart: { file: { name: "portrait.png", mimeType: "image/png", buffer: PNG } },
  });
  expect(portrait.ok()).toBe(true);
  expect((await cardOf(request, convo.character_id)).avatar_thumb_url).toBeNull();
  const posted: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/avatar/sizes")) posted.push(Date.now());
  });
  // The page's own word that nothing is being written any more, timed as it arrives, before it is read.
  let ended = 0;
  const ends = page.waitForResponse(async (r) => {
    if (r.request().method() !== "GET" || !new URL(r.url()).pathname.endsWith(`/api/conversations/${convo.id}/turn`)) return false;
    const at = Date.now();
    const over = (await r.json().catch(() => ({ running: true }))).running === false;
    if (over) ended = at;
    return over;
  });
  // Begun as another device would, so that the conversation opens on a reply already being written.
  await request.post(`${API}/api/chat`, { data: { conversation_id: convo.id, message_mode: "say", mode: "send", content: "Go on." } });
  await expect.poll(() => turnRunning(request, convo.id)).toBe(true);
  await page.goto(`/#/chat/${convo.id}`);
  await expect(page.getByTitle("Stop generation")).toBeVisible();
  await ends;
  await copiesOf(request, convo.character_id);
  expect(posted).toHaveLength(1);
  expect(posted[0], "copies were sent while the reply was being written").toBeGreaterThanOrEqual(ended);
});

test("a picture this browser cannot decode leaves the card as it was", { tag: "@desktop" }, async ({ page, request }) => {
  const failures: Error[] = [];
  page.on("pageerror", (error) => failures.push(error));
  const sent = sizesSent(page);
  // A PNG's header, then bytes that are no picture at all.
  const corrupt = Buffer.concat([PNG.subarray(0, 33), Buffer.alloc(200, 0x5a)]);
  const id = await cardWithPortrait(page, { name: "broken.png", mimeType: "image/png", buffer: corrupt });
  const card = await cardOf(request, id);
  await expect.poll(() => skipped(page)).toContain(fileName(card.avatar_url));
  await queueDrained(page, request);
  expect(sent(), "copies of a broken picture were sent").toBe(1);
  const after = await cardOf(request, id);
  expect(after.avatar_url).toBe(card.avatar_url);
  expect(after.avatar_thumb_url).toBeNull();
  expect(failures).toEqual([]);
});

test("a picture over the pixel bound is never decoded", { tag: "@desktop" }, async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = globalThis.createImageBitmap;
    (globalThis as { decoded?: number }).decoded = 0;
    globalThis.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => {
      (globalThis as { decoded?: number }).decoded! += 1;
      return original(...args);
    }) as typeof createImageBitmap;
  });
  const sent = sizesSent(page);
  // Only the header is read: it says 5000 by 4000, twenty million pixels.
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(5000, 8);
  ihdr.writeUInt32BE(4000, 12);
  ihdr.set([8, 2, 0, 0, 0], 16);
  const huge = Buffer.concat([PNG.subarray(0, 8), ihdr, PNG.subarray(33)]);
  const id = await cardWithPortrait(page, { name: "huge.png", mimeType: "image/png", buffer: huge });
  const card = await cardOf(request, id);
  await expect.poll(() => skipped(page)).toContain(fileName(card.avatar_url));
  await queueDrained(page, request);
  // The card asked for after it is decoded once, and each of its two copies made from that.
  const decoded = await page.evaluate(() => (globalThis as { decoded?: number }).decoded);
  expect(decoded, "the oversized picture was decoded").toBe(3);
  expect(sent()).toBe(1);
  const after = await cardOf(request, id);
  expect(after.avatar_url).toBe(card.avatar_url);
  expect(after.avatar_thumb_url).toBeNull();
});

test("a WebP this browser cannot write becomes a JPEG that still shows the portrait", { tag: "@desktop" }, async ({ page, request }) => {
  // What Safari does: asked for a WebP, it writes a PNG.
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      return original.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
    };
  });
  await page.goto("/");
  const buffer = await picture(page, 800, 800, "image/png", true);
  const id = await cardWithPortrait(page, { name: "red.png", mimeType: "image/png", buffer });
  const card = await copiesOf(request, id);
  expect(card.avatar_thumb_url).toMatch(/\.jpg$/);
  expect(card.avatar_backdrop_url).toMatch(/\.jpg$/);
  const { centre, corner } = await page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { centre: at(bitmap.width / 2, bitmap.height / 2), corner: at(5, 5) };
  }, card.avatar_thumb_url!);
  const [r, g, b] = centre;
  expect(Math.abs(r - 255), `centre ${centre}`).toBeLessThanOrEqual(40);
  expect(g, `centre ${centre}`).toBeLessThanOrEqual(40);
  expect(b, `centre ${centre}`).toBeLessThanOrEqual(40);
  // Where the portrait is transparent, the page's colour #0f0d12, not the black of a JPEG left bare.
  [15, 13, 18].forEach((channel, i) => expect(Math.abs(corner[i] - channel), `corner ${corner}`).toBeLessThanOrEqual(12));
});

test("a browser that does not know from-image still makes the copies", { tag: "@desktop" }, async ({ page, request }) => {
  // What Safari before 16 and Firefox before 111 do with that value: refuse the whole call.
  await page.addInitScript(() => {
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = ((source: ImageBitmapSource, ...rest: unknown[]) => {
      const options = rest.find((r) => typeof r === "object" && r !== null) as ImageBitmapOptions | undefined;
      if (options && "imageOrientation" in options) return Promise.reject(new TypeError("imageOrientation"));
      return (original as (...a: unknown[]) => Promise<ImageBitmap>)(source, ...rest);
    }) as typeof createImageBitmap;
  });
  await page.goto("/");
  const buffer = await picture(page, 1200, 900, "image/jpeg");
  const id = await cardWithPortrait(page, { name: "plain.jpg", mimeType: "image/jpeg", buffer });
  const card = await copiesOf(request, id);
  expect(card.avatar_thumb_url).toBeTruthy();
  expect(await skipped(page)).not.toContain(fileName(card.avatar_url));
});

test("copies come out at their width even if the browser ignores resizeWidth", { tag: "@desktop" }, async ({ page, request }) => {
  await page.addInitScript(() => {
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = ((source: ImageBitmapSource, ...rest: unknown[]) => {
      const kept = rest.map((r) => {
        if (typeof r !== "object" || r === null) return r;
        const others = { ...(r as ImageBitmapOptions) };
        delete others.resizeWidth;
        return others;
      });
      return (original as (...a: unknown[]) => Promise<ImageBitmap>)(source, ...kept);
    }) as typeof createImageBitmap;
  });
  await page.goto("/");
  const buffer = await picture(page, 2000, 1000, "image/jpeg");
  const id = await cardWithPortrait(page, { name: "wide.jpg", mimeType: "image/jpeg", buffer });
  const card = await copiesOf(request, id);
  expect(await widthOf(page, card.avatar_thumb_url!)).toBe(480);
  expect(await widthOf(page, card.avatar_backdrop_url!)).toBe(960);
});
