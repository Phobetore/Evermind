import { afterEach, describe, expect, test, vi } from "vitest";
import type { Asking, PortraitSizes } from "@/data";
import type { Character } from "@/types";
import { imageSize, sizesQueue, TRANSFER_MS } from "./portraitSizes";

const SKIP = "evermind:sizes:skip";
const copies = () => ({ grid: new Blob(["g"], { type: "image/webp" }), backdrop: new Blob(["b"], { type: "image/webp" }) });

function portrait(id: string, name: string, thumb: string | null = null) {
  return { id, avatar_url: `api/media/${name}`, avatar_thumb_url: thumb } as Pick<Character, "id" | "avatar_url" | "avatar_thumb_url">;
}

/** The queue with stand-ins for what it calls; `kept` is the device store, shared by a page and its reload. */
function harness(kept = new Map<string, string>()) {
  const listeners: ((visible: boolean) => void)[] = [];
  const make = vi.fn<(source: Blob) => Promise<{ grid: Blob; backdrop: Blob } | null>>(async () => copies());
  const read = vi.fn<(url: string, asking: Asking) => Promise<Blob>>(async () => new Blob(["portrait"]));
  const save = vi.fn<(id: string, sizes: PortraitSizes, asking: Asking) => Promise<Character | null>>(
    async () => ({}) as Character,
  );
  const queue = sizesQueue({
    make: (source) => make(source),
    read: (url, asking) => read(url, asking),
    save: (id, sizes, asking) => save(id, sizes, asking),
    given: { get: (key) => kept.get(key) ?? null, set: (key, value) => void kept.set(key, value) },
    visibility(listener) {
      listeners.push(listener);
      return () => void listeners.splice(listeners.indexOf(listener), 1);
    },
  });
  const skipped = (): string[] => JSON.parse(kept.get(SKIP) ?? "[]");
  const visible = (shown: boolean) => listeners.forEach((listener) => listener(shown));
  return { queue, make, read, save, kept, skipped, visible };
}

const never = <T>() => new Promise<T>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("the queue of copies", () => {
  test("one portrait at a time", async () => {
    const h = harness();
    let finish!: () => void;
    h.make.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(copies()))));
    h.queue.want(portrait("a", "a.png"));
    h.queue.want(portrait("b", "b.png"));
    await vi.waitFor(() => expect(h.make).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.make).toHaveBeenCalledTimes(1);
    finish();
    await h.queue.idle();
    expect(h.make).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  test("a portrait is asked for once per page", async () => {
    const h = harness();
    h.queue.want(portrait("a", "a.png"));
    h.queue.want(portrait("a", "a.png"));
    await h.queue.idle();
    h.queue.want(portrait("a", "a.png"));
    await h.queue.idle();
    expect(h.make).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  test("a new portrait of the same card is asked for even after the old one", async () => {
    const h = harness();
    h.queue.want(portrait("a", "old.png"));
    await h.queue.idle();
    h.queue.want(portrait("a", "new.png"));
    await h.queue.idle();
    expect(h.save.mock.calls.map(([, sizes]) => sizes.from)).toEqual(["api/media/old.png", "api/media/new.png"]);
  });

  test("a failure to send is not retried in the same page, and is after a reload", async () => {
    const h = harness();
    h.save.mockRejectedValue(new Error("the connection dropped"));
    h.queue.want(portrait("a", "a.png"));
    await h.queue.idle();
    h.queue.want(portrait("a", "a.png"));
    await h.queue.idle();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.skipped()).toEqual([]);

    const reloaded = harness(h.kept);
    reloaded.queue.want(portrait("a", "a.png"));
    await reloaded.queue.idle();
    expect(reloaded.save).toHaveBeenCalledTimes(1);
  });

  test("a portrait refused for its size is not tried again after a reload", async () => {
    const h = harness();
    h.make.mockResolvedValue(null);
    h.queue.want(portrait("a", "huge.png"));
    await h.queue.idle();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.skipped()).toEqual(["huge.png"]);

    const reloaded = harness(h.kept);
    reloaded.queue.want(portrait("a", "huge.png"));
    await reloaded.queue.idle();
    expect(reloaded.make).not.toHaveBeenCalled();
    expect(reloaded.read).not.toHaveBeenCalled();
  });

  test("a tab that died while decoding does not try again", async () => {
    const h = harness();
    h.make.mockImplementation(never);
    h.queue.want(portrait("a", "a.png"));
    await vi.waitFor(() => expect(h.make).toHaveBeenCalled());
    expect(h.skipped()).toEqual(["a.png"]);

    // The tab is gone without a word; the next load finds the name kept.
    const reloaded = harness(h.kept);
    reloaded.queue.want(portrait("a", "a.png"));
    await reloaded.queue.idle();
    expect(reloaded.make).not.toHaveBeenCalled();
  });

  test("a page left while decoding tries again next time", async () => {
    const h = harness();
    h.make.mockImplementation(never);
    h.queue.want(portrait("a", "a.png"));
    await vi.waitFor(() => expect(h.make).toHaveBeenCalled());
    h.visible(false);
    expect(h.skipped()).toEqual([]);
    const reloaded = harness(h.kept);
    reloaded.queue.want(portrait("a", "a.png"));
    await reloaded.queue.idle();
    expect(reloaded.make).toHaveBeenCalledTimes(1);

    // Hidden and shown again before the tab dies: the name is back.
    const other = harness();
    other.make.mockImplementation(never);
    other.queue.want(portrait("b", "b.png"));
    await vi.waitFor(() => expect(other.make).toHaveBeenCalled());
    other.visible(false);
    other.visible(true);
    const afterDeath = harness(other.kept);
    afterDeath.queue.want(portrait("b", "b.png"));
    await afterDeath.queue.idle();
    expect(afterDeath.make).not.toHaveBeenCalled();
  });

  test("a portrait that has its copies is left alone", async () => {
    const h = harness();
    h.queue.want(portrait("a", "a.png", "api/media/a-grid.webp"));
    h.queue.want({ id: "b", avatar_url: null, avatar_thumb_url: null });
    await h.queue.idle();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.make).not.toHaveBeenCalled();
  });

  test("a source in hand is not read again", async () => {
    const h = harness();
    const source = new Blob(["in hand"]);
    h.queue.want(portrait("a", "a.png"), source);
    await h.queue.idle();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.make).toHaveBeenCalledWith(source);

    h.queue.want(portrait("b", "b.png"));
    await h.queue.idle();
    expect(h.read.mock.calls.map(([url]) => url)).toEqual(["api/media/b.png"]);
  });

  test("a refusal for a changed portrait ends quietly", async () => {
    const h = harness();
    h.save.mockResolvedValueOnce(null);
    h.queue.want(portrait("a", "a.png"));
    h.queue.want(portrait("b", "b.png"));
    await h.queue.idle();
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.skipped()).toEqual([]);
  });

  test("nothing is sent while a reply is being written", async () => {
    const h = harness();
    h.queue.hold(true);
    h.queue.want(portrait("a", "a.png"));
    h.queue.want(portrait("b", "b.png"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.read).not.toHaveBeenCalled();
    expect(h.make).not.toHaveBeenCalled();

    // A reply that begins while copies are made: they are made, and wait.
    let finish!: () => void;
    h.make.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve(copies()))));
    h.queue.hold(false);
    await vi.waitFor(() => expect(h.make).toHaveBeenCalledTimes(1));
    h.queue.hold(true);
    finish();
    await h.queue.idle();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.save).not.toHaveBeenCalled();
    expect(h.make).toHaveBeenCalledTimes(1);

    h.queue.hold(false);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  test("a stalled transfer frees the queue", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.save.mockImplementationOnce(never);
    h.queue.want(portrait("a", "a.png"));
    h.queue.want(portrait("b", "b.png"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.save).toHaveBeenCalledTimes(1);
    const sending = h.save.mock.calls[0][2].signal!;
    expect(sending.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(TRANSFER_MS);
    expect(sending.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1][0]).toBe("b");
    expect(h.skipped()).toEqual([]);

    // A read that never settles frees it the same way.
    const r = harness();
    r.read.mockImplementationOnce(never);
    r.queue.want(portrait("c", "c.png"));
    r.queue.want(portrait("d", "d.png"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.read).toHaveBeenCalledTimes(1);
    const reading = r.read.mock.calls[0][1].signal!;
    await vi.advanceTimersByTimeAsync(TRANSFER_MS);
    expect(reading.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.make).toHaveBeenCalledTimes(1);
    expect(r.save.mock.calls.map(([id]) => id)).toEqual(["d"]);
    expect(r.skipped()).toEqual([]);
  });

  test("a skip list that cannot be read counts as empty", async () => {
    const h = harness(new Map([[SKIP, "{not a list"]]));
    h.queue.want(portrait("a", "a.png"));
    await h.queue.idle();
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});

/** Bytes as the test writes them: numbers, and strings as their ASCII codes. */
function bytes(...parts: (number | string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(...[...part].map((c) => c.charCodeAt(0)));
    else if (Array.isArray(part)) out.push(...part);
    else out.push(part);
  }
  return Uint8Array.from(out);
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

describe("imageSize", () => {
  test("a PNG", () => {
    const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(2000), be32(3000), [8, 6, 0, 0, 0]);
    expect(imageSize(png)).toEqual({ width: 2000, height: 3000 });
  });

  test("a JPEG with a 60 KB EXIF segment before its SOF2", () => {
    const exif = new Array(60_000).fill(0x41);
    const jpeg = bytes(
      [0xff, 0xd8],
      [0xff, 0xe1], be16(exif.length + 2), exif,
      [0xff, 0xdb], be16(4), [0, 0],
      [0xff, 0xc4], be16(4), [0, 0], // a Huffman table: C4, never a frame
      [0xff, 0xc2], be16(11), [8], be16(1080), be16(1920), [3, 1, 0x22, 0],
    );
    expect(imageSize(jpeg)).toEqual({ width: 1920, height: 1080 });
  });

  test("a WebP of each kind", () => {
    const lossy = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(640), le16(480));
    expect(imageSize(lossy)).toEqual({ width: 640, height: 480 });
    const w = 1000 - 1;
    const h = 700 - 1;
    const bits = w | (h << 14);
    const lossless = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
    expect(imageSize(lossless)).toEqual({ width: 1000, height: 700 });
    const extended = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], le24(4999), le24(3999));
    expect(imageSize(extended)).toEqual({ width: 5000, height: 4000 });
  });

  test("text, or a JPEG cut before its SOF, has no size", () => {
    expect(imageSize(bytes("just some words, not a picture"))).toBeNull();
    expect(imageSize(bytes([0xff, 0xd8], [0xff, 0xe1], be16(100), new Array(20).fill(0)))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});
