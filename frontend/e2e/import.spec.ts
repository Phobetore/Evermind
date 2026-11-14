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
  // Time alone does not hold the bound: Chromium inflates 3 GB given at once in about two seconds.
  // What the page hands the inflater is counted instead, behind the real stream.
  await page.addInitScript(() => {
    const Inflate = globalThis.DecompressionStream;
    const counted = window as unknown as { inflaterGiven: number };
    counted.inflaterGiven = 0;
    globalThis.DecompressionStream = class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const inflate = new Inflate(format);
        const writer = inflate.writable.getWriter();
        this.readable = inflate.readable;
        this.writable = new WritableStream<BufferSource>({
          write(piece) {
            counted.inflaterGiven += piece.byteLength;
            return writer.write(piece);
          },
          close: () => writer.close(),
          abort: (reason) => writer.abort(reason),
        });
      }
    } as typeof DecompressionStream;
  });

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
  const given = await page.evaluate(() => (window as unknown as { inflaterGiven: number }).inflaterGiven);
  expect(given, "the page handed the inflater the whole body, not a slice at a time").toBeGreaterThan(0);
  expect(given, "the page handed the inflater the whole body, not a slice at a time").toBeLessThan(bomb.length / 10);

  const card = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "After the bomb" } });
  await input.setInputFiles({ name: "after.json", mimeType: "application/json", buffer: Buffer.from(card) });
  await expect(dialog.locator("li", { hasText: "after.json" }).locator("svg.lucide-check")).toBeVisible();

  const listed: { id: string; name: string }[] = await (await request.get(`${API}/api/characters`)).json();
  for (const made of listed.filter((c) => c.name === "After the bomb")) {
    await request.delete(`${API}/api/characters/${made.id}`);
  }
});

/** A V2 card written by hand: three entries, one always on, and data of another application. */
function harborCard(name: string) {
  const entry = (keys: string[], content: string, constant = false) => ({
    keys, content, enabled: true, insertion_order: 0, constant, extensions: {},
  });
  return Buffer.from(JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: "A lighthouse keeper.",
      creator_notes: "A quiet harbor at the end of the world. Visitors are rare.",
      extensions: { zz_other_tool: { mood: "calm" } },
      character_book: {
        entries: [
          entry(["lamp"], "The lamp is never lit.", true),
          entry(["boat"], "One boat, no oars."),
          entry(["bell"], "The bell rings alone."),
        ],
      },
    },
  }));
}

type Listed = { id: string; name: string; kind: string; tagline: string };

async function listed(request: import("@playwright/test").APIRequestContext): Promise<Listed[]> {
  return (await request.get(`${API}/api/characters`)).json();
}

/** The cards that were not there before: the one this test imported, whatever an earlier run left
 *  behind under the same name. */
async function madeSince(request: import("@playwright/test").APIRequestContext, before: Set<string>) {
  return (await listed(request)).filter((c) => !before.has(c.id));
}

test("an imported card says what was used and what was only kept", async ({ page, request }) => {
  const before = new Set((await listed(request)).map((c) => c.id));
  try {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTitle(/^import a card/i).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "harbor.json", mimeType: "application/json", buffer: harborCard("Harbor report"),
    });

    const row = dialog.locator("li", { hasText: "harbor.json" });
    await expect(row).toContainText("3 entries");
    await expect(row).toContainText("always on");
    // What is only kept is folded away until asked for.
    await expect(row.getByText("zz_other_tool")).toBeHidden();
    await row.getByText("Kept in the card, not used").click();
    await expect(row.getByText("zz_other_tool")).toBeVisible();
  } finally {
    // Removed even when the test fails, so that a retry starts from the same data.
    for (const made of await madeSince(request, before)) await request.delete(`${API}/api/characters/${made.id}`);
  }
});

test("the kind and the tagline asked after an import are saved, and only when asked", async ({ page, request }) => {
  const name = "Harbor questions";
  const tagline = "A quiet harbor at the end of the world.";
  const before = new Set((await listed(request)).map((c) => c.id));
  try {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByTitle(/^import a card/i).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "harbor.json", mimeType: "application/json", buffer: harborCard(name),
    });
    const row = dialog.locator("li", { hasText: "harbor.json" });
    await expect(row).toContainText("3 entries");

    // By the card this import made, not by its name, which a failed earlier run may have left too.
    const made = await madeSince(request, before);
    expect(made.map((c) => c.name)).toEqual([name]);
    const stored = async () => (await listed(request)).find((c) => c.id === made[0].id)!;
    // The tagline is offered, not written: nothing was clicked.
    await expect(row.getByRole("textbox")).toHaveValue(tagline);
    expect((await stored()).tagline).toBe("");
    expect((await stored()).kind).toBe("character");

    await row.getByRole("button", { name: "Scenario" }).click();
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByText("Saved")).toBeVisible();
    const saved = await stored();
    expect(saved.kind).toBe("scenario");
    expect(saved.tagline).toBe(tagline);

    // The list behind the window follows the save, without a reload.
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /^Scenarios/ }).click();
    const card = page.locator(`a[href$="/characters/${made[0].id}"]`);
    await expect(card).toBeVisible();
    // Read as text: the card hides its tagline on a phone.
    await expect(card).toContainText(tagline);
  } finally {
    // Removed even when the test fails, so that a retry starts from the same data.
    for (const made of await madeSince(request, before)) await request.delete(`${API}/api/characters/${made.id}`);
  }
});
