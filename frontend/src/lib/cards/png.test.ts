import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readCardBytes } from "./index";
import { pngTexts } from "./png";

// A PNG of one pixel, without any card.
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const utf8 = (text: string) => new TextEncoder().encode(text);
const base64 = (text: string) => {
  let binary = "";
  for (const byte of utf8(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const join = (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A chunk of the given type, its length and CRC as a PNG has them. */
function chunk(type: string, body: Uint8Array) {
  const typed = join(utf8(type), body);
  const out = new Uint8Array(typed.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(typed, 4);
  view.setUint32(typed.length + 4, crc32(typed));
  return out;
}

const tEXt = (keyword: string, text: string) => chunk("tEXt", join(utf8(keyword), new Uint8Array([0]), utf8(text)));
const zTXt = (keyword: string, compressed: Uint8Array) =>
  chunk("zTXt", join(utf8(keyword), new Uint8Array([0, 0]), compressed));
const iTXt = (keyword: string, compressed: Uint8Array) =>
  chunk("iTXt", join(utf8(keyword), new Uint8Array([0, 1, 0]), utf8("en"), new Uint8Array([0, 0]), compressed));

/** The PNG with these chunks before its end. */
const withChunks = (...chunks: Uint8Array[]) => join(PNG.subarray(0, -12), ...chunks, PNG.subarray(-12));

const read = async (png: Uint8Array) => (await readCardBytes(png, "card.png")).read;
const kindOf = (png: Uint8Array) => readCardBytes(png, "card.png").catch((error) => error.kind);

const RISU_V3 = fixture("risu-v3.json");
const BACKFILL = fixture("risu-v2-backfill.json");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the chunks of a PNG", () => {
  test("ccv3 is read before chara", async () => {
    const poorer = JSON.stringify({ spec: "chara_card_v2", data: { name: "Arisen of the Gate" } });
    const card = await read(withChunks(tEXt("chara", base64(poorer)), tEXt("ccv3", base64(RISU_V3))));
    expect(card.character).toMatchObject({ nickname: "Ari", description: "The guardian of a gate between two worlds." });
    expect(card.original).toMatchObject({ text: RISU_V3, format: "png" });
  });

  test("chara is read when ccv3 is not a card", async () => {
    const card = await read(withChunks(tEXt("ccv3", base64("[1]")), tEXt("chara", base64(BACKFILL))));
    expect(card.character.name).toBe("Arisen of the Gate");
    expect(card.original).toEqual({ text: BACKFILL, format: "png", other_text: null });
  });

  test("a card in a zTXt chunk reads", async () => {
    const card = await read(withChunks(zTXt("chara", await deflate(utf8(base64(BACKFILL))))));
    expect(card.character.name).toBe("Arisen of the Gate");
    expect(card.original.text).toBe(BACKFILL);
  });

  test("a card in a compressed iTXt chunk reads", async () => {
    // Not base64 this time: the JSON itself, as a writer of iTXt might put it.
    const card = await read(withChunks(iTXt("ccv3", await deflate(utf8(RISU_V3)))));
    expect(card.character.nickname).toBe("Ari");
    expect(card.original.text).toBe(RISU_V3);
  });

  test("a keyword is found whatever its case", async () => {
    expect((await read(withChunks(tEXt("Chara", base64(BACKFILL))))).character.name).toBe("Arisen of the Gate");
    // A keyword met twice, whatever its case: the first occurrence is the one read.
    const named = (name: string) => base64(JSON.stringify({ spec: "chara_card_v2", data: { name } }));
    expect((await read(withChunks(tEXt("chara", named("A")), tEXt("Chara", named("B"))))).character.name).toBe("A");
    // Even when the first one is refused, the later one is not read in its place.
    expect(await kindOf(withChunks(zTXt("chara", utf8("no zlib stream")), tEXt("chara", named("B"))))).toBe("png_without_card");
  });

  test("a chara chunk that holds a V3 card reads as V3", async () => {
    const card = await read(withChunks(tEXt("chara", base64(RISU_V3))));
    expect(card.character).toMatchObject({ nickname: "Ari", creator_notes_multilingual: { en: "A guardian.", ko: "문지기." } });
    expect(card.report.kept.map((line) => line.key)).toContain("groupGreetings");
  });

  test("a PNG with no card says so", async () => {
    expect(await kindOf(PNG)).toBe("png_without_card");
    expect(await kindOf(withChunks(tEXt("chara", base64('"Vane"'))))).toBe("png_without_card");
  });

  test("a compressed chunk that inflates past the bound is refused, and nothing else is decompressed", async () => {
    let made = 0;
    const Inflate = globalThis.DecompressionStream;
    vi.stubGlobal("DecompressionStream", class extends Inflate {
      constructor(format: CompressionFormat) {
        super(format);
        made++;
      }
    });
    const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
    const zeros = await deflate(new Uint8Array(8 * 1024 * 1024));
    const other = await deflate(utf8("a comment that is never inflated"));
    const png = withChunks(zTXt("comment", other), zTXt("chara", zeros));

    const texts = await pngTexts(png, 1024 * 1024);
    expect(texts.has("chara")).toBe(false);
    expect(cancel).toHaveBeenCalled();
    expect(made).toBe(1);
    expect(texts.get("comment")).toBe(String.fromCharCode(...other));
  });

  test("a PNG with two cards that read differently keeps the other one", async () => {
    const other = BACKFILL.replace('"name": "Arisen of the Gate"', '"name": "Arisen, retold"');
    const card = await read(withChunks(tEXt("ccv3", base64(RISU_V3)), tEXt("chara", base64(other))));
    expect(card.character.name).toBe("Arisen of the Gate");
    expect(card.original).toEqual({ text: RISU_V3, format: "png", other_text: other });
    expect(card.report.kept).toContainEqual({ key: "otherChunk" });
  });

  test("a V2 backfill that differs only by its decorators is no other card", async () => {
    const card = await read(withChunks(tEXt("ccv3", base64(RISU_V3)), tEXt("chara", base64(BACKFILL))));
    expect(card.original).toEqual({ text: RISU_V3, format: "png", other_text: null });
    expect(card.report.kept.map((line) => line.key)).not.toContain("otherChunk");

    // The warning the V3 specification suggests for its V2 copy, added to the notes or in their place.
    const warning = "This character card is Character Card V3, but it is loaded as a Character Card V2. "
      + "Please use a Character Card V3 compatible application to use this character card properly.";
    const notes = "A guardian, written by hand for the tests.";
    for (const backfillNotes of [`${warning}\n\n${notes}`, `${notes}\n${warning}`, warning]) {
      const backfill = BACKFILL.replace(`"creator_notes": "${notes}"`, `"creator_notes": ${JSON.stringify(backfillNotes)}`);
      expect(backfill).not.toBe(BACKFILL);
      const warned = await read(withChunks(tEXt("ccv3", base64(RISU_V3)), tEXt("chara", base64(backfill))));
      expect(warned.original.other_text).toBeNull();
    }
    // Notes that say something else are another card all the same.
    const retold = BACKFILL.replace(`"creator_notes": "${notes}"`, `"creator_notes": "${warning} A keeper, retold."`);
    const other = await read(withChunks(tEXt("ccv3", base64(RISU_V3)), tEXt("chara", base64(retold))));
    expect(other.original.other_text).toBe(retold);
  });
});
