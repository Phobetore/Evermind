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
