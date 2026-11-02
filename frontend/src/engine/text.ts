/** What Python's `str.isspace()` calls whitespace, as the inside of a RegExp
 *  class (no brackets), every member written as an escape so that it can be
 *  read and audited. JavaScript's `\s` and `trim()` disagree with it on both
 *  sides: they take U+FEFF and leave out U+001C to U+001F and U+0085. */
export const PY_WS = String.raw`\t\n\v\f\r\x1c-\x1f\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

const SPACE = new RegExp(`[${PY_WS}]`);

// Walking in from the ends rather than matching /[ws]+$/, which is quadratic
// on a long run of spaces that is not at the end.
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

/** Python's `len(s)`: a character outside the basic plane, an emoji for one,
 *  counts once where `.length` counts its two UTF-16 units. */
export function codePoints(s: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}

/** Python's `s[:end]` for an `end` of zero or more: the first `end` code
 *  points, never cutting an emoji in half. */
export function sliceCodePoints(s: string, end: number): string {
  let i = 0;
  for (let n = 0; n < end && i < s.length; n++) {
    i += isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1;
  }
  return s.slice(0, i);
}
