/** The smaller copies of a portrait, one for the home grid and one for a conversation's backdrop.
 *  The server has no image library, so the browser makes them and the server only checks and keeps
 *  them. A phone has little memory and a slow link, so this decodes nothing it cannot afford, makes
 *  one portrait's copies at a time, and keeps the link free while a reply is being written. */

import { data } from "@/data";
import type { Asking, DeviceStore, PortraitSizes } from "@/data";
import type { Character } from "@/types";

export const GRID_WIDTH = 480;
export const BACKDROP_WIDTH = 960;
/** The largest picture this page decodes: the canvas area Safari on iOS allows, and about where a
 *  phone kills the tab (64 MB decoded) instead of failing the promise. */
export const MAX_PIXELS = 16_777_216;
/** How long reading a portrait or sending its copies may take: the largest portrait accepted
 *  (15 MB, MAX_UPLOAD_BYTES) over a link of 1 Mbit/s. Past it the transfer is taken for stalled. */
export const TRANSFER_MS = 120_000;

/** The page's colour, under a transparent portrait made into a JPEG, which has no transparency. */
const PAGE_COLOUR = "#0f0d12";
const QUALITY = 0.8;
/** The names of the portraits this device could not make copies of, kept across loads. */
const SKIP_KEY = "evermind:sizes:skip";

type Size = { width: number; height: number };
type Copies = { grid: Blob; backdrop: Blob };

const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

function sized(width: number, height: number): Size | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegSize(b: Uint8Array): Size | null {
  // Segment by segment: a phone's EXIF block, with its own thumbnail, can run to 64 KB before the frame.
  let at = 2;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // markers that carry no length
      continue;
    }
    // The end, or the scan, before any frame: no size to be had.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = be16(b, at + 2);
    if (length < 2) return null;
    // SOF0 to SOF15, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic conditioning).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= b.length) return null;
      return sized(be16(b, at + 7), be16(b, at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): Size | null {
  if (ascii(b, 12, "VP8 ")) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X") && b.length >= 30) return sized(le24(b, 24) + 1, le24(b, 27) + 1);
  return null;
}

/** Width and height read from the file's header (PNG IHDR; JPEG SOF0-SOF15 but C4, C8, CC, found
 *  by walking the segments; WebP VP8, VP8L, VP8X), without decoding; null for anything else. */
export function imageSize(bytes: Uint8Array): Size | null {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG\r\n\x1a\n") && ascii(b, 12, "IHDR")) {
    return sized(be32(b, 16), be32(b, 20));
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (b.length >= 16 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return webpSize(b);
  return null;
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
}

/** One copy, drawn on a canvas of the width asked for whatever the browser made of `resizeWidth`:
 *  a browser that ignored it does not pass a whole picture off as a copy. */
async function encode(copy: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(copy, 0, 0, width, height);
    const webp = await toBlob(canvas, "image/webp");
    if (!webp || webp.type === "image/webp") return webp;
    // Safari writes no WebP and gives a PNG instead: a JPEG then, over the page's colour so that a
    // transparent portrait does not turn black.
    context.clearRect(0, 0, width, height);
    context.fillStyle = PAGE_COLOUR;
    context.fillRect(0, 0, width, height);
    context.drawImage(copy, 0, 0, width, height);
    const jpeg = await toBlob(canvas, "image/jpeg");
    return jpeg?.type === "image/jpeg" ? jpeg : null;
  } finally {
    // iOS bounds the memory of all the canvases of a page, released or not until their size is gone.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Both copies of a picture, or null when this browser cannot or must not make them (too many
 *  pixels, a picture it cannot decode, a canvas it refuses). Never throws. */
export async function makePortraitSizes(source: Blob): Promise<Copies | null> {
  try {
    // Measured from the header before anything is decoded: on an iPhone a picture too large kills
    // the tab outright, and no catch would ever run.
    const size = imageSize(new Uint8Array(await source.arrayBuffer()));
    if (!size || size.width * size.height > MAX_PIXELS) return null;
    let full: ImageBitmap;
    try {
      full = await createImageBitmap(source, { imageOrientation: "from-image" });
    } catch (error) {
      // Safari before 16 and Firefox before 111 refuse the whole call for that value.
      if (!(error instanceof TypeError)) throw error;
      full = await createImageBitmap(source);
    }
    // Decoded once; both copies come from that decoding, not from the file again.
    const made: { bitmap: ImageBitmap; width: number; height: number }[] = [];
    try {
      for (const wanted of [GRID_WIDTH, BACKDROP_WIDTH]) {
        const width = Math.min(wanted, full.width);
        const height = Math.max(1, Math.round((full.height * width) / full.width));
        made.push({ bitmap: await createImageBitmap(full, { resizeWidth: width, resizeQuality: "high" }), width, height });
      }
    } catch (error) {
      made.forEach(({ bitmap }) => bitmap.close());
      throw error;
    } finally {
      full.close();
    }
    const blobs: Blob[] = [];
    try {
      for (const { bitmap, width, height } of made) {
        const blob = await encode(bitmap, width, height);
        if (!blob) return null;
        blobs.push(blob);
      }
    } finally {
      made.forEach(({ bitmap }) => bitmap.close());
    }
    return { grid: blobs[0], backdrop: blobs[1] };
  } catch {
    return null;
  }
}

/** Settles with what `start` gives, or with nothing once it fails or outlasts TRANSFER_MS, when
 *  its signal is aborted: a dropped link may never settle a request, and the queue moves on. */
function transfer<T>(start: (asking: Asking) => Promise<T>): Promise<T | undefined> {
  const giveUp = new AbortController();
  return new Promise((resolve) => {
    const stalled = setTimeout(() => {
      giveUp.abort();
      resolve(undefined);
    }, TRANSFER_MS);
    const done = (value: T | undefined) => {
      clearTimeout(stalled);
      resolve(value);
    };
    start({ signal: giveUp.signal }).then(done, () => done(undefined));
  });
}

/** Until the page has a moment: Safari has no requestIdleCallback. */
function rest(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestIdleCallback === "function") globalThis.requestIdleCallback(() => resolve());
    else setTimeout(resolve, 200);
  });
}

// for the test, under node: the queue with what it calls given
export function sizesQueue(deps: {
  make: (source: Blob) => Promise<Copies | null>;
  /** Both given a signal the queue aborts after TRANSFER_MS (data.file, data.characters.saveSizes). */
  read: (url: string, asking: Asking) => Promise<Blob>;
  save: (id: string, sizes: PortraitSizes, asking: Asking) => Promise<Character | null>;
  /** The portraits this device could not make copies of, kept across loads. */
  given: Pick<DeviceStore, "get" | "set">;
  /** false when the page is hidden or left (visibilitychange to hidden, pagehide), true when it
   *  is shown again; in the page, those two events of document and window. */
  visibility: (listener: (visible: boolean) => void) => () => void;
}): { want: typeof wantSizes; hold: typeof holdSizes; idle: () => Promise<void> } {
  const asked = new Set<string>();
  const waiting: { id: string; url: string; name: string; source?: Blob }[] = [];
  let pumping = false;
  let held = false;
  let released: (() => void)[] = [];
  // Whether the queue is doing something now, rather than empty or waiting for a reply to end.
  let busy = false;
  let settled: (() => void)[] = [];
  let visible = true;
  let decoding: string | null = null;

  function skipped(): string[] {
    try {
      const list: unknown = JSON.parse(deps.given.get(SKIP_KEY) ?? "[]");
      return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
    } catch {
      return [];
    }
  }
  function skip(name: string, kept: boolean) {
    const list = skipped().filter((n) => n !== name);
    deps.given.set(SKIP_KEY, JSON.stringify(kept ? [...list, name] : list));
  }

  // A decoding may kill the tab without a word (iOS does, for memory), and a name still kept then
  // is never tried again on this device. A page hidden or left may be thrown away by the phone for
  // no fault of the portrait's, so the name is kept only while the page is seen.
  deps.visibility((shown) => {
    visible = shown;
    if (decoding !== null) skip(decoding, shown);
  });

  function setBusy(now: boolean) {
    busy = now;
    if (now) return;
    const waiters = settled;
    settled = [];
    waiters.forEach((resolve) => resolve());
  }

  async function unheld() {
    if (!held) return;
    setBusy(false);
    await new Promise<void>((resolve) => released.push(resolve));
    setBusy(true);
  }

  async function run(job: (typeof waiting)[number]) {
    if (skipped().includes(job.name)) return;
    const source = job.source ?? (await transfer((asking) => deps.read(job.url, asking)));
    if (!source) return; // not read: tried again at the next load
    decoding = job.name;
    if (visible) skip(job.name, true);
    let copies: Copies | null = null;
    try {
      copies = await deps.make(source);
    } catch {
      copies = null;
    } finally {
      decoding = null;
    }
    // Refused once, refused for good on this device: too many pixels, or a picture it cannot read.
    if (!copies) {
      skip(job.name, true);
      return;
    }
    skip(job.name, false);
    await unheld();
    // A refusal for a portrait changed meanwhile, or a send that failed, leaves nothing on the server.
    await transfer((asking) => deps.save(job.id, { from: job.url, ...copies }, asking));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    setBusy(true);
    try {
      while (waiting.length) {
        await unheld();
        await rest();
        await unheld();
        const job = waiting.shift()!;
        await run(job).catch(() => {});
      }
    } finally {
      pumping = false;
      setBusy(false);
    }
  }

  return {
    want(character, source) {
      const url = character.avatar_url;
      if (!url || character.avatar_thumb_url) return;
      // A job is the card and its portrait's file: a new portrait of the same card is a new job.
      const name = url.slice(url.lastIndexOf("/") + 1);
      const key = `${character.id}/${name}`;
      if (asked.has(key)) return;
      asked.add(key);
      waiting.push({ id: character.id, url, name, source });
      void pump();
    },
    hold(now) {
      held = now;
      if (now) return;
      const waiters = released;
      released = [];
      waiters.forEach((resolve) => resolve());
    },
    idle() {
      return busy ? new Promise((resolve) => settled.push(resolve)) : Promise.resolve();
    },
  };
}

let page: ReturnType<typeof sizesQueue> | null = null;

function pageQueue() {
  page ??= sizesQueue({
    make: makePortraitSizes,
    read: (url, asking) => data.file(url, asking),
    save: (id, sizes, asking) => data.characters.saveSizes(id, sizes, asking),
    given: data.device,
    // Reached for with care: a test of a caller runs this without a page.
    visibility(listener) {
      const doc = globalThis.document;
      const changed = () => listener(doc?.visibilityState !== "hidden");
      const left = () => listener(false);
      const shown = () => listener(true);
      doc?.addEventListener("visibilitychange", changed);
      globalThis.addEventListener?.("pagehide", left);
      globalThis.addEventListener?.("pageshow", shown);
      changed();
      return () => {
        doc?.removeEventListener("visibilitychange", changed);
        globalThis.removeEventListener?.("pagehide", left);
        globalThis.removeEventListener?.("pageshow", shown);
      };
    },
  });
  return page;
}

/** Asks for the copies of a portrait that has none, once per portrait, one portrait at a time. */
export function wantSizes(
  // A tile has no avatar_backdrop_url: the server sets both copies together, so the first says.
  character: Pick<Character, "id" | "avatar_url" | "avatar_thumb_url">,
  source?: Blob,
): void {
  pageQueue().want(character, source);
}

/** While a reply is being written: no job starts, and copies made wait before being sent. */
export function holdSizes(held: boolean): void {
  // Letting go of a queue never made changes nothing.
  if (held || page) pageQueue().hold(held);
}

/** Uploads a portrait, then makes and sends its copies without being waited for. */
export async function savePortrait(id: string, file: File): Promise<Character> {
  const saved = await data.characters.uploadAvatar(id, file);
  // The portrait returned, not the old one: its new name makes a new job, and the file in hand
  // spares reading it back over the network.
  wantSizes(saved, file);
  return saved;
}
