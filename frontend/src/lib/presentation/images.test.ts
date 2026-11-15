import { expect, test } from "vitest";
import { imageSize, imageSource } from "./images";
import { layoutLength } from "./renderPresentation";

// Headers written byte by byte, after the published formats.
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const base64 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString("base64");

function png(width: number, height: number): number[] {
  return [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), ...ascii("IHDR"), ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, 0, 0, 0, 0,
  ];
}

function jpeg(width: number, height: number, marker = 0xc0, before: number[] = []): number[] {
  return [0xff, 0xd8, ...before, 0xff, marker, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
}

function gifImage(left: number, top: number, width: number, height: number): number[] {
  return [0x2c, ...u16le(left), ...u16le(top), ...u16le(width), ...u16le(height), 0, 2, 2, 0x44, 0x01, 0];
}

function gif(width: number, height: number, ...rest: number[][]): number[] {
  return [...ascii("GIF89a"), ...u16le(width), ...u16le(height), 0, 0, 0, ...rest.flat()];
}

const control = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];

function webp(chunk: "VP8X" | "VP8L" | "VP8 ", width: number, height: number): number[] {
  const head = [...ascii("RIFF"), ...u32be(0), ...ascii("WEBP"), ...ascii(chunk), ...u32be(10)];
  if (chunk === "VP8X") return [...head, 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)];
  if (chunk === "VP8L") {
    const w = width - 1;
    const h = height - 1;
    return [...head, 0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f];
  }
  return [...head, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)];
}

const dataUrl = (type: string, bytes: number[]) => `data:image/${type};base64,${base64(bytes)}`;

function timed<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

test("an image written into the card shows at once, one from a site waits for a tap, anything else is refused", () => {
  const one = { width: 1, height: 1 };
  expect(imageSource(dataUrl("png", png(1, 1)))).toMatchObject({ kind: "inline", ...one });
  expect(imageSource(dataUrl("jpeg", jpeg(1, 1)))).toMatchObject({ kind: "inline", ...one });
  expect(imageSource(dataUrl("gif", gif(1, 1, gifImage(0, 0, 1, 1), [0x3b])))).toMatchObject({
    kind: "inline",
    ...one,
  });
  expect(imageSource(dataUrl("webp", webp("VP8X", 1, 1)))).toMatchObject({ kind: "inline", ...one });
  expect(imageSource(dataUrl("jpg", jpeg(1, 1)))).toMatchObject({ kind: "inline", ...one });

  // A payload cut into lines, which the browsers' decoding accepts.
  const lines = dataUrl("png", png(1, 1)).replace(/(.{10})/g, "$1\n");
  expect(imageSource(lines)).toMatchObject({ kind: "inline", ...one });

  for (const src of [
    "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"),
    "http://pictures.example/a.png",
    "pics/a.png",
    "/api/media/x.png",
    "javascript:alert(1)",
    null,
    dataUrl("png", png(1, 1).slice(0, 12)),
    "data:image/png;base64,iVBORw0KG",
    "data:image/png;base64,iVBO=RW0",
  ])
    expect(imageSource(src)).toEqual({ kind: "refused" });

  expect(imageSource("https://pictures.example/a.png")).toEqual({
    kind: "remote",
    src: "https://pictures.example/a.png",
    host: "pictures.example",
  });
  expect(imageSource("  https://pictures.example/a.png \n")).toEqual({
    kind: "remote",
    src: "https://pictures.example/a.png",
    host: "pictures.example",
  });
  expect(imageSource(" https://x.test/a b.png ")).toEqual({
    kind: "remote",
    src: "https://x.test/a b.png",
    host: "x.test",
  });
});

test("a progressive jpeg says so", () => {
  expect(imageSize("jpeg", base64(jpeg(800, 600, 0xc2)))).toEqual({
    width: 800,
    height: 600,
    progressive: true,
  });
  expect(imageSize("jpeg", base64(jpeg(800, 600, 0xc0)))).toEqual({ width: 800, height: 600 });
});

test("the size of each kind of image is read from its header", () => {
  expect(imageSize("png", base64(png(1920, 1080)))).toEqual({ width: 1920, height: 1080 });
  expect(imageSize("gif", base64(gif(640, 480, [0x3b])))).toEqual({ width: 640, height: 480 });
  for (const chunk of ["VP8X", "VP8L", "VP8 "] as const)
    expect(imageSize("webp", base64(webp(chunk, 800, 600)))).toEqual({ width: 800, height: 600 });
  const app1 = [0xff, 0xe1, ...u16be(60_002), ...new Array(60_000).fill(0x41)];
  expect(imageSize("jpeg", base64(jpeg(800, 600, 0xc2, app1)))).toEqual({
    width: 800,
    height: 600,
    progressive: true,
  });
});

test("an image whose pixels would not fit in a phone's memory is not shown", () => {
  expect(imageSource(dataUrl("png", png(20_000, 20_000)))).toEqual({
    kind: "tooLarge",
    width: 20_000,
    height: 20_000,
  });
  expect(imageSource(dataUrl("png", png(4_096, 4_096)))).toMatchObject({ kind: "inline" });
  expect(imageSource(dataUrl("png", png(4_097, 4_096)))).toMatchObject({ kind: "tooLarge" });
});

test("a jpeg that hides its frame behind a stuffed zero is not shown", () => {
  // FF 00 is no marker: a decoder drops it and looks for the next one, FF FE, a comment whose
  // content is a frame of 1 × 1. A walk that read 00 06 as a length would land on that frame.
  const hidden = [0xff, 0x00, 0x00, 0x06, 0xff, 0xfe, 0x00, 0x15, ...jpeg(1, 1).slice(2, -2)];
  expect(hidden).toHaveLength(27);
  expect(imageSource(dataUrl("jpeg", jpeg(5_000, 5_000, 0xc0, hidden)))).toEqual({ kind: "refused" });
  // A reserved marker the walk cannot follow either.
  expect(imageSource(dataUrl("jpeg", jpeg(1, 1, 0xc0, [0xff, 0x02, 0x00, 0x04, 0, 0])))).toEqual({ kind: "refused" });
  expect(imageSource(dataUrl("jpeg", jpeg(5_000, 5_000)))).toMatchObject({ kind: "tooLarge" });
});

test("a jpeg header of the smallest segments is walked in time", () => {
  const segments = new Uint8Array(7 * 1024 * 1024);
  segments[0] = 0xff;
  segments[1] = 0xd8;
  for (let i = 2; i + 4 <= segments.length; i += 4) {
    segments[i] = 0xff;
    segments[i + 1] = 0xe1;
    segments[i + 2] = 0;
    segments[i + 3] = 2;
  }
  const [small, smallTime] = timed(() => imageSource("data:image/jpeg;base64," + base64(segments)));
  expect(small).toEqual({ kind: "refused" });
  expect(smallTime).toBeLessThan(250);

  const large = new Uint8Array(7 * 1024 * 1024);
  large[0] = 0xff;
  large[1] = 0xd8;
  for (let i = 2; i + 4 <= large.length; i += 65_537) {
    large[i] = 0xff;
    large[i + 1] = 0xe1;
    large[i + 2] = 0xff;
    large[i + 3] = 0xff;
  }
  const [big, bigTime] = timed(() => imageSource("data:image/jpeg;base64," + base64(large)));
  expect(big).toEqual({ kind: "refused" });
  expect(bigTime).toBeLessThan(250);
});

test("a gif is as large as its largest frame", () => {
  expect(
    imageSource(dataUrl("gif", gif(1, 1, gifImage(0, 0, 1, 1), control, gifImage(0, 0, 20_000, 20_000), [0x3b]))),
  ).toEqual({ kind: "tooLarge", width: 20_000, height: 20_000 });
  expect(imageSource(dataUrl("gif", gif(1, 1, gifImage(10, 10, 1, 1), [0x3b])))).toMatchObject({
    kind: "inline",
    width: 11,
    height: 11,
  });
  // Cut after its first image: the size read so far.
  expect(imageSource(dataUrl("gif", gif(1, 1, gifImage(0, 0, 5, 5))))).toMatchObject({
    kind: "inline",
    width: 5,
    height: 5,
  });

  const head = gif(1, 1);
  const bytes = new Uint8Array(head.length + 2 + 7 * 1024 * 1024 + 2);
  bytes.set(head);
  bytes[head.length] = 0x21;
  bytes[head.length + 1] = 0xfe;
  for (let i = head.length + 2; i < bytes.length - 2; i += 2) {
    bytes[i] = 1;
    bytes[i + 1] = 0x41;
  }
  bytes[bytes.length - 2] = 0;
  bytes[bytes.length - 1] = 0x3b;
  const [walked, elapsed] = timed(() => imageSize("gif", base64(bytes)));
  expect(walked).toEqual({ width: 1, height: 1 });
  expect(elapsed).toBeLessThan(250);
});

test("an image source is read the same on every call", () => {
  const src = dataUrl("png", png(30, 20));
  const first = imageSource(src);
  expect(first).toEqual({ kind: "inline", src, width: 30, height: 20 });
  layoutLength("text " + src + " more");
  expect(imageSource(src)).toEqual(first);
  layoutLength(src);
  expect(imageSource(src)).toEqual(first);
});
