// The text a card's tile shows when the card has no tagline: the first real sentence of its
// description, without the markup, the sheets of traits and the blocks that cards often open with.
// The twin of backend/app/services/card_text.py, which is the reference; the recorded cases
// (backend/tests/cases/card_excerpt.json) hold both.
//
// Descriptions are written by others and some are hostile: every step is one pass over the text,
// and a search for a closing mark never starts again from each opening one. A "character" is a
// code point, as Python's len counts it, never a UTF-16 unit of `.length`; a space is what
// Python's isspace() takes (PY_WS), never `\s` or trim().
import { PY_WS, codePoints, pyLower, pyRstrip, pyStrip, sliceCodePoints } from "./text";

/** Python's EXCERPT_RULE, raised with it (the browser edition stores it next to the excerpt, N3). */
export const EXCERPT_RULE = 1;

const LENGTH = 160; // two or three lines of a tile
const MIN_LETTERS = 20; // under this, what is left is debris
const SQUARE_BLOCK = 300;
const CURLY_BLOCK = 300;
const MARKER_BLOCK = 80;
const UNREADABLE = 40;
const KEY_LINE = 80;
const KEY_WORD = 24;

const ENTITY = /&(?:(nbsp|amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+));/g;
const NAMED: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Tag names are ASCII, and so is their case: without the u flag, an `i` never folds "ſ" or the
// Kelvin sign into a name, as Python's re.ASCII does not.
const STOP = /[<!\[\]]/g;
const NAME_TAG = /<(user|bot|char)>/iy;
const TAG_NAME = /<\/?([a-z][a-z0-9]*)/iy;
const TABLE_END = /<\/table>/gi;
const BLOCK_TAGS = new Set(["br", "hr", "p", "div", "li", "ul", "ol", "tr", "blockquote", "center", "h1", "h2", "h3", "h4", "h5", "h6"]);
const NAME_TAGS: Record<string, string> = { user: "{{user}}", bot: "{{char}}", char: "{{char}}" };

const SPACE = new RegExp(`[${PY_WS}]`);
const SPACES = new RegExp(`[${PY_WS}]+`);
// On a line whose spaces were already made single ones.
const HEADING = /^#{1,6} /;
const LEADING_MARKS = /^(?:#{1,6} )?(?:> ?)*(?:[-*+] |[0-9]{1,9}[.)] )?/;
const TABLE_RULE = /^[|\-: ]+$/;
// The u flag folds "ſ" into "s" as Python's IGNORECASE does.
const CHAR_ONLY = new RegExp(`^\\{\\{[${PY_WS}]*char[${PY_WS}]*\\}\\}$`, "iu");
const MARKER = new RegExp(`^\\{\\{[${PY_WS}]*(?:char|user)[${PY_WS}]*\\}\\}$`, "iu");
const KEY_SEPARATOR = /[:=]/;

const BRACKET = /[[\]{}]/g;
const TOKEN = /^[A-Za-z0-9+/=_-]+$/;
const DIGIT = /[0-9]/;
const EMPHASIS = /[*_~`]/g;
const LETTER = /[\p{L}\p{M}]/u;
const MARK = /\p{M}/u;

// Scripts written without spaces between words, where a character carries about a word: the
// same ranges as Python's, which knows no Unicode scripts.
const DENSE: readonly (readonly [number, number])[] = [
  [0x3040, 0x30ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x3ffff],
];

/** The first real sentence of a description, at most 160 characters and "…"; "" for no text. */
export function cardExcerpt(description: string, name: string): string {
  let text = description.replace(ENTITY, decoded);
  text = withoutMarkup(text);
  text = withoutBlocks(firstRealLines(text, name).join(" "));
  text = splitWords(text).filter((word) => !unreadable(word)).join(" ");
  text = splitWords(text.replace(EMPHASIS, "")).join(" ");
  if (!enoughLetters(text)) return "";
  return cut(text);
}

/** Python's `str.split()`: the words between runs of spaces, none empty. */
function splitWords(text: string): string[] {
  return text.split(SPACES).filter(Boolean);
}

function decoded(entity: string, named: string | undefined, decimal: string | undefined, hexadecimal: string | undefined): string {
  if (named) return NAMED[named];
  const isDecimal = decimal !== undefined;
  const digits = (isDecimal ? decimal : (hexadecimal as string)).replace(/^0+/, "");
  // Longer is past U+10FFFF anyway, as Python's int refuses more than 4,300 digits.
  if (digits.length > (isDecimal ? 7 : 6)) return entity;
  const value = digits ? parseInt(digits, isDecimal ? 10 : 16) : 0;
  // Half of a pair alone can be written neither in SQLite nor in UTF-8.
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return entity;
  return String.fromCodePoint(value);
}

/** The next position of a mark at or after a position, for positions that only move forward:
 *  each search starts past the last one found, so all of them read the text once. */
function nextOf(text: string, mark: string): (position: number) => number {
  let since = -1;
  let found = -1;
  return (position) => {
    if (since < 0 || position < since || (found >= 0 && position > found)) {
      since = position;
      found = text.indexOf(mark, position);
    }
    return found;
  };
}

/** Comments, tables, tags, Markdown images and the syntax of links, in one pass. A block tag
 *  leaves a line break, so that a sheet written on one line with <br> finds its lines again. */
function withoutMarkup(text: string): string {
  const bracket = nextOf(text, "]");
  const paren = nextOf(text, ")");
  // The ")" that ends an image "![…](…)" starting at `at`, or -1.
  const imageEnd = (at: number): number => {
    const close = bracket(at + 2);
    if (close < 0 || !text.startsWith("(", close + 1)) return -1;
    return paren(close + 2);
  };

  const out: string[] = [];
  let i = 0;
  // The "](address)" of a link whose "[" was dropped, left out when the scan reaches it.
  let tailFrom = -1;
  let tailTo = -1;
  for (;;) {
    if (tailFrom >= 0 && tailFrom < i) tailFrom = -1;
    STOP.lastIndex = i;
    const stop = STOP.exec(text);
    if (!stop) {
      out.push(text.slice(i));
      break;
    }
    const at = stop.index;
    out.push(text.slice(i, at));
    const c = text[at];
    i = at + 1;
    if (c === "]") {
      if (at === tailFrom) {
        i = tailTo + 1;
        tailFrom = -1;
      } else out.push(c);
    } else if (c === "!") {
      const end = text.startsWith("![", at) ? imageEnd(at) : -1;
      if (end >= 0) {
        out.push(" ");
        i = end + 1;
      } else out.push(c);
    } else if (c === "[") {
      const end = text.startsWith("![", at + 1) ? imageEnd(at + 1) : -1;
      const outer = end >= 0 && text.startsWith("](", end + 1) ? paren(end + 3) : -1;
      if (outer >= 0) {
        // An image inside a link is an image.
        out.push(" ");
        i = outer + 1;
        continue;
      }
      const close = bracket(at + 1);
      const tail = close >= 0 && text.startsWith("(", close + 1) ? paren(close + 2) : -1;
      if (tail >= 0) {
        tailFrom = close;
        tailTo = tail;
      } else out.push(c);
    } else i = afterAngle(text, at, out);
  }
  return out.join("");
}

/** What a "<" opens, written to `out`; the position after it. */
function afterAngle(text: string, at: number, out: string[]): number {
  const length = text.length;
  NAME_TAG.lastIndex = at;
  const named = NAME_TAG.exec(text);
  if (named) {
    out.push(NAME_TAGS[named[1].toLowerCase()]);
    return at + named[0].length;
  }
  if (text.startsWith("<!--", at)) {
    const end = text.indexOf("-->", at + 4);
    out.push(" ");
    return end < 0 ? length : end + 3;
  }
  const after = text.slice(at + 1, at + 2);
  if (!(after === "/" || after === "!" || /^[A-Za-z]$/.test(after))) {
    out.push("<");
    return at + 1;
  }
  TAG_NAME.lastIndex = at;
  const tag = TAG_NAME.exec(text);
  const name = tag ? tag[1].toLowerCase() : "";
  const nameEnd = tag ? at + tag[0].length : at + 1;
  const whole = nameEnd >= length || SPACE.test(text[nameEnd]) || text[nameEnd] === "/" || text[nameEnd] === ">";
  if (whole && name === "table" && after !== "/") {
    // In a card, a table is a sheet of traits, never the first sentence.
    TABLE_END.lastIndex = at;
    const end = TABLE_END.exec(text);
    out.push("\n");
    return end ? end.index + end[0].length : length;
  }
  const end = text.indexOf(">", at + 1);
  out.push(whole && BLOCK_TAGS.has(name) ? "\n" : " ");
  return end < 0 ? length : end + 1;
}

/** Whether a line is a Markdown heading, and its text without its leading marks. */
function readLine(raw: string): [boolean, string] {
  const line = splitWords(raw).join(" ");
  const heading = HEADING.test(line);
  return [heading, pyStrip(line.slice((LEADING_MARKS.exec(line) as RegExpExecArray)[0].length))];
}

/** The depth of [ ] and { } a line adds. */
function depthOf(line: string): number {
  let depth = 0;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

function firstRealLines(text: string, name: string): string[] {
  // Split on "\n" alone, as Python's split("\n"): U+2028, U+0085 and the like are spaces here.
  const raws = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("﻿", "").split("\n");
  const ownName = pyLower(splitWords(name).join(" "));
  // The depth of [ ] and { } at the end of each line, and the lowest it falls from each line on:
  // a block opened on a line is closed on the first later line back at its starting depth.
  const ends: number[] = [];
  let depth = 0;
  for (const raw of raws) ends.push((depth += depthOf(raw)));
  const lowest: number[] = new Array<number>(raws.length + 1);
  lowest[raws.length] = Infinity;
  for (let k = raws.length - 1; k >= 0; k--) lowest[k] = Math.min(ends[k], lowest[k + 1]);
  let a = 0;
  while (a < raws.length) {
    const start = a ? ends[a - 1] : 0;
    if (ends[a] > start && lowest[a + 1] <= start) {
      let b = a + 1;
      while (ends[b] > start) b++;
      a = b + 1;
      continue;
    }
    // A block never closed is no block: its first line is judged like any other.
    if (pyStrip(raws[a])) {
      const [heading, line] = readLine(raws[a]);
      if (!skipped(line, heading, ownName)) break;
    }
    a++;
  }
  return raws.slice(a).map((raw) => readLine(raw)[1]);
}

function skipped(line: string, heading: boolean, ownName: string): boolean {
  if (!line || heading) return true;
  const first = line[0];
  const last = line[line.length - 1];
  if ((first === "|" && last === "|") || TABLE_RULE.test(line)) return true;
  if (pyLower(line) === ownName || CHAR_ONLY.test(line)) return true;
  if ("[{(".includes(first) && ")]}".includes(last)) return true;
  if (isAttribute(line) || isKeyValue(line)) return true;
  let letters = 0;
  let points = 0;
  for (const c of line) {
    points++;
    if (LETTER.test(c)) letters++;
  }
  return 2 * letters < points;
}

/** A line of W++: one to three words, "(", a text holding a quote, ")", and maybe , ] or }. */
function isAttribute(line: string): boolean {
  const opening = line.indexOf("(");
  if (opening <= 0) return false;
  const words = splitWords(line.slice(0, opening)).length;
  if (words < 1 || words > 3) return false;
  const body = ",]}".includes(line[line.length - 1]) ? line.slice(0, -1) : line;
  return body.endsWith(")") && body.length - 1 > opening && body.slice(opening + 1, -1).includes('"');
}

/** `Nom : Sélène`, `Âge = 312`, or a label alone, `Description:`: one to three short words, then
 *  ":" or "=". */
function isKeyValue(line: string): boolean {
  if (codePoints(line) >= KEY_LINE) return false;
  const separator = KEY_SEPARATOR.exec(line);
  if (!separator) return false;
  const words = splitWords(line.slice(0, separator.index));
  return words.length >= 1 && words.length <= 3 && words.every((word) => codePoints(word) <= KEY_WORD);
}

/** Whether text[from..to] holds at most `limit` code points, read only when the units leave it open. */
function spansAtMost(text: string, from: number, to: number, limit: number): boolean {
  const units = to - from + 1;
  if (units <= limit) return true;
  if (units > 2 * limit) return false;
  return codePoints(text.slice(from, to + 1)) <= limit;
}

/** Short blocks between brackets or braces left in the text, each bracket paired in one pass.
 *  {{char}} and {{user}} stay: the page names them, in the reader's language. */
function withoutBlocks(text: string): string {
  const square = new Map<number, number>();
  const curly = new Map<number, number>();
  const openSquare: number[] = [];
  const openCurly: number[] = [];
  for (const found of text.matchAll(BRACKET)) {
    const c = found[0];
    const at = found.index;
    if (c === "[") openSquare.push(at);
    else if (c === "{") openCurly.push(at);
    else if (c === "]" && openSquare.length) square.set(openSquare.pop() as number, at);
    else if (c === "}" && openCurly.length) curly.set(openCurly.pop() as number, at);
  }
  const out: string[] = [];
  let keptFrom = 0;
  let skipTo = 0;
  for (const found of text.matchAll(BRACKET)) {
    const at = found.index;
    if (at < skipTo) continue;
    const c = found[0];
    const close = c === "[" ? square.get(at) : c === "{" ? curly.get(at) : undefined;
    if (close === undefined) continue;
    let removed: boolean;
    if (c === "[") removed = spansAtMost(text, at, close, SQUARE_BLOCK);
    else if (text.startsWith("{{", at) && curly.get(at + 1) === close - 1) {
      if (MARKER.test(text.slice(at, close + 1))) {
        skipTo = close + 1;
        continue;
      }
      removed = spansAtMost(text, at, close, MARKER_BLOCK);
      if (!removed) {
        // Too long to be a marker: text, whose inner braces are judged on their own.
        skipTo = at + 2;
        continue;
      }
    } else removed = spansAtMost(text, at, close, CURLY_BLOCK);
    if (removed) {
      out.push(text.slice(keptFrom, at), " ");
      keptFrom = skipTo = close + 1;
    }
  }
  out.push(text.slice(keptFrom));
  return out.join("");
}

/** An address, or base64 or hexadecimal, of 40 characters or more: nothing a tile can show.
 *  Words joined by punctuation stay, and so does a token with no digit, rare enough. */
function unreadable(word: string): boolean {
  if (codePoints(word) < UNREADABLE) return false;
  if (word.includes("://") || word.startsWith("www.") || word.startsWith("data:")) return true;
  return TOKEN.test(word) && DIGIT.test(word);
}

function enoughLetters(text: string): boolean {
  let weight = 0;
  for (const c of text) {
    if (!LETTER.test(c)) continue;
    const point = c.codePointAt(0) as number;
    weight += DENSE.some(([low, high]) => point >= low && point <= high) ? 2 : 1;
    if (weight >= MIN_LETTERS) return true;
  }
  return false;
}

/** Whether a code point belongs to the one before it: cutting before it splits a character. */
function binds(c: string): boolean {
  const point = c.codePointAt(0) as number;
  return (
    MARK.test(c) ||
    point === 0x200d ||
    point === 0xfe0e ||
    point === 0xfe0f ||
    (point >= 0x1f3fb && point <= 0x1f3ff) ||
    (point >= 0xe0020 && point <= 0xe007f)
  );
}

function cut(text: string): string {
  // The first 161 code points: the 160 kept at most, and the one after them.
  const head = Array.from(sliceCodePoints(text, LENGTH + 1));
  if (head.length <= LENGTH) return text;
  let end = LENGTH;
  if (head[end] !== " ") {
    const space = head.lastIndexOf(" ", end - 1);
    if (space > 0) end = space;
  }
  // Never between a character and what composes it, without Intl.Segmenter, whose cuts follow the
  // browser's version of ICU.
  while (end > 0 && (binds(head[end]) || head[end - 1] === "‍")) end--;
  let flags = 0;
  while (flags < end && isRegional(head[end - 1 - flags])) flags++;
  if (flags % 2) end--;
  return pyRstrip(head.slice(0, end).join("")) + "…";
}

function isRegional(c: string): boolean {
  const point = c.codePointAt(0) as number;
  return point >= 0x1f1e6 && point <= 0x1f1ff;
}
