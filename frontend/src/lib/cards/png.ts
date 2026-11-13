// The chunks of a PNG: read its texts, and write the cards into them.

export const MAX_BYTES = 15 * 1024 * 1024; // what the server takes for a portrait
/** A bound of memory, not a policy: the text, its decoded copy and the parsed card must fit in a
 *  phone's tab together. Without it a 15 MB file that inflates a thousandfold would bring the tab
 *  down before anything could be checked. */
export const INFLATE_BOUND = 4 * MAX_BYTES;
export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The keywords whose compressed text is worth inflating: those a card is written under. */
const CARD_KEYWORDS = new Set(["chara", "ccv3"]);

export const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);

/** The chunks of a PNG, up to its end: type, data and where each starts. */
export function* chunks(png: Uint8Array) {
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

/** Bytes as they are, one character each: what a compressed text is when it is not inflated. */
function binary(bytes: Uint8Array) {
  let out = "";
  // In slices: spreading megabytes at once would pass more arguments than a call takes.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return out;
}

/** How much compressed text goes into the stream at a time. */
const SLICE = 16384;

/** A zlib stream inflated as UTF-8 text; null for one that is broken, or that grows past `bound`,
 *  which is given up as soon as it does rather than read to its end. */
async function inflate(data: Uint8Array, bound: number): Promise<string | null> {
  // In slices, each pulled only once the last is used: a browser inflates a whole piece before
  // the first read gives anything, so a body given at once would inflate whole past the bound.
  let sent = 0;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (sent >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(sent, sent + SLICE) as Uint8Array<ArrayBuffer>);
      sent += SLICE;
    },
  }, { highWaterMark: 0 });
  const reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > bound) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(whole);
}

/** Every text chunk, keyword lowercased → its first text. Only a chara or ccv3 zTXt/iTXt is
 *  decompressed, and never past INFLATE_BOUND; one that goes past it is refused. */
export async function pngTexts(png: Uint8Array, bound = INFLATE_BOUND): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // A keyword met before counts even when its text was refused: the first one is the one read.
  const seen = new Set<string>();
  for (const { type, data } of chunks(png)) {
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;
    const end = data.indexOf(0);
    if (end < 0) continue;
    const keyword = new TextDecoder("latin1").decode(data.subarray(0, end)).toLowerCase();
    if (seen.has(keyword)) continue;
    seen.add(keyword);
    let compressed = false;
    let body: Uint8Array;
    if (type === "tEXt") {
      body = data.subarray(end + 1);
    } else if (type === "zTXt") {
      // The byte after the keyword names the method; 0, zlib, is the only one there is.
      compressed = true;
      body = data.subarray(end + 2);
    } else {
      // Keyword, compression flag and method, language tag, translated keyword, then the text.
      compressed = data[end + 1] === 1;
      const language = data.indexOf(0, end + 3);
      const translated = language < 0 ? -1 : data.indexOf(0, language + 1);
      if (translated < 0) continue;
      body = data.subarray(translated + 1);
    }
    if (!compressed) {
      found.set(keyword, new TextDecoder().decode(body));
    } else if (!CARD_KEYWORDS.has(keyword)) {
      found.set(keyword, binary(body));
    } else {
      const text = await inflate(body, bound);
      if (text !== null) found.set(keyword, text);
    }
  }
  return found;
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

/** A tEXt chunk that holds the card in base64, under this keyword. */
function cardChunk(keyword: string, card: object): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(card));
  const body = new TextEncoder().encode(`tEXt${keyword}\0${btoa(binary(json))}`);
  const chunk = new Uint8Array(body.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length - 4);
  chunk.set(body, 4);
  view.setUint32(body.length + 4, crc32(body));
  return chunk;
}

/** The keyword of a text chunk, lowercased as it is read; null for any other chunk. */
export function textKeyword(type: string, data: Uint8Array) {
  if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") return null;
  const end = data.indexOf(0);
  return new TextDecoder("latin1").decode(end < 0 ? data : data.subarray(0, end)).toLowerCase();
}

/** The PNG less every chara and ccv3 chunk, of any kind and case, with the two written before IEND.
 *  Every other chunk is kept as its bytes are: the image itself, and what other applications put in. */
export function withCards(png: Uint8Array<ArrayBuffer>, v2: object, v3: object): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [png.subarray(0, PNG_SIGNATURE.length)];
  // A card left in another chunk would be read in place of the new one, or beside it as another card.
  let end = PNG_SIGNATURE.length;
  let ended = false;
  for (const { type, data, at } of chunks(png)) {
    end = at + 12 + data.length;
    if (type === "IEND") {
      parts.push(cardChunk("chara", v2), cardChunk("ccv3", v3));
      ended = true;
    }
    const keyword = textKeyword(type, data);
    if (keyword === null || !CARD_KEYWORDS.has(keyword)) parts.push(png.subarray(at, end));
  }
  if (!ended) parts.push(cardChunk("chara", v2), cardChunk("ccv3", v3));
  // Whatever follows the chunks is kept too, as the old writer kept it.
  parts.push(png.subarray(end));
  return new Blob(parts, { type: "image/png" });
}
