import { data, DataError, type CharacterInput, type LoreEntryInput } from "@/data";
import type { Character } from "@/types";

// Character Card V2, and V1 and V3 when read; Evermind's own fields go in extensions.evermind.

/** A card as Evermind keeps one: its fields, and its whole lorebook. */
export type CardCharacter = CharacterInput & { lore_entries: LoreEntryInput[] };

const MAX_BYTES = 15 * 1024 * 1024; // what the server takes for a portrait
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const FIELDS = {
  name: "name",
  description: "description",
  personality: "personality",
  scenario: "scenario",
  first_mes: "greeting",
  mes_example: "example_dialogues",
  creator_notes: "creator_notes",
  system_prompt: "system_prompt",
  post_history_instructions: "post_history_instructions",
  creator: "creator",
  character_version: "character_version",
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field as text: anything but a string or a number counts as absent. */
const text = (value: unknown) =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

/** A list of texts, blank ones left out: one text alone is a list of one. */
const texts = (value: unknown) =>
  (Array.isArray(value) ? value : [value]).map(text).filter((item) => item.trim());

/** The character a card describes, V1 (flat), V2 or V3 (in `data`); null for what is no card. */
export function cardToCharacter(card: unknown): CardCharacter | null {
  const fields = isObject(card) && isObject(card.data) ? card.data : card;
  if (!isObject(fields) || !Object.keys(FIELDS).some((key) => typeof fields[key] === "string")) {
    return null;
  }
  const own = isObject(fields.extensions) && isObject(fields.extensions.evermind)
    ? fields.extensions.evermind : {};
  const book = isObject(fields.character_book) && Array.isArray(fields.character_book.entries)
    ? fields.character_book.entries : [];
  const character = Object.fromEntries(
    Object.entries(FIELDS).map(([key, field]) => [field, text(fields[key])]),
  ) as Record<(typeof FIELDS)[keyof typeof FIELDS], string>;
  return {
    ...character,
    // The longest the server takes, counted as it counts.
    name: [...character.name.trim()].slice(0, 200).join("") || "Unnamed",
    kind: own.kind === "scenario" ? "scenario" : "character",
    tagline: text(own.tagline),
    alternate_greetings: texts(fields.alternate_greetings),
    tags: texts(fields.tags),
    lore_entries: book.filter(isObject).map((entry) => ({
      keys: texts(entry.keys).map((key) => key.trim()),
      content: text(entry.content).trim(),
      enabled: Boolean(entry.enabled ?? true),
    })).filter((entry) => entry.keys.length > 0 && entry.content),
  };
}

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

/** The chunks of a PNG, up to its end: type, data and where each starts. */
function* chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let at = PNG_SIGNATURE.length; at + 12 <= png.length;) {
    const length = view.getUint32(at);
    if (at + 12 + length > png.length) return;
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    yield { type, data: png.subarray(at + 8, at + 8 + length), at };
    if (type === "IEND") return;
    at += 12 + length;
  }
}

const parsed = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

/** The card a PNG carries as base64 JSON in a tEXt chunk: `chara` (V2), else `ccv3` (V3). */
function pngCard(png: Uint8Array): CardCharacter | null {
  const found = new Map<string, string>();
  for (const { type, data: chunk } of chunks(png)) {
    const end = chunk.indexOf(0);
    if (type !== "tEXt" || end < 0) continue;
    const keyword = new TextDecoder().decode(chunk.subarray(0, end));
    if (!found.has(keyword)) found.set(keyword, new TextDecoder().decode(chunk.subarray(end + 1)));
  }
  for (const keyword of ["chara", "ccv3"]) {
    const base64 = found.get(keyword);
    if (base64 === undefined) continue;
    let json = "";
    try {
      json = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    } catch {
      continue;
    }
    const character = cardToCharacter(parsed(json));
    if (character) return character;
  }
  return null;
}

/** What a file holds: a card in JSON, or a card in a PNG that is also its portrait. */
export async function readCardFile(file: File): Promise<{ character: CardCharacter; portrait: File | null }> {
  if (file.size > MAX_BYTES) throw new DataError("File too large (15 MB max).", { kind: "file_too_large" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    const character = pngCard(bytes);
    if (!character) {
      throw new DataError("This PNG does not contain a character card.", { kind: "png_without_card" });
    }
    return { character, portrait: new File([bytes], file.name, { type: "image/png" }) };
  }
  // A byte order mark is left out by the decoder.
  const character = cardToCharacter(parsed(new TextDecoder().decode(bytes)));
  if (!character) {
    throw new DataError("Unrecognized file: a JSON card or a card PNG.", { kind: "unrecognized_card_file" });
  }
  return { character, portrait: null };
}

/** The card, then its portrait; one whose portrait does not go is taken away, so a retry makes one. */
export async function installCard(character: CardCharacter, portrait: File | null): Promise<Character> {
  const made = await data.characters.create(character);
  if (!portrait) return made;
  try {
    return await data.characters.uploadAvatar(made.id, portrait);
  } catch (error) {
    await data.characters.remove(made.id).catch(() => {});
    throw error;
  }
}

export async function importCard(file: File): Promise<Character> {
  const { character, portrait } = await readCardFile(file);
  return installCard(character, portrait);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** The PNG with the card in a `chara` chunk, before its end. */
export function withCard(png: Uint8Array<ArrayBuffer>, card: object): Blob {
  const json = new TextEncoder().encode(JSON.stringify(card));
  let binary = "";
  for (const byte of json) binary += String.fromCharCode(byte);
  const body = new TextEncoder().encode(`tEXtchara\0${btoa(binary)}`);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length - 4);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, crc32(body));
  const end = [...chunks(png)].find((c) => c.type === "IEND")?.at ?? png.length;
  return new Blob([png.subarray(0, end), chunk, png.subarray(end)], { type: "image/png" });
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
