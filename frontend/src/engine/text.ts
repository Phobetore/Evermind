// Text as Python reads it, where the recorded cases fix how: what counts as a space
// at the ends of a string, how long a string is, and what can be written out.

/** What Python's `str.isspace()` calls whitespace, as the inside of a RegExp class
 *  (no brackets), every member written as an escape so that it can be audited.
 *  JavaScript's `\s` and `trim()` disagree with it on both sides: they take U+FEFF
 *  and leave out U+001C to U+001F and U+0085. */
export const PY_WS = String.raw`\t\n\v\f\r\x1c-\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

const SPACE = new RegExp(`[${PY_WS}]`);

// Walking in from the ends rather than matching /[ws]+$/, which is quadratic on a
// long run of spaces that is not at the end.
export function pyLstrip(s: string): string {
  let start = 0;
  while (start < s.length && SPACE.test(s[start])) start++;
  return s.slice(start);
}

export function pyRstrip(s: string): string {
  let end = s.length;
  while (end > 0 && SPACE.test(s[end - 1])) end--;
  return s.slice(0, end);
}

export function pyStrip(s: string): string {
  return pyRstrip(pyLstrip(s));
}

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether the text can be written out, as `is_writable` says in Python. A lone
 *  surrogate cannot: an escape of one in a model's answer gives it, and it fails
 *  wherever it is encoded. A high surrogate followed by a low one is a character. */
export function isWritable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (isHigh(unit) && isLow(s.charCodeAt(i + 1))) i++;
    else if (isHigh(unit) || isLow(unit)) return false;
  }
  return true;
}

/** What a value says once stripped, "" when it is not a string or cannot be written. */
export const textOf = (value: unknown): string =>
  typeof value === "string" && isWritable(value) ? pyStrip(value) : "";

/** Python's `len(s)`: a character outside the basic plane, an emoji for one, counts
 *  once where `.length` counts its two UTF-16 units. */
export function codePoints(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}

/** Python's `s[:end]` for an `end` of zero or more: the first `end` code points,
 *  never cutting an emoji in half. */
export function sliceCodePoints(s: string, end: number): string {
  let i = 0;
  for (let n = 0; n < end && i < s.length; n++) {
    i += isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
  }
  return s.slice(0, i);
}

// Each script's zero among the digits Python's `\d` takes (Unicode 15.1, Python 3.13's), each
// followed by its nine others: JavaScript's \p{Nd} follows a newer Unicode, and takes more.
// Python 3.12 takes the same digits. Python 3.11, which a server may still run on, has Unicode 14
// and does not count Kawi's (U+11F50) or Nag Mundari's (U+1E4F0): there, a roll written in those
// digits stays as written while this engine rolls it. The tests and the releases run on 3.13.
const DIGIT_ZEROS = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0,
  0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
  0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0, 0x11136, 0x111d0,
  0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x11f50,
  0x16a60, 0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950,
  0x1fbf0,
];

const hex = (point: number) => `\\u{${point.toString(16)}}`;

/** What Python's `\d` matches in a pattern on text, as the inside of a RegExp class (no
 *  brackets) for a pattern with the `u` flag. */
export const PY_DIGIT = DIGIT_ZEROS.map((zero) => `${hex(zero)}-${hex(zero + 9)}`).join("");

// These lists follow Python 3.13 (Unicode 15.1), the version the tests, the Docker image and the
// releases run; a server on another Python lowers what its own Unicode adds or keeps differently.
// Every code point Unicode 16 assigned, which Python 3.13 does not know: it leaves each as it is,
// and reads it as neither a cased letter nor one a case passes over, so a final sigma next to it is
// final. A runtime on Unicode 16 (Node 22, recent browsers) knows them: it maps the new letters
// (Latin and Cyrillic additions, Garay) and passes over the new marks (U+0897). Measured by listing
// the code points Node 22.16 assigns and Python 3.13 does not: 5,185, in these 47 runs.
const UNICODE_16: readonly (readonly [number, number])[] = [
  [0x897, 0x897], [0x1b4e, 0x1b4f], [0x1b7f, 0x1b7f], [0x1c89, 0x1c8a], [0x2427, 0x2429], [0x31e4, 0x31e5],
  [0xa7cb, 0xa7cd], [0xa7da, 0xa7dc], [0x105c0, 0x105f3], [0x10d40, 0x10d65], [0x10d69, 0x10d85],
  [0x10d8e, 0x10d8f], [0x10ec2, 0x10ec4], [0x10efc, 0x10efc], [0x11380, 0x11389], [0x1138b, 0x1138b],
  [0x1138e, 0x1138e], [0x11390, 0x113b5], [0x113b7, 0x113c0], [0x113c2, 0x113c2], [0x113c5, 0x113c5],
  [0x113c7, 0x113ca], [0x113cc, 0x113d5], [0x113d7, 0x113d8], [0x113e1, 0x113e2], [0x116d0, 0x116e3],
  [0x11bc0, 0x11be1], [0x11bf0, 0x11bf9], [0x11f5a, 0x11f5a], [0x13460, 0x143fa], [0x16100, 0x16139],
  [0x16d40, 0x16d79], [0x18cff, 0x18cff], [0x1cc00, 0x1ccf9], [0x1cd00, 0x1ceb3], [0x1e5d0, 0x1e5fa],
  [0x1e5ff, 0x1e5ff], [0x1f8b2, 0x1f8bb], [0x1f8c0, 0x1f8c1], [0x1fa89, 0x1fa89], [0x1fa8f, 0x1fa8f],
  [0x1fabe, 0x1fabe], [0x1fac6, 0x1fac6], [0x1fadc, 0x1fadc], [0x1fadf, 0x1fadf], [0x1fae9, 0x1fae9],
  [0x1fbcb, 0x1fbef],
];
const UNICODE_16_CLASS = UNICODE_16.map(([from, to]) => (from === to ? hex(from) : `${hex(from)}-${hex(to)}`)).join("");
const NEW_LOWERED = new RegExp(`([${UNICODE_16_CLASS}]+)`, "u");
// Two older letters whose capital came with Unicode 16 (ƛ to U+A7DC, ɤ to U+A7CB): Python 3.13
// has no capital for them and keeps them small.
const NEW_UPPERED = new RegExp(`([ƛɤ${UNICODE_16_CLASS}]+)`, "u");

/** `mapped` over the text, the code points `kept` left as they are; split on them, so that the
 *  final sigma reads its neighbours within each piece, as Python reads code points it does not know. */
function keeping(s: string, kept: RegExp, mapped: (piece: string) => string): string {
  if (!kept.test(s)) return mapped(s);
  return s.split(kept).map((piece, i) => (i % 2 === 1 ? piece : mapped(piece))).join("");
}

/** Python's `str.lower()`. */
export const pyLower = (s: string): string => keeping(s, NEW_LOWERED, (piece) => piece.toLowerCase());

/** Python's `str.upper()`. */
export const pyUpper = (s: string): string => keeping(s, NEW_UPPERED, (piece) => piece.toUpperCase());

/** Python's `int()` of a run of `\d` digits, whatever their script: "١٢" is 12 there too. */
export function pyInt(digits: string): number {
  let value = 0;
  for (const digit of digits) {
    const point = digit.codePointAt(0) as number;
    const zero = DIGIT_ZEROS.find((start) => point >= start && point <= start + 9) as number;
    value = value * 10 + (point - zero);
  }
  return value;
}

/** Python's `min(values, default=fallback)`: the first of the smallest, by `<`. Not
 *  Math.min, which prefers -0 to 0 and NaN to any number, where `<` keeps the first. */
export function pyMin(values: readonly number[], fallback: number): number {
  if (!values.length) return fallback;
  let smallest = values[0];
  for (const value of values) if (value < smallest) smallest = value;
  return smallest;
}

const THINK = "<think>";
const THOUGHT_END = "</think>";

/** What a model says after the thinking some write first between <think> tags:
 *  nothing until that is closed, nor while the opening tag is still arriving. Both the
 *  reply and the JSON reader need it, so it lives here rather than with either. */
export function stripThought(text: string): string {
  const head = pyLstrip(text);
  if (head.startsWith(THINK)) {
    const end = head.indexOf(THOUGHT_END);
    return end === -1 ? "" : pyLstrip(head.slice(end + THOUGHT_END.length));
  }
  return head && THINK.startsWith(head) ? "" : text;
}
