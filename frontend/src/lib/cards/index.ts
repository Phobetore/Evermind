import { data, DataError, type CardCharacter, type CharacterInput, type LoreEntryInput } from "@/data";
import type { Character } from "@/types";
import { isPng, MAX_BYTES, pngTexts, withCard } from "./png";
import { FIELDS, readCardJson, type ReadCard } from "./read";
import { reportOf } from "./report";

// Character Card V2, and V1 and V3 when read; Evermind's own fields go in extensions.evermind.

export type { CardCharacter };
export { INFLATE_BOUND, pngTexts, withCard } from "./png";
export { cardToCharacter, isStorable, readCardJson, readEntry, type ReadCard } from "./read";
export { reportOf, type ImportReport, type ReportKey, type ReportLine } from "./report";

/** A V2 card of a character and its lorebook, whose order is its `insertion_order`. */
export function characterToCard(character: CharacterInput, lore: LoreEntryInput[]) {
  const card: Record<string, unknown> = Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [key, character[field]]),
  );
  card.alternate_greetings = character.alternate_greetings;
  card.tags = character.tags;
  card.extensions = { evermind: { kind: character.kind, tagline: character.tagline } };
  if (lore.length > 0) {
    card.character_book = {
      entries: lore.map(({ keys, content, enabled }, index) => ({
        keys, content, enabled, insertion_order: index, extensions: {},
      })),
    };
  }
  return { spec: "chara_card_v2", spec_version: "2.0", data: card };
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** A chunk's value as the JSON of a card: base64 of UTF-8, or, when it is no base64, itself. */
function chunkJson(value: string): string {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

/** The text of an entry without the decorators at its top, which a V2 copy of a V3 card leaves out. */
function withoutDecorators(content: string) {
  const lines = content.split("\n");
  let first = 0;
  while (first < lines.length && lines[first].startsWith("@@")) first++;
  return lines.slice(first).join("\n").trim();
}

/** What Evermind reads of a card, the part two cards of one PNG must agree on to be the same. */
function readingOf(character: CardCharacter) {
  return JSON.stringify([
    ["kind", "tagline", ...Object.values(FIELDS)].map((field) => character[field as keyof CardCharacter]),
    character.alternate_greetings,
    character.tags,
    character.lore_entries.map((entry) => [entry.keys, withoutDecorators(entry.content)]),
  ]);
}

/** The card a PNG carries: `ccv3` first, as the V3 specification and SillyTavern read it, else
 *  `chara`. The other one is kept too when it is also a card that reads differently. */
async function pngCard(png: Uint8Array): Promise<ReadCard | null> {
  const texts = await pngTexts(png);
  const found = ["ccv3", "chara"].flatMap((keyword) => {
    const value = texts.get(keyword);
    if (value === undefined) return [];
    const json = chunkJson(value);
    const card = parsed(json);
    const read = readCardJson(card, json, "png");
    return read ? [{ card: card as Record<string, unknown>, read }] : [];
  });
  if (found.length === 0) return null;
  const [{ card, read }, other] = found;
  if (!other || readingOf(other.read.character) === readingOf(read.character)) return read;
  const original = { ...read.original, other_text: other.read.original.text };
  return { ...read, original, report: reportOf(card, read.character, original) };
}

/** What bytes hold: a card in JSON, or a card in a PNG that is also its portrait. */
export async function readCardBytes(bytes: Uint8Array, name: string): Promise<{ read: ReadCard; portrait: File | null }> {
  if (bytes.length > MAX_BYTES) throw new DataError("File too large (15 MB max).", { kind: "file_too_large" });
  if (isPng(bytes)) {
    const read = await pngCard(bytes);
    if (!read) {
      throw new DataError("This PNG does not contain a character card.", { kind: "png_without_card" });
    }
    return { read, portrait: new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "image/png" }) };
  }
  // A byte order mark is left out by the decoder, and so out of the text kept.
  const text = new TextDecoder().decode(bytes);
  const read = readCardJson(parsed(text), text, "json");
  if (!read) {
    throw new DataError("Unrecognized file: a JSON card or a card PNG.", { kind: "unrecognized_card_file" });
  }
  return { read, portrait: null };
}

/** What a file holds; one too large is refused before it is read. */
export async function readCardFile(file: File): Promise<{ read: ReadCard; portrait: File | null }> {
  if (file.size > MAX_BYTES) throw new DataError("File too large (15 MB max).", { kind: "file_too_large" });
  return readCardBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** The card, then its portrait; one whose portrait does not go is taken away, so a retry makes one.
 *  The card's text goes with it, and what was read from it, for its export and a later reading. */
export async function installCard(read: ReadCard, portrait: File | null): Promise<Character> {
  const made = await data.characters.create({ ...read.character, card: { ...read.original, read: read.character } });
  if (!portrait) return made;
  try {
    return await data.characters.uploadAvatar(made.id, portrait);
  } catch (error) {
    await data.characters.remove(made.id).catch(() => {});
    throw error;
  }
}

export async function importCard(file: File): Promise<{ character: Character; read: ReadCard }> {
  const { read, portrait } = await readCardFile(file);
  return { character: await installCard(read, portrait), read };
}

/** The portrait as a PNG, its longest side 1536 at most; a dark square for a card without one. */
async function portraitPng(avatarUrl: string | null): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  if (avatarUrl) {
    const image = await createImageBitmap(await data.file(avatarUrl));
    const scale = Math.min(1, 1536 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } else {
    canvas.width = canvas.height = 512;
    context.fillStyle = "#1a1625";
    context.fillRect(0, 0, 512, 512);
  }
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await png!.arrayBuffer());
}

/** The name less what a file system refuses or what turns text around; "card" if nothing is left. */
const fileStem = (name: string) =>
  name.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/gu, "").trim() || "card";

/** A card as a file to download: JSON, or a PNG of its portrait that carries it. */
export async function cardFile(character: CardCharacter & Pick<Character, "avatar_url">, format: "json" | "png") {
  const card = characterToCard(character, character.lore_entries);
  const blob = format === "json"
    ? new Blob([JSON.stringify(card, null, 2)], { type: "application/json" })
    : withCard(await portraitPng(character.avatar_url), card);
  return { blob, filename: `${fileStem(character.name)}.${format}` };
}
