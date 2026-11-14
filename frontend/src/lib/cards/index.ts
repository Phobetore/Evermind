import { data, DataError, type CardCharacter, type StoredCard } from "@/data";
import type { Character } from "@/types";
import { cardForExport } from "./export";
import { chunks, isPng, MAX_BYTES, pngTexts, textKeyword, withCards } from "./png";
import { FIELDS, readCardJson, type ReadCard } from "./read";
import { findOriginal, rereadPlan } from "./reread";
import { reportOf } from "./report";

// Character Card V1, V2 and V3 when read; V2 and V3 when written, Evermind's own fields in
// extensions.evermind.

export type { CardCharacter };
export { cardForExport, type ExportedCard } from "./export";
export { INFLATE_BOUND, pngTexts, withCards } from "./png";
export { cardToCharacter, isStorable, readCardJson, readEntry, type ReadCard } from "./read";
export { reportOf, type ImportReport, type ReportKey, type ReportLine } from "./report";
export { findOriginal, oldReading, rereadOffer, rereadPlan, type FoundCard, type RereadMode, type RereadPlan } from "./reread";

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

/** The warning the V3 specification suggests a V2 copy add to its creator's notes. */
const BACKFILL_WARNING = "This character card is Character Card V3, but it is loaded as a Character Card V2. "
  + "Please use a Character Card V3 compatible application to use this character card properly.";

/** What Evermind reads of a card, the part two cards of one PNG must agree on to be the same; the
 *  creator's notes are compared apart, by sameNotes. */
function readingOf(character: CardCharacter) {
  return JSON.stringify([
    ["kind", "tagline", ...Object.values(FIELDS)].filter((field) => field !== "creator_notes")
      .map((field) => character[field as keyof CardCharacter]),
    character.alternate_greetings,
    character.tags,
    character.lore_entries.map((entry) => [entry.keys, withoutDecorators(entry.content)]),
  ]);
}

/** Whether the other card's notes are the winner's: a V2 copy that follows the specification adds
 *  its warning to them, or puts the warning in their place, and is no other card for it. */
function sameNotes(winner: string, other: string) {
  const plain = (notes: string) => notes.split(BACKFILL_WARNING).join("").trim();
  return plain(winner) === plain(other) || (other.includes(BACKFILL_WARNING) && plain(other) === "");
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
  if (!other || (readingOf(other.read.character) === readingOf(read.character)
    && sameNotes(read.character.creator_notes, other.read.character.creator_notes))) return read;
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

/** The portrait as a PNG: its own bytes when it is one, its size and every chunk kept; else drawn
 *  again, its longest side 1536 at most; a dark square for a card without one. */
async function portraitPng(avatarUrl: string | null): Promise<Uint8Array<ArrayBuffer>> {
  const portrait = avatarUrl ? await data.file(avatarUrl) : null;
  if (portrait) {
    const bytes = new Uint8Array(await portrait.arrayBuffer());
    if (isPng(bytes)) return bytes;
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  if (portrait) {
    const image = await createImageBitmap(portrait);
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

export type ExportWarning = "tooLarge" | "assetsLeft";

/** The images a card points to in the chunks of its PNG, by the keyword of their chunk. */
function assetKeywords(data: Record<string, unknown>): string[] {
  const assets = Array.isArray(data.assets) ? data.assets : [];
  return assets.flatMap((asset) => {
    const uri = typeof asset === "object" && asset !== null ? (asset as Record<string, unknown>).uri : null;
    return typeof uri === "string" && uri.startsWith("__asset:") ? [`chara-ext-asset_:${uri.slice("__asset:".length)}`] : [];
  });
}

/** What a written file cannot do: be taken back (size in bytes, PNG only), carry the images its card points to. */
export function exportWarnings(format: "json" | "png", size: number, data: Record<string, unknown>, carriesAssets: boolean): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  // The file is written all the same: a JSON keeps everything, and other applications take larger PNGs.
  if (format === "png" && size > MAX_BYTES) warnings.push("tooLarge");
  // The V3 specification asks a tool to say so when it cannot keep the images joined to a card.
  if (assetKeywords(data).length > 0 && !carriesAssets) warnings.push("assetsLeft");
  return warnings;
}

/** Whether a PNG holds a text chunk for every one of these keywords. */
function carries(png: Uint8Array, keywords: string[]) {
  const found = new Set([...chunks(png)].map(({ type, data: body }) => textKeyword(type, body)));
  return keywords.every((keyword) => found.has(keyword.toLowerCase()));
}

/** A card as a file to download: JSON, or a PNG of its portrait that carries it; the card it was
 *  read from, when it is kept, with what was changed here written over it. */
export async function cardFile(
  character: CardCharacter & Pick<Character, "id" | "avatar_url" | "has_card">,
  format: "json" | "png",
): Promise<{ blob: Blob; filename: string; warnings: ExportWarning[] }> {
  let stored: StoredCard | null = character.has_card ? await data.characters.card(character.id) : null;
  let exported: CardCharacter = character;
  if (!character.has_card && character.card_rules === 1) {
    // A card made before cards were kept whole is exported from its card when it is found again,
    // as keeping that card would: on a copy, the character itself left as it is.
    const found = await findOriginal(character);
    if (found) {
      const plan = rereadPlan(character, found, "keep");
      exported = { ...character, ...plan.fields, lore_entries: plan.lore };
      stored = plan.card && { ...plan.card, read_at: "" };
    }
  }
  const card = cardForExport(exported, stored, new Date());
  let blob: Blob;
  let carriesAssets = false;
  if (format === "json") {
    blob = new Blob([JSON.stringify(card.json === "v3" ? card.v3 : card.v2, null, 2)], { type: "application/json" });
  } else {
    const portrait = await portraitPng(character.avatar_url);
    carriesAssets = carries(portrait, assetKeywords(card.v3.data));
    blob = withCards(portrait, card.v2, card.v3);
  }
  return {
    blob,
    filename: `${fileStem(character.name)}.${format}`,
    warnings: exportWarnings(format, blob.size, card.v3.data, carriesAssets),
  };
}
