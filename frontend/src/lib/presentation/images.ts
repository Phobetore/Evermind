import { PIXEL_BOUND } from "./bounds";

export { PIXEL_BOUND } from "./bounds";

/** Every image written into a text, for layoutLength and inlineImagesLength only, and only
 *  through String.replace or matchAll: a global expression keeps its lastIndex between .test() or
 *  .exec() calls, and would answer differently for the same text on alternate calls. imageSource
 *  has its own anchored, non-global expression. No whitespace in the payload here: an expression
 *  that took it would also take whole paragraphs of words, which are only base64 letters. */
export const INLINE_IMAGE = /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/gi;

const WRITTEN_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i;

export type ImageSource =
  | { kind: "inline"; src: string; width: number; height: number; progressive?: true } // written into the card: shown at once
  | { kind: "tooLarge"; width: number; height: number } // written into the card, past PIXEL_BOUND
  | { kind: "remote"; src: string; host: string } // https on another site: shown on a tap
  | { kind: "refused"; insecureHost?: string }; // anything else: never loaded; over http, its host

type Size = { width: number; height: number; progressive?: true };

const BLOCK_BYTES = 3_072;
const BLOCK_CHARACTERS = 4_096;

/** The bytes of a base64 payload, decoded a block at a time and only where they are read: a
 *  jump over a segment decodes nothing, and small segments decode each block once. -1 past the
 *  content or for a block atob refuses (`broken` then tells which). */
function reader(base64: string) {
  let block = -1;
  let bytes = "";
  const state = {
    broken: false,
    at(n: number): number {
      if (n < 0 || state.broken) return -1;
      const wanted = Math.floor(n / BLOCK_BYTES);
      if (wanted !== block) {
        const start = wanted * BLOCK_CHARACTERS;
        if (start >= base64.length) return -1;
        try {
          bytes = atob(base64.slice(start, start + BLOCK_CHARACTERS));
        } catch {
          // A "=" in the middle, or a length that leaves 1 when divided by 4.
          state.broken = true;
          return -1;
        }
        block = wanted;
      }
      const offset = n - wanted * BLOCK_BYTES;
      return offset < bytes.length ? bytes.charCodeAt(offset) : -1;
    },
  };
  return state;
}

type Reader = ReturnType<typeof reader>;

function u16be(read: Reader, n: number): number {
  const high = read.at(n);
  const low = read.at(n + 1);
  return high < 0 || low < 0 ? -1 : (high << 8) | low;
}

function u16le(read: Reader, n: number): number {
  const low = read.at(n);
  const high = read.at(n + 1);
  return high < 0 || low < 0 ? -1 : (high << 8) | low;
}

function u24le(read: Reader, n: number): number {
  const a = read.at(n);
  const b = read.at(n + 1);
  const c = read.at(n + 2);
  return a < 0 || b < 0 || c < 0 ? -1 : a | (b << 8) | (c << 16);
}

function u32be(read: Reader, n: number): number {
  const high = u16be(read, n);
  const low = u16be(read, n + 2);
  return high < 0 || low < 0 ? -1 : high * 65_536 + low;
}

function matches(read: Reader, n: number, bytes: number[]): boolean {
  return bytes.every((byte, i) => read.at(n + i) === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

function sized(width: number, height: number, progressive = false): Size | null {
  if (!(width > 0) || !(height > 0)) return null;
  return progressive ? { width, height, progressive: true } : { width, height };
}

function pngSize(read: Reader): Size | null {
  if (!matches(read, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  if (!matches(read, 12, ascii("IHDR"))) return null;
  return sized(u32be(read, 16), u32be(read, 20));
}

/** Skips the sub-blocks that start at n (a length byte, that many bytes, until a length of 0);
 *  the position after them, or -1 where the content ends. */
function skipSubBlocks(read: Reader, n: number): number {
  for (;;) {
    const length = read.at(n);
    if (length < 0) return -1;
    n += 1 + length;
    if (length === 0) return n;
  }
}

function gifSize(read: Reader): Size | null {
  if (!matches(read, 0, ascii("GIF87a")) && !matches(read, 0, ascii("GIF89a"))) return null;
  let width = u16le(read, 6);
  let height = u16le(read, 8);
  const flags = read.at(10);
  if (width < 0 || height < 0 || flags < 0) return null;
  // Each image of the file, since one may declare more than its screen; a file cut short is
  // drawn as far as it goes.
  let n = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  for (;;) {
    const kind = read.at(n);
    if (kind === 0x21) {
      if (read.at(n + 1) < 0) break;
      n = skipSubBlocks(read, n + 2);
      if (n < 0) break;
    } else if (kind === 0x2c) {
      const left = u16le(read, n + 1);
      const top = u16le(read, n + 3);
      const frameWidth = u16le(read, n + 5);
      const frameHeight = u16le(read, n + 7);
      const packed = read.at(n + 9);
      if (left < 0 || top < 0 || frameWidth < 0 || frameHeight < 0 || packed < 0) break;
      width = Math.max(width, left + frameWidth);
      height = Math.max(height, top + frameHeight);
      n += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      // The size of the code, then the image's sub-blocks.
      if (read.at(n) < 0) break;
      n = skipSubBlocks(read, n + 1);
      if (n < 0) break;
    } else break;
  }
  if (read.broken) return null;
  return sized(width, height);
}

function webpSize(read: Reader): Size | null {
  if (!matches(read, 0, ascii("RIFF")) || !matches(read, 8, ascii("WEBP"))) return null;
  if (matches(read, 12, ascii("VP8X"))) {
    const width = u24le(read, 24);
    const height = u24le(read, 27);
    return width < 0 || height < 0 ? null : sized(width + 1, height + 1);
  }
  if (matches(read, 12, ascii("VP8L"))) {
    if (read.at(20) !== 0x2f) return null;
    const [b0, b1, b2, b3] = [21, 22, 23, 24].map((n) => read.at(n));
    if (b0 < 0 || b1 < 0 || b2 < 0 || b3 < 0) return null;
    return sized(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (matches(read, 12, ascii("VP8 "))) {
    if (!matches(read, 23, [0x9d, 0x01, 0x2a])) return null;
    const width = u16le(read, 26);
    const height = u16le(read, 28);
    return width < 0 || height < 0 ? null : sized(width & 0x3fff, height & 0x3fff);
  }
  return null;
}

function jpegSize(read: Reader): Size | null {
  if (!matches(read, 0, [0xff, 0xd8])) return null;
  let n = 2;
  for (;;) {
    if (read.at(n) !== 0xff) return null;
    // Fill bytes before the marker.
    while (read.at(n + 1) === 0xff) n++;
    const marker = read.at(n + 1);
    if (marker < 0) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = u16be(read, n + 5);
      const width = u16be(read, n + 7);
      if (width < 0 || height < 0) return null;
      // A progressive image's decoder keeps every coefficient of the image.
      const progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
      return sized(width, height, progressive);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      n += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    // 00 is a stuffed zero, 02 to BF are reserved: none starts a segment. A decoder drops them
    // and looks for the next marker byte by byte, where a length read here would jump elsewhere
    // and could land on a frame header the decoder skips inside a comment.
    if (marker < 0xc0) return null;
    const length = u16be(read, n + 2);
    if (length < 0) return null;
    // Each jump moves on at least two bytes: the time follows the size.
    n += 2 + length;
  }
}

/** Width and height read from the first bytes of a PNG, JPEG, GIF or WebP given in base64; null
 *  when the header cannot be read. Decodes only the bytes it reads. progressive: a JPEG whose
 *  frame marker is C2, C6, CA or CE, whose decoder keeps every coefficient. */
export function imageSize(
  type: "png" | "jpeg" | "gif" | "webp",
  base64: string,
): { width: number; height: number; progressive?: true } | null {
  const read = reader(base64);
  const size =
    type === "png" ? pngSize(read) : type === "gif" ? gifSize(read) : type === "webp" ? webpSize(read) : jpegSize(read);
  return read.broken ? null : size;
}

function isAsciiBlank(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

/** The source without the ASCII blanks at either end, trimmed by hand: an expression anchored at
 *  the end would be tried from every character of a long run of blanks. */
function trimBlanks(src: string): string {
  let start = 0;
  let end = src.length;
  while (start < end && isAsciiBlank(src.charCodeAt(start))) start++;
  while (end > start && isAsciiBlank(src.charCodeAt(end - 1))) end--;
  return src.slice(start, end);
}

/** What a page may do with the source of an image of a card. */
export function imageSource(src: unknown): ImageSource {
  if (typeof src !== "string") return { kind: "refused" };
  // The browsers' base64 decoding ignores ASCII blanks: they are taken out for this test only.
  const written = WRITTEN_IMAGE.exec(src.replace(/[\t\n\f\r ]/g, ""));
  if (written) {
    const type = written[1].toLowerCase();
    const size = imageSize(type === "jpg" || type === "jpeg" ? "jpeg" : (type as "png" | "gif" | "webp"), written[2]);
    if (size === null) return { kind: "refused" };
    if (size.width * size.height > PIXEL_BOUND)
      return { kind: "tooLarge", width: size.width, height: size.height };
    return size.progressive
      ? { kind: "inline", src, width: size.width, height: size.height, progressive: true }
      : { kind: "inline", src, width: size.width, height: size.height };
  }
  // What a browser does with <img src>: only the blanks at either end go; those in the middle
  // stay, and the address parser encodes them.
  const trimmed = trimBlanks(src);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:") return { kind: "remote", src: trimmed, host: url.hostname };
    // Never asked for: anyone on the way could change it or see who reads.
    if (url.protocol === "http:" && url.hostname !== "") return { kind: "refused", insecureHost: url.hostname };
  } catch {
    // A relative address would aim at our own server.
  }
  return { kind: "refused" };
}
